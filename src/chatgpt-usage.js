'use strict';

/**
 * chatgpt-usage.js
 *
 * Live Codex plan limits from chatgpt.com. Two credentials, whichever is
 * available, and no embedded sign-in of our own:
 *
 * 1. The token the Codex CLI already stores in ~/.codex/auth.json. If Codex is
 *    signed in on this PC, its OAuth access_token works as a Bearer against
 *    GET /backend-api/wham/usage. Automatic; nothing to connect. Read-only and
 *    never refreshed here — OpenAI rotates the refresh token, and writing one
 *    back would break Codex's own session.
 *
 * 2. A ChatGPT account the user connects in Settings — for people who do NOT
 *    run Codex. connect() runs the OAuth PKCE loopback flow the Codex CLI uses:
 *    the real system browser opens auth.openai.com (so Google's embedded-
 *    browser refusal never applies), the user signs in, and the browser
 *    redirects to a one-shot http://localhost:1455 server we run just long
 *    enough to catch the code. The code is exchanged for our OWN token set
 *    (access + refresh); we hold the refresh token and mint access tokens as
 *    needed, so this survives restarts and rarely needs re-connecting. This is
 *    a separate login from Codex's, so refreshing it never touches auth.json.
 *
 * Codex's token is preferred when present — same account, refreshed for free.
 * The connected account is the fallback and the only path on a Codex-less PC.
 *
 * Both return chatgpt.com's rate_limit.primary_window / secondary_window
 * (used_percent, limit_window_seconds, reset_at). Not a published API; it can
 * change without notice, and codex-usage.js drops to the local logs when
 * nothing here is available. Tokens live only in memory (plus the refresh token
 * main.js persists encrypted); none are ever logged.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { net } = require('electron');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// Codex CLI's own OAuth client and loopback redirect — reused so the code we
// receive exchanges the same way `codex login` does.
const ISSUER = 'https://auth.openai.com';
const AUTH_URL = ISSUER + '/oauth/authorize';
const TOKEN_URL = ISSUER + '/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = 'openid profile email offline_access';

const POLL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;

let timer = null;
let stopped = true;
let inFlight = null;

// Connected-account (OAuth) state.
let refreshToken = null;           // persisted by main.js via onRefreshToken
let accessToken = null;            // in memory; minted from refreshToken
let accessExpMs = 0;
let onRefreshToken = () => {};      // main.js persists / clears
let loginServer = null;

// Reporting.
let codexTokenPresent = false;
let codexTokenExpired = false;
let connected = false;             // a refresh token is held
let connectExpired = false;        // refresh failed — needs reconnect
let source = null;                 // 'codex' | 'account' | null
let sample = null;                 // { at, plan, primary, secondary }
let lastError = null;

// --- token helpers ----------------------------------------------------------

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function authPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function readCodexToken() {
  try {
    const auth = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    const t = auth && auth.tokens && auth.tokens.access_token;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

function tokenExpiryMs(token) {
  try {
    const seg = String(token).split('.')[1];
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(token) {
  const exp = tokenExpiryMs(token);
  return exp !== null && exp - EXPIRY_SKEW_MS <= Date.now();
}

function toWindow(raw) {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: typeof raw.limit_window_seconds === 'number' ? raw.limit_window_seconds / 60 : null,
    resetsAt: typeof raw.reset_at === 'number'
      ? (raw.reset_at > 1e12 ? raw.reset_at : raw.reset_at * 1000) : null,
  };
}

// --- HTTP ------------------------------------------------------------------

function request(method, url, { headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    let body = '';
    const timeout = setTimeout(() => { req.abort(); reject(new Error('timed out')); }, REQUEST_TIMEOUT_MS);
    req.on('response', (res) => {
      res.on('data', (c) => { body += c; });
      res.on('end', () => { clearTimeout(timeout); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
    if (form) { req.setHeader('Content-Type', 'application/x-www-form-urlencoded'); req.write(new URLSearchParams(form).toString()); }
    req.end();
  });
}

async function fetchUsage(token) {
  const res = await request('GET', USAGE_URL, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) { const e = new Error('HTTP ' + res.status); e.unauthorized = true; throw e; }
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  return JSON.parse(res.body);
}

function store(u, src) {
  const rl = u && u.rate_limit;
  const primary = toWindow(rl && rl.primary_window);
  const secondary = toWindow(rl && rl.secondary_window);
  if (!primary && !secondary) { lastError = 'unrecognised usage response'; return false; }
  sample = { at: Date.now(), plan: typeof u.plan_type === 'string' ? u.plan_type : null, primary, secondary };
  source = src;
  lastError = null;
  return true;
}

// --- connected account: refresh-token grant --------------------------------

function adoptRefreshToken(rt) {
  if (rt && rt !== refreshToken) {
    refreshToken = rt;
    try { onRefreshToken(rt); } catch { /* persistence is best-effort */ }
  }
}

/** A valid access token for the connected account, minting one from the
 *  refresh token when needed. Null if not connected or the refresh failed. */
