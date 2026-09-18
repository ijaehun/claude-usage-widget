'use strict';

/**
 * system-stats.js
 *
 * Collects local machine CPU / RAM / GPU utilisation for the widget's system
 * monitor row. Runs in the main process — the renderer has no Node access and
 * reaches this through the `get-system-stats` IPC channel.
 *
 * CPU and RAM come from Node's `os` module, so they need no dependencies and
 * work on every platform. GPU is NVIDIA-only via `nvidia-smi`: rather than
 * spawning it on every poll (~100ms each, and process churn every 2s), we
 * spawn it once in `--loop-ms` streaming mode and keep the most recent line.
 * If the binary is missing or the stream dies, `gpu` is reported as null with
 * a reason and the rest of the stats keep working.
 */

const os = require('os');
const { spawn } = require('child_process');

// How often nvidia-smi emits a sample. The renderer polls independently; this
// only needs to be fast enough that a poll rarely sees the same line twice.
const GPU_SAMPLE_MS = 2000;
// A cached GPU sample older than this is treated as no data rather than shown
// as a stale number, so a wedged stream never masquerades as live telemetry.
const GPU_STALE_MS = GPU_SAMPLE_MS * 3;
// Backoff before respawning nvidia-smi after it exits unexpectedly.
const GPU_RESPAWN_MS = 10000;

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

// os.cpus() reports cumulative tick counts since boot, so a single reading says
// nothing about current load — utilisation is the delta between two readings.
// We keep the previous snapshot here and diff against it on each call.
let prevCpu = null;

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  const threads = [];
  for (const cpu of os.cpus()) {
    let t = 0;
    for (const value of Object.values(cpu.times)) t += value;
    total += t;
    idle += cpu.times.idle;
    threads.push({ idle: cpu.times.idle, total: t });
  }
  return { idle, total, threads };
}

const busyPct = (idleDelta, totalDelta) =>
  Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));

/**
 * CPU utilisation since the previous call: overall, and the busiest single
 * thread. On a 32-thread part the average all but hides one pegged thread —
 * 5% overall can be a single-threaded job running flat out — so the busiest
 * one is worth a line of its own.
 * Both are null on the very first call, when there is no baseline to diff yet.
 * @returns {{percent: number|null, busiest: number|null}} 0-100, one decimal
 */
