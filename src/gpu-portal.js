'use strict';

/**
 * gpu-portal.js
 *
 * The lab GPU servers' portal (campus network only) answers /api/mine?user=
 * with just the GPUs that account is running on — about 100 bytes. Off campus
 * the request fails, the snapshot goes stale, and the bar hides the group.
 *
 * The portal uses a self-signed certificate, so certificate checks are off for
 * this one fixed address only.
 */

const https = require('https');

const PORTAL = 'https://10.100.50.102:8443';
// The portal itself re-reads the servers every 10 s; asking faster gets the same numbers.
const POLL_MS = 10 * 1000;
const STALE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;

let user = '';
let timer = null;
let failures = 0;
let generation = 0;
let sample = null; // { at, gpus, down }

function fetchMine() {
  return new Promise((resolve, reject) => {
    const url = `${PORTAL}/api/mine?user=${encodeURIComponent(user)}`;
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function poll() {
  timer = null;
  const gen = generation;
  try {
    const json = await fetchMine();
    if (gen !== generation) return;
    sample = {
      at: Date.now(),
      gpus: Array.isArray(json.gpus) ? json.gpus : [],
      down: Array.isArray(json.down) ? json.down : [],
    };
    failures = 0;
  } catch {
    if (gen !== generation) return;
    failures++;
  }
  timer = setTimeout(poll, Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
}

/** Start polling for `account`; an empty account leaves the feature off. */
function start(account) {
  user = String(account || '').trim();
  if (user && !timer) poll();
}

// A request still in flight belongs to the old generation and is dropped.
function stop() {
  generation++;
  user = '';
  sample = null;
  failures = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Cached snapshot, or null when off, unreachable, or stale. */
function getMine() {
  if (!user || !sample || Date.now() - sample.at > STALE_MS) return null;
  return { gpus: sample.gpus, down: sample.down };
}

module.exports = { start, stop, getMine };