async function ensureAccessToken() {
  if (!refreshToken) return null;
  if (accessToken && Date.now() < accessExpMs - EXPIRY_SKEW_MS) return accessToken;
  const res = await request('POST', TOKEN_URL, {
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, scope: SCOPE },
  });
  if (res.status !== 200) {
    // A refused refresh means the connection is dead (revoked / too old).
    if (res.status === 400 || res.status === 401) { connectExpired = true; }
    throw new Error('refresh HTTP ' + res.status);
  }
  const j = JSON.parse(res.body);
  if (!j.access_token) throw new Error('no access_token from refresh');
  accessToken = j.access_token;
  accessExpMs = tokenExpiryMs(accessToken) || (Date.now() + 60 * 60 * 1000);
  if (j.refresh_token) adoptRefreshToken(j.refresh_token); // rotation
  connectExpired = false;
  return accessToken;
}

// --- refresh loop ----------------------------------------------------------

function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // 1) Codex's own token, preferred (no refresh, no rotation).
    const codexToken = readCodexToken();
    codexTokenPresent = !!codexToken;
    codexTokenExpired = false;
    connected = !!refreshToken;

    if (codexToken) {
      if (isExpired(codexToken)) {
        codexTokenExpired = true;
      } else {
        try {
          if (store(await fetchUsage(codexToken), 'codex')) return;
        } catch (err) {
          if (err.unauthorized) codexTokenExpired = true;
          else lastError = err.message;
        }
      }
    }

    // 2) The connected ChatGPT account.
    if (refreshToken) {
      try {
        const token = await ensureAccessToken();
        if (token && store(await fetchUsage(token), 'account')) { connectExpired = false; return; }
      } catch (err) {
        lastError = err.message; // connectExpired is set by ensureAccessToken on a hard refusal
      }
    }

    // Nothing served a fresh reading: drop the sample only when no credential
    // can serve it, so a transient error keeps the last good numbers.
    const codexUsable = codexTokenPresent && !codexTokenExpired;
    const accountUsable = connected && !connectExpired;
    if (!codexUsable && !accountUsable) { sample = null; source = null; }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function schedule(delay) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => { await refresh(); schedule(POLL_MS); }, delay);
  if (timer.unref) timer.unref();
}

// --- connect / disconnect ---------------------------------------------------

/**
 * Run the OAuth loopback flow. `openExternal` (shell.openExternal) sends the
 * user to auth.openai.com in their real browser. Resolves with getState() once
 * a token set is obtained, the window is abandoned, or it times out.
 */
function connect(openExternal) {
  if (loginServer) { return Promise.resolve(getState()); } // already connecting
  return new Promise((resolve) => {
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(32));
    let done = false;

    const finish = async (adopted) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (loginServer) { try { loginServer.close(); } catch {} loginServer = null; }
      if (adopted) await refresh();
      resolve(getState());
    };
    const timeout = setTimeout(() => { lastError = 'login timed out'; finish(false); }, LOGIN_TIMEOUT_MS);

    loginServer = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/auth/callback')) { res.writeHead(404); res.end(); return; }
      const u = new URL(req.url, REDIRECT_URI);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">'
        + '<h2>Connected — you can close this tab and return to the widget.</h2>'
        + '<p>위젯으로 돌아가셔도 됩니다.</p></body>');
      try {
        if (u.searchParams.get('error') || u.searchParams.get('state') !== state) {
          lastError = u.searchParams.get('error') || 'state mismatch';
          return finish(false);
        }
        const code = u.searchParams.get('code');
        const tok = await request('POST', TOKEN_URL, {
          form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier },
        });
        if (tok.status !== 200) { lastError = 'token exchange HTTP ' + tok.status; return finish(false); }
        const j = JSON.parse(tok.body);
        if (!j.refresh_token || !j.access_token) { lastError = 'no tokens returned'; return finish(false); }
        accessToken = j.access_token;
        accessExpMs = tokenExpiryMs(accessToken) || (Date.now() + 60 * 60 * 1000);
        connectExpired = false;
        adoptRefreshToken(j.refresh_token);
        connected = true;
        finish(true);
      } catch (err) {
        lastError = err.message;
        finish(false);
      }
    });
    loginServer.on('error', (err) => { lastError = 'cannot open login port: ' + err.message; finish(false); });
    loginServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const url = AUTH_URL + '?' + new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256',
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state,
      }).toString();
      try { openExternal(url); } catch (err) { lastError = 'cannot open browser: ' + err.message; finish(false); }
    });
  });
}

function disconnect() {
  refreshToken = null;
  accessToken = null;
  accessExpMs = 0;
  connected = false;
  connectExpired = false;
  if (source === 'account') { sample = null; source = null; }
  try { onRefreshToken(null); } catch { /* best effort */ }
  return getState();
}

// --- public API -------------------------------------------------------------

function start({ refreshToken: rt, onRefreshToken: persist } = {}) {
  if (!stopped) return;
  stopped = false;
  if (typeof persist === 'function') onRefreshToken = persist;
  if (rt) { refreshToken = rt; connected = true; }
  schedule(0);
}

function stop() {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
  if (loginServer) { try { loginServer.close(); } catch {} loginServer = null; }
}

function getState() {
  return {
    live: !!sample,
    source,
    codexToken: codexTokenPresent && !codexTokenExpired,
    connected,
    connectExpired,
    error: lastError,
  };
}

function getSample() {
  return sample;
}

module.exports = { start, stop, refresh, connect, disconnect, getState, getSample };
