'use strict';

/**
 * service-status.js
 *
 * Polls Claude's public status page so the widget can say whether the service
 * itself is healthy — not just how much of our quota is left. A red Session
 * meter and a Claude Code outage look identical from the usage numbers alone.
 *
 * Unlike the claude.ai usage endpoints, this is an Atlassian Statuspage and it
 * serves plain JSON to an ordinary Node request — no Cloudflare challenge — so
 * none of the hidden-BrowserWindow machinery in fetch-via-window.js is needed
 * here. status.anthropic.com 301s to status.claude.com; we ask for the latter
 * directly and still follow redirects in case that flips again.
 *
 * Runs in the main process: the renderer's CSP sets `connect-src 'none'`, so it
 * could not make this request even if we wanted it to. The renderer reads the
 * cached snapshot through the `get-service-status` IPC channel.
 */

const https = require('https');

const SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';
/** Where the click-through goes — Statuspage's own dashboard. */
const PAGE_URL = 'https://status.claude.com';

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
 * The components we watch, in display order.
 *
 * Matched on lowercased name rather than Statuspage's component ids: the ids
 * are stable but opaque, and a rename is far easier to spot and fix here than
 * an id that silently stops resolving. A component we cannot find is reported
 * as unknown, never quietly dropped.
 */
const WATCHED = [
  { id: 'code', label: 'Claude Code', short: 'Code', match: (n) => n === 'claude code' },
  { id: 'web', label: 'claude.ai', short: 'claude.ai', match: (n) => n.startsWith('claude.ai') },
  { id: 'api', label: 'Claude API', short: 'API', match: (n) => n.startsWith('claude api') },
];

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

let timer = null;
let stopped = false;
let failures = 0;
let sample = null;   // last successful parse: { at, components, incidents }
let lastError = null;

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

function parseSummary(json) {
  const raw = Array.isArray(json && json.components) ? json.components : [];
  // Statuspage nests sub-components under groups; only leaves carry a real
  // status, and the three we watch are all top level.
  const leaves = raw.filter((c) => c && !c.group);

  const components = WATCHED.map((spec) => {
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

function schedule(delay) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(poll, delay);
  // Never let this timer be the reason the process stays alive.
  if (timer.unref) timer.unref();
}

async function poll() {
  if (stopped) return;
  try {
    const json = await getJson(SUMMARY_URL);
    sample = parseSummary(json);
    lastError = null;
    failures = 0;
    schedule(POLL_MS);
  } catch (err) {
    failures += 1;
    lastError = err.message;
    // Keep the previous sample; getStatus() ages it out once it crosses
    // STALE_MS, so a brief network blip does not blank the indicator.
    schedule(Math.min(POLL_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin background polling. Safe to call more than once. */
function start() {
  stopped = false;
  if (!timer) poll();
}

/** Stop polling so the app can exit cleanly. */
function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function unknownSnapshot(error, staleSample) {
  return {
    ok: false,
    stale: !!staleSample,
    fetchedAt: staleSample ? staleSample.at : null,
    error,
    overall: 'unknown',
    overallText: 'Status unavailable',
    level: 'unknown',
    worst: null,
    components: WATCHED.map((spec) => ({
      id: spec.id,
      label: spec.label,
      short: spec.short,
      status: 'unknown',
      statusText: STATUS_TEXT.unknown,
      level: 'unknown',
    })),
    incidents: [],
    pageUrl: PAGE_URL,
  };
}

/**
 * Current service status. Cheap — served entirely from the cached sample, so
 * the renderer can poll it as often as it likes.
 */
function getStatus() {
  if (!sample) {
    return unknownSnapshot(lastError || 'waiting for first fetch', null);
  }
  if (Date.now() - sample.at > STALE_MS) {
    return unknownSnapshot(lastError || 'status is stale', sample);
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
    pageUrl: PAGE_URL,
  };
}

module.exports = { start, stop, getStatus };
