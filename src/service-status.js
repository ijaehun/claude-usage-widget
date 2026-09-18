'use strict';

/**
 * service-status.js
 *
 * Polls Claude's public status page so the widget can say whether the service
 * itself is healthy — not just how much of our quota is left. A red Session
 * meter and a Claude Code outage look identical from the usage numbers alone.
 * Codex gets the same treatment from OpenAI's status page, beside its limits.
 *
 * Unlike the claude.ai usage endpoints, this is an Atlassian Statuspage and it
 * serves plain JSON to an ordinary Node request — no Cloudflare challenge — so
 * none of the hidden-BrowserWindow machinery in fetch-via-window.js is needed
 * here. status.anthropic.com 301s to status.claude.com; we ask for the latter
 * directly and still follow redirects in case that flips again.
 *
 * status.openai.com is incident.io, not Statuspage, but it serves the same
 * /api/v2/summary.json shape for compatibility (checked 2026-09-18), so one
 * parser reads both. Two differences: it sends no `incidents` array at all, so
 * Codex's headline always comes from component state; and its components are
 * flat with the group dropped — "CLI" and "VS Code extension" are in the Codex
 * group only on the rendered page. The names are unique across the page today.
 *
 * Runs in the main process: the renderer's CSP sets `connect-src 'none'`, so it
 * could not make this request even if we wanted it to. The renderer reads the
 * cached snapshots through the `get-service-status` and
 * `get-codex-service-status` IPC channels.
 */

const https = require('https');

// The status dashboard refreshes at about this rate. There is nothing to gain
// from going faster; an incident's lifetime is measured in minutes.
const POLL_MS = 60 * 1000;
// A snapshot older than this is reported as unknown rather than shown as a
// stale green. Same rule system-stats.js applies to a wedged nvidia-smi: no
// reading beats a confident wrong one.
const STALE_MS = 10 * 60 * 1000;
// Consecutive failures back the poll off up to this ceiling, so an offline
// machine does not retry every minute for hours.
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_REDIRECTS = 3;

/**
 * The components we watch on each page, in display order.
 *
 * Matched on lowercased name rather than Statuspage's component ids: the ids
 * are stable but opaque, and a rename is far easier to spot and fix here than
 * an id that silently stops resolving. A component we cannot find is reported
 * as unknown, never quietly dropped.
 */
const CLAUDE_WATCHED = [
  { id: 'code', label: 'Claude Code', short: 'Code', match: (n) => n === 'claude code' },
  { id: 'web', label: 'claude.ai', short: 'claude.ai', match: (n) => n.startsWith('claude.ai') },
  { id: 'api', label: 'Claude API', short: 'API', match: (n) => n.startsWith('claude api') },
];

// The page's own "Codex" group. Exact names: "CLI" alone would be ambiguous on
// a page this size if OpenAI ever lists a second one.
const CODEX_WATCHED = [
  { id: 'cli', label: 'Codex CLI', short: 'CLI', match: (n) => n === 'cli' },
  { id: 'vscode', label: 'VS Code extension', short: 'VS Code', match: (n) => n === 'vs code extension' },
  { id: 'web', label: 'Codex Web', short: 'Web', match: (n) => n === 'codex web' },
  { id: 'api', label: 'Codex API', short: 'API', match: (n) => n === 'codex api' },
];

function makeSource(summaryUrl, pageUrl, watched) {
  return {
    summaryUrl, pageUrl, watched,
    timer: null,
    stopped: false,
    failures: 0,
    sample: null,   // last successful parse: { at, components, incidents }
    lastError: null,
  };
}

const claude = makeSource('https://status.claude.com/api/v2/summary.json', 'https://status.claude.com', CLAUDE_WATCHED);
const codex = makeSource('https://status.openai.com/api/v2/summary.json', 'https://status.openai.com', CODEX_WATCHED);
const SOURCES = [claude, codex];

// Statuspage's component states, ordered worst-last. `unknown` is ours, for a
// component missing from the response; it outranks maintenance (planned and
// benign) but must not outrank a real degradation.
const SEVERITY = {
  operational: 0,
  under_maintenance: 1,
  unknown: 2,
  degraded_performance: 3,
  partial_outage: 4,
  major_outage: 5,
};

const STATUS_TEXT = {
  operational: 'Operational',
  under_maintenance: 'Maintenance',
  unknown: 'Unknown',
  degraded_performance: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
};