function readCpu() {
  const snap = cpuSnapshot();
  const prev = prevCpu;
  prevCpu = snap;
  if (!prev) return { percent: null, busiest: null };

  const totalDelta = snap.total - prev.total;
  const idleDelta = snap.idle - prev.idle;
  // Two calls inside the same tick produce a zero delta; report no reading
  // rather than dividing by zero.
  if (totalDelta <= 0) return { percent: null, busiest: null };

  let busiest = null;
  if (prev.threads.length === snap.threads.length) {
    snap.threads.forEach((t, i) => {
      const td = t.total - prev.threads[i].total;
      if (td <= 0) return;
      const p = busyPct(t.idle - prev.threads[i].idle, td);
      if (busiest === null || p > busiest) busiest = p;
    });
  }
  const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return { percent: round1(busyPct(idleDelta, totalDelta)), busiest: round1(busiest) };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Physical RAM usage.
 * @returns {{usedBytes: number, totalBytes: number, percent: number}}
 */
function readMemory() {
  const totalBytes = os.totalmem();
  const usedBytes = totalBytes - os.freemem();
  return {
    usedBytes,
    totalBytes,
    percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------
// GPU (NVIDIA via nvidia-smi)
// ---------------------------------------------------------------------------

// Name last: it is the only free-text field, so a comma inside it cannot shift
// the numbers before it.
const GPU_QUERY = 'utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,name';

let gpuProc = null;
let gpuSample = null;      // { percent, memUsedMB, memTotalMB, tempC, powerW, powerLimitW, name, at }
let gpuUnavailable = null; // reason string once we know nvidia-smi won't work
let gpuRespawnTimer = null;
let stopped = false;

function parseGpuLine(line) {
  // Expected: "12, 11784, 24564, 41, 18.09, 450.00, NVIDIA GeForce RTX 4090" —
  // utilisation %, MiB used, MiB total, °C, W drawn, W limit, name.
  // Fields can read "[N/A]" on some laptop/vGPU setups; treat those as missing
  // rather than letting NaN reach the renderer.
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 6) return null;
  const nums = parts.slice(0, 6).map(p => (/^\d+(\.\d+)?$/.test(p) ? Number(p) : null));
  const [percent, memUsedMB, memTotalMB, tempC, powerW, powerLimitW] = nums;
  if (percent === null || memTotalMB === null) return null;
  const name = parts.slice(6).join(', ') || null;
  return { percent, memUsedMB, memTotalMB, tempC, powerW, powerLimitW, name, at: Date.now() };
}

function startGpuStream() {
  if (stopped || gpuProc || gpuUnavailable) return;

  let proc;
  try {
    proc = spawn(
      'nvidia-smi',
      [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits', `--loop-ms=${GPU_SAMPLE_MS}`],
      // windowsHide keeps a console window from flashing on every spawn — without
      // it Windows briefly pops a black box in front of the widget.
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    gpuUnavailable = `spawn failed: ${err.message}`;
    return;
  }

  gpuProc = proc;

  // ENOENT here means no NVIDIA driver/binary on this machine. That is a normal
  // configuration, not a failure, so we latch it and stop retrying forever.
  proc.on('error', (err) => {
    gpuProc = null;
    gpuUnavailable = err.code === 'ENOENT'
      ? 'nvidia-smi not found'
      : `nvidia-smi error: ${err.message}`;
  });

  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    // Keep the trailing fragment: a chunk boundary can land mid-line.
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseGpuLine(line);
      if (parsed) gpuSample = parsed;
    }
  });

  proc.on('exit', () => {
    gpuProc = null;
    if (stopped || gpuUnavailable) return;
    // The stream can die if the driver is reloaded or the GPU resets. Retry on
    // a slow timer so a persistently broken setup does not spin.
    gpuRespawnTimer = setTimeout(startGpuStream, GPU_RESPAWN_MS);
  });
}

// ---------------------------------------------------------------------------
// Shared GPU memory (Windows performance counters)
// ---------------------------------------------------------------------------

// nvidia-smi only knows the card's own memory. "Shared GPU memory" — system
// RAM the driver borrows once VRAM runs out, as Task Manager shows it — lives
// in a Windows performance counter instead. One typeperf read takes ~2s, nearly
// all of it waiting out its own sample interval rather than working, so it runs
// on a slow timer of its own instead of in the 2s stream. Windows-only, and
// only while nvidia-smi is producing samples; otherwise it never reports.
const SHARED_POLL_MS = 30 * 1000;
const SHARED_STALE_MS = SHARED_POLL_MS * 3;
let sharedSample = null; // { mb, at }
let sharedTimer = null;
let sharedBusy = false;

/**
 * Pick the NVIDIA adapter out of typeperf's CSV and return its shared usage in
 * MiB. There is one instance per adapter (an iGPU shows up too), keyed by an
 * opaque LUID, so the card is identified as the adapter whose *dedicated*
 * usage is closest to what nvidia-smi reports.
 */
function parseShared(text, usedMB) {
  const rows = text.split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (rows.length < 2 || usedMB === null || usedMB === undefined) return null;
  const cells = (l) => l.slice(1, -1).split('","');
  const head = cells(rows[0]);
  const vals = cells(rows[rows.length - 1]);
  const adapters = new Map();
  head.forEach((h, i) => {
    const m = /GPU Adapter Memory\(([^)]+)\)\\(Dedicated|Shared) Usage/i.exec(h);
    if (!m) return;
    // Bytes, with a locale-dependent decimal separator.
    const v = parseFloat(String(vals[i]).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    const a = adapters.get(m[1]) || {};
    a[m[2].toLowerCase()] = v / 1048576;
    adapters.set(m[1], a);
  });
  let best = null;
  for (const a of adapters.values()) {
    if (a.dedicated === undefined || a.shared === undefined) continue;
    const diff = Math.abs(a.dedicated - usedMB);
    if (!best || diff < best.diff) best = { diff, shared: a.shared };
  }
  return best ? Math.round(best.shared) : null;
}

function pollShared() {
  if (stopped || sharedBusy || process.platform !== 'win32' || !gpuSample) return;
  sharedBusy = true;
  let out = '';
  let proc;
  try {
    proc = spawn('typeperf',
      ['\\GPU Adapter Memory(*)\\Dedicated Usage', '\\GPU Adapter Memory(*)\\Shared Usage', '-sc', '1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    sharedBusy = false;
    return;
  }
  // The counter paths and values are ASCII; typeperf's localized status lines
  // around them are not, and are skipped by parseShared.
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => { out += chunk; });
  proc.on('error', () => { sharedBusy = false; });
  proc.on('close', () => {
    sharedBusy = false;
    const mb = parseShared(out, gpuSample && gpuSample.memUsedMB);
    if (mb !== null) sharedSample = { mb, at: Date.now() };
  });
}

function readGpu() {
  if (gpuUnavailable) return { available: false, reason: gpuUnavailable };
  if (!gpuSample) return { available: false, reason: 'waiting for first sample' };
  if (Date.now() - gpuSample.at > GPU_STALE_MS) {
    return { available: false, reason: 'stream stalled' };
  }
  const { percent, memUsedMB, memTotalMB, tempC, powerW, powerLimitW, name } = gpuSample;
  const shared = sharedSample && Date.now() - sharedSample.at <= SHARED_STALE_MS ? sharedSample.mb : null;
  return {
    available: true,
    name,
    percent,
    memUsedMB,
    memTotalMB,
    memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 1000) / 10 : null,
    sharedMB: shared,
    tempC,
    powerW,
    powerLimitW,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin background collection. Safe to call more than once. */
function start() {
  stopped = false;
  prevCpu = cpuSnapshot(); // establish a CPU baseline so the first poll has a delta
  startGpuStream();
  if (process.platform === 'win32' && !sharedTimer) {
    // First read once nvidia-smi has had time to produce a sample to match on.
    setTimeout(pollShared, 5000).unref();
    sharedTimer = setInterval(pollShared, SHARED_POLL_MS);
    sharedTimer.unref();
  }
}

/** Tear down the nvidia-smi child so the app can exit cleanly. */
function stop() {
  stopped = true;
  if (sharedTimer) {
    clearInterval(sharedTimer);
    sharedTimer = null;
  }
  if (gpuRespawnTimer) {
    clearTimeout(gpuRespawnTimer);
    gpuRespawnTimer = null;
  }
  if (gpuProc) {
    gpuProc.kill();
    gpuProc = null;
  }
}

/**
 * Current machine stats. Cheap enough to call on a 2s interval — CPU and RAM
 * are in-process reads and GPU is served from the cached stream sample.
 */
function getStats() {
  return {
    cpu: { ...readCpu(), model: os.cpus()[0]?.model ?? null, cores: os.cpus().length },
    memory: readMemory(),
    gpu: readGpu(),
  };
}

module.exports = { start, stop, getStats };
