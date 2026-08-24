// Renderer for the status panel popup. Runs in its own BrowserWindow with the
// narrow `statusPanel` bridge from preload-status.js — no access to the
// widget's IPC surface, and no network of its own (CSP sets connect-src none).

// The theme cannot be read from a store here, so the widget passes its own
// through on the URL. Dark is the default; only an explicit light flips it.
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light') document.body.classList.add('theme-light');

const els = {
    overall: document.getElementById('panelOverall'),
    rows: document.getElementById('panelRows'),
    incidents: document.getElementById('panelIncidents'),
    updated: document.getElementById('panelUpdated'),
    link: document.getElementById('panelLink'),
};

// A panel left open should not go stale. main.js answers from a cached snapshot
// it refreshes once a minute, so this is a cheap read, not a second poll of the
// status page.
const REFRESH_MS = 15000;

function formatTime(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Updated ${hh}:${mm}`;
}

function render(status) {
    if (!status) return;

    const components = status.components || [];
    const failing = components.filter((c) => c.level !== 'ok').length;
    // Deliberately not status.overallText: that names the worst component, which
    // is the very next thing on screen. A count is the one thing the rows below
    // cannot tell you at a glance.
    let summary;
    if (status.level === 'unknown') summary = 'Status unavailable';
    else if (!failing) summary = 'All operational';
    else summary = `${failing} of ${components.length} affected`;
    els.overall.textContent = summary;
    els.overall.className = 'panel-overall ' + (status.level || 'unknown');

    els.rows.replaceChildren(...components.map((c) => {
        const row = document.createElement('div');
        row.className = 'panel-row';

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + c.level;

        const name = document.createElement('span');
        name.className = 'panel-row-name';
        name.textContent = c.label;

        const state = document.createElement('span');
        state.className = 'panel-row-state ' + c.level;
        state.textContent = c.statusText;

        row.append(dot, name, state);
        return row;
    }));

    const incidents = status.incidents || [];
    if (incidents.length) {
        els.incidents.style.display = '';
        els.incidents.replaceChildren(...incidents.map((inc) => {
            const box = document.createElement('div');
            box.className = 'panel-incident';

            const name = document.createElement('div');
            name.className = 'panel-incident-name';
            name.textContent = inc.name;

            const meta = document.createElement('div');
            meta.className = 'panel-incident-meta';
            // Statuspage's own vocabulary: impact (minor/major/critical) and
            // lifecycle (investigating/identified/monitoring).
            meta.textContent = [inc.impact, inc.status].filter(Boolean).join(' · ');

            box.append(name, meta);
            return box;
        }));
    } else {
        els.incidents.style.display = 'none';
        els.incidents.replaceChildren();
    }

    // An `error` alongside a usable snapshot means the last poll failed but the
    // data is still inside its freshness window — worth saying, quietly.
    els.updated.textContent = status.error && status.ok
        ? formatTime(status.fetchedAt) + ' · refresh failed'
        : formatTime(status.fetchedAt);
}

async function refresh() {
    try {
        render(await window.statusPanel.getServiceStatus());
    } catch (err) {
        console.warn('status panel refresh failed:', err);
    }
}

els.link.addEventListener('click', () => {
    window.statusPanel.openStatusPage();
    window.statusPanel.close();
});

// Esc closes, as it does for every transient surface. Clicking away is handled
// by the window's own blur in status-panel.js.
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.statusPanel.close();
});

// Published for status-panel.js in the main process, which sizes the window to
// #panel and must not measure an empty shell. `did-finish-load` fires before
// this first IPC round-trip completes, so waiting on the load event alone would
// read the height of a panel with no rows in it yet.
window.__panelReady = refresh();

setInterval(refresh, REFRESH_MS);
