'use strict';

/**
 * chatgpt-usage.js
 *
 * Live Codex plan limits from chatgpt.com, reusing the sign-in the Codex CLI
 * already holds on this machine — so there is nothing to log in to here.
 *
 * Codex authenticates through ChatGPT and stores the resulting OAuth tokens in
 * ~/.codex/auth.json. Its `access_token` is accepted as a Bearer credential by
 * chatgpt.com/backend-api/wham/usage — the same endpoint chatgpt.com's own
 * Codex usage page calls — which returns rate_limit.primary_window /
 * secondary_window (used_percent, limit_window_seconds, reset_at). Verified
 * 2026-09-10: a plain main-process request with only that header returns 200,
 * with no Cloudflare challenge and no browser window, unlike the cookie-scraping
 * path the claude.ai side needs.
 *
 * Why this rather than a chatgpt.com login window: Google's sign-in refuses
 * Electron's embedded browser outright ("this browser may not be secure"), and
 * spoofing it is a losing game. The token is already on disk, already refreshed
 * by Codex, and belongs to the same account whose usage we want.
 *
 * Freshness vs codex-usage.js's local logs: this is live — it reflects use on
 * other devices and the web, not just the last Codex turn on this PC. codex-
 * usage.js picks whichever snapshot is newer and falls back to the logs when
 * this is unavailable.
 *
 * Deliberately read-only on auth.json. The access token is short-lived (~days)
 * and Codex refreshes it on use; we never refresh it ourselves, because OpenAI
 * rotates the refresh token on use and writing a new one back would risk
 * invalidating Codex's own session. An expired token here just means falling
 * back to the local logs until Codex next runs.
 *
 * Not a published API — like the claude.ai endpoints this app already leans on,
 * it can change without notice. Anything unparseable is reported unavailable.
 * The token itself is held only in memory for the duration of a request and is
 * never logged or written anywhere.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { net } = require('electron');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// The Claude usage refresh runs at this rate too; the limits do not move faster.
const POLL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
// Skip the request once the token is within this of expiry — the clocks are
// close enough that calling right at the edge just 401s.
const EXPIRY_SKEW_MS = 30 * 1000;

let timer = null;
let stopped = true;
let inFlight = null;
let tokenPresent = false;
let tokenExpired = false;
let sample = null;   // { at, plan, primary, secondary }
let lastError = null;

function authPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

/** The access token from Codex's auth.json, or null. Read fresh each time so
 *  Codex's own refresh is picked up without any coordination. */
function readAccessToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    const token = auth && auth.tokens && auth.tokens.access_token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null; // no Codex, or the file is mid-write
  }
}

/** A JWT's `exp` in ms, or null if it cannot be read. */
function tokenExpiryMs(token) {
  try {
    const seg = token.split('.')[1];
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function toWindow(raw) {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) {
    return null;
  }
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: typeof raw.limit_window_seconds === 'number' ? raw.limit_window_seconds / 60 : null,
    resetsAt: typeof raw.reset_at === 'number'
      ? (raw.reset_at > 1e12 ? raw.reset_at : raw.reset_at * 1000)
      : null,
  };
}

function getJson(token) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: USAGE_URL });
    req.setHeader('Authorization', 'Bearer ' + token);
    req.setHeader('Accept', 'application/json');
    const timeout = setTimeout(() => {
      req.abort();
      reject(new Error('timed out'));
    }, REQUEST_TIMEOUT_MS);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        clearTimeout(timeout);
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error('HTTP ' + res.statusCode);
          err.unauthorized = true;
          return reject(err);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('bad JSON'));
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

/** Fetch now. Concurrent callers share the one in-flight attempt. */
function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const token = readAccessToken();
    tokenPresent = !!token;
    if (!token) {
      sample = null;
      tokenExpired = false;
      lastError = null;
      return;
    }

    const expMs = tokenExpiryMs(token);
    if (expMs !== null && expMs - EXPIRY_SKEW_MS <= Date.now()) {
      // Stale token Codex has not refreshed yet — fall back to the logs rather
      // than spend a request that can only 401.
      tokenExpired = true;
      sample = null;
      lastError = 'Codex sign-in token expired';
      return;
    }

    try {
      const u = await getJson(token);
      const rl = u && u.rate_limit;
      const primary = toWindow(rl && rl.primary_window);
      const secondary = toWindow(rl && rl.secondary_window);
      if (primary || secondary) {
        sample = {
          at: Date.now(),
          plan: typeof u.plan_type === 'string' ? u.plan_type : null,
          primary,
          secondary,
        };
        tokenExpired = false;
        lastError = null;
      } else {
        lastError = 'unrecognised usage response';
      }
    } catch (err) {
      if (err.unauthorized) {
        // The token is present but rejected — expired or revoked. Fall back to
        // the logs; keep no stale server sample.
        tokenExpired = true;
        sample = null;
      }
      // Everything else (timeout, 5xx, network) is transient: keep the last
      // good sample, which stays valid until its windows reset.
      lastError = err.message;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function schedule(delay) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await refresh();
    schedule(POLL_MS);
  }, delay);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin polling. Call after app 'ready' (net needs the app ready). */
function start() {
  if (!stopped) return;
  stopped = false;
  schedule(0);
}

function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** For the tooltip: whether a live server reading is being used, and why not. */
function getState() {
  return {
    live: !!sample,
    tokenPresent,
    tokenExpired,
    error: lastError,
  };
}

/** The latest good server sample, or null when there is nothing live to show. */
function getSample() {
  return sample;
}

module.exports = { start, stop, refresh, getState, getSample };
