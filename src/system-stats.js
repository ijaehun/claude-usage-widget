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
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Overall CPU utilisation percentage since the previous call.
 * Returns null on the very first call, when there is no baseline to diff yet.
 * @returns {number|null} 0-100, rounded to one decimal
 */
function readCpuPercent() {
  const snap = cpuSnapshot();
  const prev = prevCpu;
  prevCpu = snap;
  if (!prev) return null;

  const totalDelta = snap.total - prev.total;
  const idleDelta = snap.idle - prev.idle;
  // Two calls inside the same tick produce a zero delta; report no reading
  // rather than dividing by zero.
  if (totalDelta <= 0) return null;

  const pct = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
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

const GPU_QUERY = 'utilization.gpu,memory.used,memory.total,temperature.gpu';

let gpuProc = null;
let gpuSample = null;      // { percent, memUsedMB, memTotalMB, tempC, at }
let gpuUnavailable = null; // reason string once we know nvidia-smi won't work
let gpuRespawnTimer = null;
let stopped = false;

function parseGpuLine(line) {
  // Expected: "12, 11784, 24564, 41" — utilisation %, MiB used, MiB total, °C.
  // Fields can read "[N/A]" on some laptop/vGPU setups; treat those as missing
  // rather than letting NaN reach the renderer.
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 4) return null;
  const nums = parts.slice(0, 4).map(p => (/^\d+(\.\d+)?$/.test(p) ? Number(p) : null));
  const [percent, memUsedMB, memTotalMB, tempC] = nums;
  if (percent === null || memTotalMB === null) return null;
  return { percent, memUsedMB, memTotalMB, tempC, at: Date.now() };
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

function readGpu() {
  if (gpuUnavailable) return { available: false, reason: gpuUnavailable };
  if (!gpuSample) return { available: false, reason: 'waiting for first sample' };
  if (Date.now() - gpuSample.at > GPU_STALE_MS) {
    return { available: false, reason: 'stream stalled' };
  }
  const { percent, memUsedMB, memTotalMB, tempC } = gpuSample;
  return {
    available: true,
    percent,
    memUsedMB,
    memTotalMB,
    memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 1000) / 10 : null,
    tempC,
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
}

/** Tear down the nvidia-smi child so the app can exit cleanly. */
function stop() {
  stopped = true;
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
    cpu: { percent: readCpuPercent(), model: os.cpus()[0]?.model ?? null, cores: os.cpus().length },
    memory: readMemory(),
    gpu: readGpu(),
  };
}

module.exports = { start, stop, getStats };
