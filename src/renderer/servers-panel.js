// The click-toggled lab GPU server popup: one row per GPU the "Server account"
// runs on, read from main's cached portal snapshot (src/gpu-portal.js).

const query = new URLSearchParams(location.search);
if (query.get('theme') === 'light') document.body.classList.add('theme-light');

const HOT = 85;
const REFRESH_MS = 2000;

const els = {
    rows: document.getElementById('srvRows'),
    updated: document.getElementById('srvUpdated'),
};

function row(g) {
    const util = Math.min(100, Math.max(0, g.util || 0));
    const box = document.createElement('div');
    box.className = 'sys-row';

    const head = document.createElement('div');
    head.className = 'sys-head';
    const name = document.createElement('span');
    name.className = 'sys-name';
    name.textContent = `${g.server} · GPU ${g.idx}`;
    const val = document.createElement('span');
    val.className = 'sys-val' + (util >= HOT ? ' hot' : '');
    val.textContent = g.util === null || g.util === undefined ? 'n/a' : util + '%';
    head.append(name, val);

    const meter = document.createElement('div');
    meter.className = 'sys-meter';
    const fill = document.createElement('div');
    fill.className = 'sys-fill gpu' + (util >= HOT ? ' hot' : '');
    fill.style.width = util + '%';
    meter.append(fill);

    const sub = document.createElement('div');
    sub.className = 'sys-detail';
    sub.textContent = `Memory ${g.mem_gb} / ${g.memtot_gb} GB`;

    box.append(head, meter, sub);
    return box;
}

// Available GPUs on the shared servers, one line per server: "h200x4 · GPU 0, 1".
function freeRow(free) {
    const box = document.createElement('div');
    box.className = 'sys-row';
    const head = document.createElement('div');
    head.className = 'sys-head';
    const name = document.createElement('span');
    name.className = 'sys-name';
    name.textContent = 'Available';
    const val = document.createElement('span');
    val.className = 'sys-val';
    val.textContent = free.length;
    head.append(name, val);
    box.append(head);

    const byServer = new Map();
    for (const g of free) {
        if (!byServer.has(g.server)) byServer.set(g.server, []);
        byServer.get(g.server).push(g.idx);
    }
    for (const [server, idx] of byServer) {
        const sub = document.createElement('div');
        sub.className = 'sys-detail';
        sub.textContent = `${server} · GPU ${idx.join(', ')}`;
        box.append(sub);
    }
    return box;
}

function render(mine) {
    const gpus = (mine && mine.gpus) || [];
    const rows = gpus.map(row);
    if (!rows.length) {
        const none = document.createElement('div');
        none.className = 'sys-detail';
        none.textContent = 'No GPUs in use';
        rows.push(none);
    }
    rows.push(freeRow((mine && mine.free) || []));
    els.rows.replaceChildren(...rows);
    const d = new Date();
    els.updated.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0')).join(':');
}

async function refresh() {
    try {
        render(await window.statusPanel.getGpuPortal());
    } catch (err) {
        console.warn('servers panel refresh failed:', err);
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.statusPanel.close();
});

window.__panelReady = refresh();
setInterval(refresh, REFRESH_MS);
