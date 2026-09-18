// The click-toggled machine detail popup (CPU / GPU / VRAM / RAM). Opened by
// the same main-process code as the service status panel (src/status-panel.js)
// and through the same narrow preload bridge; this page only reads the cached
// system stats. English only, like the numbers it shows.

const query = new URLSearchParams(location.search);
if (query.get('theme') === 'light') document.body.classList.add('theme-light');

// Past this a resource counts as under pressure, as in the widget.
const HOT = 85;
// Matches the widget's own sysmon poll, so both show the same sample.
const REFRESH_MS = 2000;

const els = {
    rows: document.getElementById('sysRows'),
    updated: document.getElementById('sysUpdated'),
};

const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);
const gb = (mb) => (mb / 1024).toFixed(1);
const gbBytes = (b) => (b / 1073741824).toFixed(1);

function cleanCpuModel(model) {
    return model
        ? model.replace(/\((R|TM)\)/gi, '').replace(/\s+CPU\s+@.*$/i, '').replace(/\s+/g, ' ').trim()
        : 'CPU';
}

/** One resource: name and value, a meter, and a line of detail beneath. */
function row(name, kind, percent, detail) {
    const box = document.createElement('div');
    box.className = 'sys-row';

    const head = document.createElement('div');
    head.className = 'sys-head';
    const label = document.createElement('span');
    label.className = 'sys-name';
    label.textContent = name;
    const val = document.createElement('span');
    val.className = 'sys-val' + (has(percent) ? (percent >= HOT ? ' hot' : '') : ' na');
    val.textContent = has(percent) ? Math.round(percent) + '%' : 'n/a';
    head.append(label, val);

    const meter = document.createElement('div');
    meter.className = 'sys-meter';
    const fill = document.createElement('div');
    fill.className = 'sys-fill ' + kind + (has(percent) && percent >= HOT ? ' hot' : '');
    fill.style.width = has(percent) ? Math.min(100, Math.max(0, percent)) + '%' : '0%';
    meter.append(fill);

    const sub = document.createElement('div');
    sub.className = 'sys-detail';
    sub.textContent = detail;

    box.append(head, meter, sub);
    return box;
}

function render(stats) {
    if (!stats) return;
    const cpu = stats.cpu || {};
    const gpu = stats.gpu || { available: false };
    const mem = stats.memory;

    const cpuDetail = [cleanCpuModel(cpu.model), cpu.cores ? cpu.cores + ' threads' : null,
        has(cpu.busiest) ? 'busiest thread ' + Math.round(cpu.busiest) + '%' : null].filter(Boolean).join(' · ');

    const rows = [row('CPU', 'cpu', cpu.percent, cpuDetail)];
    if (gpu.available) {
        const heat = [has(gpu.tempC) ? gpu.tempC + '°C' : null,
            has(gpu.powerW) ? `${Math.round(gpu.powerW)}${has(gpu.powerLimitW) ? ' / ' + Math.round(gpu.powerLimitW) : ''} W` : null];
        rows.push(row('GPU', 'gpu', gpu.percent, [gpu.name || 'GPU', ...heat].filter(Boolean).join(' · ')));
        let vram = `${gb(gpu.memUsedMB)} / ${gb(gpu.memTotalMB)} GB`;
        if (has(gpu.sharedMB)) vram += ` · Shared ${gb(gpu.sharedMB)} GB`;
        rows.push(row('VRAM', 'vram', gpu.memPercent, vram));
    } else {
        const why = gpu.reason ? 'GPU: ' + gpu.reason : 'No NVIDIA GPU reading';
        rows.push(row('GPU', 'gpu', null, why));
        rows.push(row('VRAM', 'vram', null, why));
    }
    if (mem) rows.push(row('RAM', 'ram', mem.percent, `${gbBytes(mem.usedBytes)} / ${gbBytes(mem.totalBytes)} GB`));
    els.rows.replaceChildren(...rows);

    const d = new Date();
    els.updated.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0')).join(':');
}

async function refresh() {
    try {
        render(await window.statusPanel.getSystemStats());
    } catch (err) {
        console.warn('system panel refresh failed:', err);
    }
}

// Esc closes, as for every transient surface; clicking away is the window's blur.
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.statusPanel.close();
});

// status-panel.js sizes the window to #panel once this settles, so it must not
// measure the empty shell.
window.__panelReady = refresh();
setInterval(refresh, REFRESH_MS);
