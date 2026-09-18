// Renderer for the status panel popup. Runs in its own BrowserWindow with the
// narrow `statusPanel` bridge from preload-status.js — no access to the
// widget's IPC surface, and no network of its own (CSP sets connect-src none).

// The theme cannot be read from a store here, so the widget passes its own
// through on the URL. Dark is the default; only an explicit light flips it.
const query = new URLSearchParams(location.search);
const theme = query.get('theme');
if (theme === 'light') document.body.classList.add('theme-light');
// Same source, same reason: the Track setting lives in the widget's store.
const services = query.get('services') || 'both';
const showClaude = services !== 'codex';
const showCodex = services !== 'claude';

const els = {
    claudeSection: document.getElementById('claudeSection'),
    overall: document.getElementById('panelOverall'),
    rows: document.getElementById('panelRows'),
    incidents: document.getElementById('panelIncidents'),
    codexSection: document.getElementById('codexSection'),
    codexOverall: document.getElementById('codexOverall'),
    codexRows: document.getElementById('codexRows'),
    updated: document.getElementById('panelUpdated'),
    link: document.getElementById('panelLink'),
    codexLink: document.getElementById('codexLink'),
};

// The widget passes its resolved language, as it does its theme (i18n.js).
setUiLang(query.get('lang') === 'ko' ? 'ko' : 'en');

els.claudeSection.style.display = showClaude ? '' : 'none';
els.link.style.display = showClaude ? '' : 'none';
els.codexSection.style.display = showCodex ? '' : 'none';
els.codexLink.style.display = showCodex ? '' : 'none';

// A panel left open should not go stale. main.js answers from a cached snapshot
// it refreshes once a minute, so this is a cheap read, not a second poll of the
// status page.
const REFRESH_MS = 15000;

function formatTime(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return t('Updated {time}', { time: `${hh}:${mm}` });
}

/** One service's heading summary and component rows. */
function renderSection(status, overallEl, rowsEl) {
    const components = status.components || [];
    const failing = components.filter((c) => c.level !== 'ok').length;
    // Deliberately not status.overallText: that names the worst component, which
    // is the very next thing on screen. A count is the one thing the rows below
    // cannot tell you at a glance.
    let summary;
    if (status.level === 'unknown') summary = t('Status unavailable');
    else if (!failing) summary = t('All operational');
    else summary = t('{failing} of {total} affected', { failing, total: components.length });
    overallEl.textContent = summary;
    overallEl.className = 'panel-overall ' + (status.level || 'unknown');

    rowsEl.replaceChildren(...components.map((c) => {
        const row = document.createElement('div');
        row.className = 'panel-row';

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + c.level;

        const name = document.createElement('span');
        name.className = 'panel-row-name';
        name.textContent = c.label;

        const state = document.createElement('span');
        state.className = 'panel-row-state ' + c.level;
        state.textContent = t(c.statusText);

        row.append(dot, name, state);
        return row;
    }));
}

function render(status, codexStatus) {
    const shown = [];
    if (showClaude && status) {
        renderSection(status, els.overall, els.rows);
        renderIncidents(status);
        shown.push(status);
    }
    if (showCodex && codexStatus) {
        renderSection(codexStatus, els.codexOverall, els.codexRows);
        shown.push(codexStatus);
    }
    if (!shown.length) return;

    // One timestamp for the panel: the older of the two, so it never claims
    // more freshness than the staler section has. An `error` alongside a usable
    // snapshot means the last poll failed but the data is still inside its
    // freshness window — worth saying, quietly.
    const fetched = shown.map((s) => s.fetchedAt).filter(Boolean);
    const failed = shown.some((s) => s.error && s.ok);
    const at = fetched.length ? Math.min(...fetched) : null;
    els.updated.textContent = failed ? formatTime(at) + t(' · refresh failed') : formatTime(at);
}

function renderIncidents(status) {
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
}

async function refresh() {
    try {
        const [status, codexStatus] = await Promise.all([
            showClaude ? window.statusPanel.getServiceStatus() : null,
            showCodex ? window.statusPanel.getCodexServiceStatus() : null,
        ]);
        render(status, codexStatus);
    } catch (err) {
        console.warn('status panel refresh failed:', err);
    }
}

els.link.addEventListener('click', () => {
    window.statusPanel.openStatusPage();
    window.statusPanel.close();
});

els.codexLink.addEventListener('click', () => {
    window.statusPanel.openCodexStatusPage();
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
