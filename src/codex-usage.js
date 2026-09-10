'use strict';

/**
 * codex-usage.js
 *
 * OpenAI Codex plan limits — the 5-hour and weekly windows — for the widget's
 * Codex rows, so both coding agents' quotas are visible in one place.
 *
 * Read from Codex's own session logs rather than any network API. Every Codex
 * turn, CLI or desktop app, appends a `token_count` event to that thread's
 * rollout file under ~/.codex/sessions, and the event carries the rate-limit
 * snapshot the server returned with the response:
 *
 *   {"timestamp":"…","type":"event_msg","payload":{"type":"token_count",
 *    "info":{…},"rate_limits":{"limit_id":"codex",
 *    "primary":{"used_percent":26.0,"window_minutes":300,"resets_at":1789036777},
 *    "secondary":{"used_percent":9.0,"window_minutes":10080,"resets_at":…},
 *    "plan_type":"plus",…}}}
 *
 * So nothing here touches Codex's credentials (auth.json), and none of the
 * Cloudflare trouble in fetch-via-window.js applies.
 *
 * The price is freshness: the numbers are as of the last Codex turn on THIS
 * machine. Usage from another computer or the web does not appear until a turn
 * runs here. What can be done honestly is to age each window out at its own
 * resets_at — past that point the old percentage describes a window that no
 * longer exists, so it is reported as reset. There is deliberately no
 * wall-clock staleness rule like service-status.js has: a snapshot from three
 * hours ago is still exactly right if nothing has been used since.
 *
 * The format is Codex's internal log, not a published interface, so it can
 * change under us the way claude.ai's usage endpoint did. Anything that does
 * not parse is reported as unavailable and the rows hide; nothing here throws
 * into the main process.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// A turn writes its event as the response lands, so this is the lag between
// using Codex and the widget moving. A tick with nothing new is a few stats.
const POLL_MS = 15 * 1000;
// Rollouts are filed under the date the thread STARTED (sessions/YYYY/MM/DD),
// and a resumed thread keeps appending to that old file. The frequent poll
// only lists the newest few day directories; a full walk this often finds a
// resumed old thread without statting every rollout ever written each tick.
const FULL_SCAN_MS = 5 * 60 * 1000;
const RECENT_DAY_DIRS = 3;
// The newest few files by mtime are parsed and the latest event among them
// wins. More than one, because a file can be touched without ever getting a
// token_count — a thread opened and abandoned before its first turn.
const CANDIDATES = 3;
// If none of those has an event, keep going down the list this far before
// concluding there is nothing to show.
const MAX_FILES_EXAMINED = 20;
// token_count lines are ~1KB, but a turn's tool output can land after the last
// one. Read the tail first, and the whole file only when that misses.
const TAIL_BYTES = 256 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const DAY_MINUTES = 24 * 60;

let timer = null;
let stopped = false;
let polling = false;
let lastFullScan = 0;
let homeFound = false;
let sample = null;   // { at, file, plan, session, weekly }
let lastError = null;
// What the last full walk ranked newest. The quick poll keeps statting these,
// since a resumed old thread sits outside the recent day directories.
let watchList = [];
// file -> { mtimeMs, size, event }, reused while a file is unchanged.
const parsed = new Map();

// ---------------------------------------------------------------------------
// Finding rollouts
// ---------------------------------------------------------------------------

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function readdirSafe(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isRollout = (name) => name.startsWith('rollout-') && name.endsWith('.jsonl');

async function subdirsNewestFirst(dir) {
  return (await readdirSafe(dir))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

/**
 * Directories that can hold rollouts, newest first. sessions/ is YYYY/MM/DD,
 * whose names sort chronologically as strings; archived_sessions/ keeps its
 * files at the top level, so the root itself is always included. `limit` caps
 * the day directories (0 = all).
 */
async function rolloutDirs(root, limit) {
  const dirs = [root];
  let days = 0;
  for (const y of await subdirsNewestFirst(root)) {
    for (const m of await subdirsNewestFirst(path.join(root, y))) {
      for (const d of await subdirsNewestFirst(path.join(root, y, m))) {
        dirs.push(path.join(root, y, m, d));
        days += 1;
        if (limit && days >= limit) return dirs;
      }
    }
  }
  return dirs;
}