// Collapsed to what the UI actually needs in order to colour a dot.
const LEVEL = {
  operational: 'ok',
  under_maintenance: 'warn',
  unknown: 'unknown',
  degraded_performance: 'warn',
  partial_outage: 'down',
  major_outage: 'down',
};

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function getJson(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // Statuspage accepts anything, but an identifiable agent is the polite
        // thing to send to someone else's endpoint.
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/json',
      },
    }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // drain, or the socket is never released
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return getJson(new URL(headers.location, url).toString(), redirectsLeft - 1)
          .then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + statusCode));
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('bad JSON: ' + err.message));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function parseSummary(json, watched) {
  const raw = Array.isArray(json && json.components) ? json.components : [];
  // Statuspage nests sub-components under groups; only leaves carry a real
  // status, and the ones we watch are all top level.
  const leaves = raw.filter((c) => c && !c.group);

  const components = watched.map((spec) => {
    const hit = leaves.find((c) => spec.match(String(c.name || '').toLowerCase()));
    const status = hit && SEVERITY[hit.status] !== undefined ? hit.status : 'unknown';
    return {
      id: spec.id,
      label: spec.label,
      short: spec.short,
      name: hit ? hit.name : null,
      status,
      statusText: STATUS_TEXT[status],
      level: LEVEL[status],
    };
  });

  // Unresolved incidents, narrowed to the ones touching a component we watch.
  // An incident whose component list we cannot read is kept rather than guessed
  // away: incidents only supply headline text, never the dot colour, so a false
  // positive here costs one line of description and nothing else.
  const watchedNames = new Set(components.map((c) => c.name).filter(Boolean));
  const incidents = (Array.isArray(json && json.incidents) ? json.incidents : [])
    .filter((inc) => inc && inc.status !== 'resolved' && inc.status !== 'postmortem')
    .map((inc) => {
      const affected = (Array.isArray(inc.components) ? inc.components : [])
        .map((c) => c && c.name)
        .filter(Boolean);
      return {
        name: String(inc.name || 'Incident'),
        status: String(inc.status || ''),
        impact: String(inc.impact || ''),
        affected,
      };
    })
    .filter((inc) => inc.affected.length === 0 || inc.affected.some((n) => watchedNames.has(n)));

  return { at: Date.now(), components, incidents };
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

function schedule(src, delay) {
  if (src.stopped) return;
  if (src.timer) clearTimeout(src.timer);
  src.timer = setTimeout(() => poll(src), delay);
  // Never let this timer be the reason the process stays alive.
  if (src.timer.unref) src.timer.unref();
}

async function poll(src) {
  if (src.stopped) return;
  try {
    const json = await getJson(src.summaryUrl);
    src.sample = parseSummary(json, src.watched);
    src.lastError = null;
    src.failures = 0;
    schedule(src, POLL_MS);
  } catch (err) {
    src.failures += 1;
    src.lastError = err.message;
    // Keep the previous sample; getStatus() ages it out once it crosses
    // STALE_MS, so a brief network blip does not blank the indicator.
    schedule(src, Math.min(POLL_MS * Math.pow(2, src.failures - 1), MAX_BACKOFF_MS));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin background polling of both pages. Safe to call more than once. */
function start() {
  for (const src of SOURCES) {
    src.stopped = false;
    if (!src.timer) poll(src);
  }
}

/** Stop polling so the app can exit cleanly. */
function stop() {
  for (const src of SOURCES) {
    src.stopped = true;
    if (src.timer) {
      clearTimeout(src.timer);
      src.timer = null;
    }
  }
}

function unknownSnapshot(src, error, staleSample) {
  return {
    ok: false,
    stale: !!staleSample,
    fetchedAt: staleSample ? staleSample.at : null,
    error,
    overall: 'unknown',
    overallText: 'Status unavailable',
    level: 'unknown',
    worst: null,
    components: src.watched.map((spec) => ({
      id: spec.id,
      label: spec.label,
      short: spec.short,
      status: 'unknown',
      statusText: STATUS_TEXT.unknown,
      level: 'unknown',
    })),
    incidents: [],
    pageUrl: src.pageUrl,
  };
}

/**
 * Current status of one page. Cheap — served entirely from the cached sample,
 * so the renderer can poll it as often as it likes.
 */
function statusOf(src) {
  const { sample, lastError } = src;
  if (!sample) {
    return unknownSnapshot(src, lastError || 'waiting for first fetch', null);
  }
  if (Date.now() - sample.at > STALE_MS) {
    return unknownSnapshot(src, lastError || 'status is stale', sample);
  }

  const worst = sample.components.reduce(
    (a, b) => (SEVERITY[b.status] > SEVERITY[a.status] ? b : a),
    sample.components[0]
  );
  const healthy = worst.status === 'operational';

  return {
    ok: true,
    stale: false,
    fetchedAt: sample.at,
    // Non-null here means the most recent poll failed but the sample it would
    // have replaced is still inside STALE_MS. Surfaced in the tooltip only.
    error: lastError,
    overall: worst.status,
    overallText: healthy ? 'All systems operational' : `${worst.label}: ${worst.statusText}`,
    level: worst.level,
    worst: healthy ? null : worst,
    components: sample.components,
    incidents: sample.incidents,
    pageUrl: src.pageUrl,
  };
}

const getStatus = () => statusOf(claude);
const getCodexStatus = () => statusOf(codex);

module.exports = { start, stop, getStatus, getCodexStatus };