async function statEntry(file) {
  try {
    const st = await fs.promises.stat(file);
    return { file, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // archived or deleted between listing and stat
  }
}

async function listRollouts(dirs) {
  const entries = [];
  for (const dir of dirs) {
    for (const ent of await readdirSafe(dir)) {
      if (!ent.isFile() || !isRollout(ent.name)) continue;
      const entry = await statEntry(path.join(dir, ent.name));
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function readRange(file, start, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * The latest rate-limit event in `text`, scanning from the end. When the text
 * starts mid-file its first line is a fragment and is skipped.
 */
function lastEventIn(text, startsMidLine) {
  const lines = text.split('\n');
  let fallback = null;
  for (let i = lines.length - 1; i >= (startsMidLine ? 1 : 0); i--) {
    const line = lines[i];
    // Cheap reject before JSON.parse: nearly every line is something else.
    if (!line.includes('"rate_limits":{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // includes a line still being written when we read
    }
    const payload = obj && obj.payload;
    const limits = payload && payload.type === 'token_count' ? payload.rate_limits : null;
    if (!limits || typeof limits !== 'object') continue;

    const event = { at: Date.parse(obj.timestamp) || null, limits };
    // `codex` is the plan-wide bucket and the only one seen so far. Should
    // other buckets start appearing, prefer it, but show one of them rather
    // than nothing.
    if (!limits.limit_id || limits.limit_id === 'codex') return event;
    if (!fallback) fallback = event;
  }
  return fallback;
}

async function lastEventInFile(entry) {
  const cached = parsed.get(entry.file);
  if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
    return cached.event;
  }

  let event = null;
  if (entry.size > 0) {
    const start = Math.max(0, entry.size - TAIL_BYTES);
    event = lastEventIn(await readRange(entry.file, start, entry.size - start), start > 0);
    if (!event && start > 0 && entry.size <= MAX_READ_BYTES) {
      event = lastEventIn(await readRange(entry.file, 0, entry.size), false);
    }
  }
  parsed.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, event });
  return event;
}

function toWindow(raw, eventAt) {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) {
    return null;
  }
  let resetsAt = null;
  if (typeof raw.resets_at === 'number') {
    // Seconds today. Accept milliseconds too, rather than landing a countdown
    // in the year 58000 if that ever changes.
    resetsAt = raw.resets_at > 1e12 ? raw.resets_at : raw.resets_at * 1000;
  } else if (typeof raw.resets_in_seconds === 'number' && eventAt) {
    // Older Codex builds sent a countdown relative to the event instead.
    resetsAt = eventAt + raw.resets_in_seconds * 1000;
  }
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: typeof raw.window_minutes === 'number' ? raw.window_minutes : null,
    resetsAt,
  };
}

function toSample(event, file) {
  const limits = event.limits;
  const primary = toWindow(limits.primary, event.at);
  const secondary = toWindow(limits.secondary, event.at);

  // Codex sends the short window as primary. The rows are labelled by length,
  // though, so where the lengths say otherwise the lengths win.
  let session = primary;
  let weekly = secondary;
  if (primary && secondary && primary.windowMinutes > secondary.windowMinutes) {
    session = secondary;
    weekly = primary;
  } else if (primary && !secondary && primary.windowMinutes > DAY_MINUTES) {
    session = null;
    weekly = primary;
  } else if (!primary && secondary && secondary.windowMinutes !== null
      && secondary.windowMinutes <= DAY_MINUTES) {
    session = secondary;
    weekly = null;
  }
  if (!session && !weekly) return null;

  return {
    at: event.at,
    file,
    plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
    session,
    weekly,
  };
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
  if (stopped || polling) return;
  polling = true;
  try {
    const home = codexHome();
    homeFound = fs.existsSync(home);
    if (!homeFound) {
      sample = null;
      lastError = null;
      return;
    }

    const full = Date.now() - lastFullScan >= FULL_SCAN_MS;
    const entries = [];
    for (const root of [path.join(home, 'sessions'), path.join(home, 'archived_sessions')]) {
      entries.push(...await listRollouts(await rolloutDirs(root, full ? 0 : RECENT_DAY_DIRS)));
    }
    if (full) {
      lastFullScan = Date.now();
    } else {
      const extra = new Set(watchList);
      if (sample) extra.add(sample.file);
      for (const file of extra) {
        if (entries.some((e) => e.file === file)) continue;
        const entry = await statEntry(file);
        if (entry) entries.push(entry);
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (full) watchList = entries.slice(0, CANDIDATES).map((e) => e.file);

    let best = null;
    const examined = new Set();
    for (const entry of entries) {
      if (examined.size >= MAX_FILES_EXAMINED) break;
      if (examined.size >= CANDIDATES && best) break;
      examined.add(entry.file);
      const event = await lastEventInFile(entry);
      if (event && (!best || (event.at || 0) > (best.event.at || 0))) {
        best = { event, file: entry.file };
      }
    }
    for (const file of parsed.keys()) {
      if (!examined.has(file)) parsed.delete(file);
    }

    if (best) {
      const next = toSample(best.event, best.file);
      if (next) {
        sample = next;
        lastError = null;
      } else {
        lastError = 'unrecognised rate_limits format';
      }
    } else {
      lastError = null;
    }
  } catch (err) {
    // Keep the previous sample: it stays correct until its windows reset.
    lastError = err.message;
  } finally {
    polling = false;
    schedule(POLL_MS);
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

function currentWindow(w, now) {
  if (!w) return null;
  // The window this percentage belonged to has rolled over since the turn that
  // reported it, and the next one has not been used yet — or it would have
  // written a newer event.
  if (w.resetsAt !== null && w.resetsAt <= now) {
    return { usedPercent: 0, windowMinutes: w.windowMinutes, resetsAt: null, reset: true };
  }
  return { ...w, reset: false };
}

/**
 * Current Codex limits. Cheap — served from the cached sample, so the renderer
 * can poll it as often as it likes. `available: false` means there is nothing
 * to show, and the rows should hide.
 */
function getUsage() {
  if (!sample) {
    return {
      available: false,
      reason: lastError || (homeFound ? 'no Codex usage recorded yet' : 'Codex not found'),
    };
  }
  const now = Date.now();
  return {
    available: true,
    capturedAt: sample.at,
    plan: sample.plan,
    session: currentWindow(sample.session, now),
    weekly: currentWindow(sample.weekly, now),
    // Non-null means a later poll failed; the sample shown is still valid.
    error: lastError,
  };
}

module.exports = { start, stop, getUsage };
