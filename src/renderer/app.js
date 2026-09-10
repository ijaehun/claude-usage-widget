// Application state
let credentials = null;
let updateInterval = null;
let countdownInterval = null;
let latestUsageData = null;
let isExpanded = false;
let isCompactMode = false;
let _settingsOpenedFromCompact = false;
let usageChart = null;
let graphVisible = false;
let graphWasVisible = false; // preserves graph state across compact mode toggle
let appInitializing = true;  // suppresses _saveViewState during startup restore
let isFetching = false;       // in-flight guard — prevents overlapping fetchUsageData calls
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const WIDGET_HEIGHT_COLLAPSED = 155;
const WIDGET_ROW_HEIGHT = 30;
const GRAPH_HEIGHT = 232;

// --- System monitor (local machine CPU / GPU / VRAM / RAM) ---
let sysmonTimer = null;
let isBarMode = false;
// 4 rows x 22px + section padding/border. Kept as one constant so resizeWidget
// stays a sum of section heights rather than a pile of magic numbers.
const SYSMON_HEIGHT = 107;
// Machine stats move far faster than Claude usage, so this row polls on its own
// short interval rather than riding the 5-minute usage refresh.
const SYSMON_INTERVAL = 2000;
// Above this a resource is considered under pressure and its bar turns red.
const SYSMON_HOT_THRESHOLD = 85;

// --- Claude service status (status.claude.com) ---
let statusTimer = null;
// The 22px row plus the section's border, padding and top margin — measured as
// the delta this section adds to the document, not derived from the CSS, so it
// stays honest if the padding changes. Same bookkeeping as SYSMON_HEIGHT:
// resizeWidget() is a sum of fixed section heights, which holds only as long as
// this row never wraps. Hence the single-row design.
const STATUS_HEIGHT = 47;
// main.js polls the status page once a minute and answers from cache, so this
// only has to be often enough that the dot is not visibly behind.
const STATUS_INTERVAL = 30000;

// --- OpenAI Codex plan limits (src/codex-usage.js) ---
let codexTimer = null;
let latestCodexUsage = null; // null while the Codex rows are hidden
// Both rows plus the section's border, padding and top margin, measured as the
// delta the section adds to the document, like STATUS_HEIGHT. Only added while
// the section is shown.
const CODEX_HEIGHT = 83;
// main.js re-reads Codex's logs every 15s and answers from cache, so this only
// has to keep the bars and countdowns from visibly lagging behind it.
const CODEX_INTERVAL = 15000;

// Elapsed-time ring thresholds (session/weekly/extra-row countdown circles).
// Deliberately hardcoded and independent from the user-configurable
// warnThreshold/dangerThreshold settings below, which describe *usage volume*
// getting close to a limit. Time elapsing toward a reset is a different,
// unrelated metric — nearing 100% elapsed just means the window is about to
// refresh, which is a neutral-to-good thing, not a warning. Reusing the usage
// thresholds/colors here was accidental coupling, not a deliberate choice.
const ELAPSED_AMBER_THRESHOLD = 75;
const ELAPSED_GREEN_THRESHOLD = 90;

// Debug logging — only shows in DevTools (development mode).
// Regular users won't see verbose logs in production.
const DEBUG = (new URLSearchParams(window.location.search)).has('debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

// DOM elements
const elements = {
    loadingContainer: document.getElementById('loadingContainer'),
    loginContainer: document.getElementById('loginContainer'),
    noUsageContainer: document.getElementById('noUsageContainer'),
    mainContent: document.getElementById('mainContent'),
    loginStep1: document.getElementById('loginStep1'),
    loginStep2: document.getElementById('loginStep2'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoDetectError: document.getElementById('autoDetectError'),
    openBrowserLink: document.getElementById('openBrowserLink'),
    nextStepBtn: document.getElementById('nextStepBtn'),
    backStepBtn: document.getElementById('backStepBtn'),
    sessionKeyInput: document.getElementById('sessionKeyInput'),
    connectBtn: document.getElementById('connectBtn'),
    sessionKeyError: document.getElementById('sessionKeyError'),
    refreshBtn: document.getElementById('refreshBtn'),
    graphBtn: document.getElementById('graphBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    closeBtn: document.getElementById('closeBtn'),

    sessionPercentage: document.getElementById('sessionPercentage'),
    sessionProgress: document.getElementById('sessionProgress'),
    sessionTimer: document.getElementById('sessionTimer'),
    sessionTimeText: document.getElementById('sessionTimeText'),

    weeklyPercentage: document.getElementById('weeklyPercentage'),
    weeklyProgress: document.getElementById('weeklyProgress'),
    weeklyTimer: document.getElementById('weeklyTimer'),
    weeklyTimeText: document.getElementById('weeklyTimeText'),
    weeklyResetsAt: document.getElementById('weeklyResetsAt'),

    sessionResetsAt: document.getElementById('sessionResetsAt'),

    expandToggle: document.getElementById('expandToggle'),
    expandArrow: document.getElementById('expandArrow'),
    expandSection: document.getElementById('expandSection'),
    extraRows: document.getElementById('extraRows'),
    graphSection: document.getElementById('graphSection'),
    usageChart: document.getElementById('usageChart'),

    settingsBtn: document.getElementById('settingsBtn'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    chatgptBtn: document.getElementById('chatgptBtn'),

    sysmonSection: document.getElementById('sysmonSection'),
    cpuLabel: document.getElementById('cpuLabel'),
    cpuFill: document.getElementById('cpuFill'),
    cpuPct: document.getElementById('cpuPct'),
    cpuDetail: document.getElementById('cpuDetail'),
    gpuLabel: document.getElementById('gpuLabel'),
    gpuFill: document.getElementById('gpuFill'),
    gpuPct: document.getElementById('gpuPct'),
    gpuDetail: document.getElementById('gpuDetail'),
    vramFill: document.getElementById('vramFill'),
    vramPct: document.getElementById('vramPct'),
    vramDetail: document.getElementById('vramDetail'),
    ramFill: document.getElementById('ramFill'),
    ramPct: document.getElementById('ramPct'),
    ramDetail: document.getElementById('ramDetail'),

    statusSection: document.getElementById('statusSection'),
    statusRow: document.getElementById('statusRow'),
    statusChips: document.getElementById('statusChips'),
    statusText: document.getElementById('statusText'),
    compactStatusItem: document.getElementById('compactStatusItem'),
    compactStatusDot: document.getElementById('compactStatusDot'),
    barStatusItem: document.getElementById('barStatusItem'),
    barStatusDot: document.getElementById('barStatusDot'),
    barStatusText: document.getElementById('barStatusText'),

    codexSection: document.getElementById('codexSection'),
    codexSessionProgress: document.getElementById('codexSessionProgress'),
    codexSessionPercentage: document.getElementById('codexSessionPercentage'),
    codexSessionTimer: document.getElementById('codexSessionTimer'),
    codexSessionTimeText: document.getElementById('codexSessionTimeText'),
    codexSessionResetsAt: document.getElementById('codexSessionResetsAt'),
    codexWeeklyProgress: document.getElementById('codexWeeklyProgress'),
    codexWeeklyPercentage: document.getElementById('codexWeeklyPercentage'),
    codexWeeklyTimer: document.getElementById('codexWeeklyTimer'),
    codexWeeklyTimeText: document.getElementById('codexWeeklyTimeText'),
    codexWeeklyResetsAt: document.getElementById('codexWeeklyResetsAt'),
    compactCodexRow: document.getElementById('compactCodexRow'),
    compactCodexSessionFill: document.getElementById('compactCodexSessionFill'),
    compactCodexSessionPct: document.getElementById('compactCodexSessionPct'),
    compactCodexWeeklyFill: document.getElementById('compactCodexWeeklyFill'),
    compactCodexWeeklyPct: document.getElementById('compactCodexWeeklyPct'),
    barCodexGroup: document.getElementById('barCodexGroup'),
    barCodexSessionFill: document.getElementById('barCodexSessionFill'),
    barCodexSessionPct: document.getElementById('barCodexSessionPct'),
    barCodexWeeklyFill: document.getElementById('barCodexWeeklyFill'),
    barCodexWeeklyPct: document.getElementById('barCodexWeeklyPct'),

    compactSysmon: document.getElementById('compactSysmon'),
    compactCpuPct: document.getElementById('compactCpuPct'),
    compactGpuPct: document.getElementById('compactGpuPct'),
    compactRamPct: document.getElementById('compactRamPct'),

    dockBtn: document.getElementById('dockBtn'),
    barModeToggle: document.getElementById('barModeToggle'),
    barModeCol: document.getElementById('barModeCol'),
    barModeLabel: document.getElementById('barModeLabel'),
    barContent: document.getElementById('barContent'),
    barUndockBtn: document.getElementById('barUndockBtn'),
    barRefreshBtn: document.getElementById('barRefreshBtn'),
    barSessionFill: document.getElementById('barSessionFill'),
    barSessionPct: document.getElementById('barSessionPct'),
    barWeeklyFill: document.getElementById('barWeeklyFill'),
    barWeeklyPct: document.getElementById('barWeeklyPct'),
    barFableItem: document.getElementById('barFableItem'),
    barFableFill: document.getElementById('barFableFill'),
    barFablePct: document.getElementById('barFablePct'),
    barResetsIn: document.getElementById('barResetsIn'),
    barCpuFill: document.getElementById('barCpuFill'),
    barCpuPct: document.getElementById('barCpuPct'),
    barGpuFill: document.getElementById('barGpuFill'),
    barGpuPct: document.getElementById('barGpuPct'),
    barVramFill: document.getElementById('barVramFill'),
    barVramPct: document.getElementById('barVramPct'),
    barRamFill: document.getElementById('barRamFill'),
    barRamPct: document.getElementById('barRamPct'),
    autoStartCol: document.getElementById('autoStartCol'),
    autoStartToggle: document.getElementById('autoStartToggle'),
    autoStartHint: document.getElementById('autoStartHint'),
    minimizeToTrayToggle: document.getElementById('minimizeToTrayToggle'),
    alwaysOnTopToggle: document.getElementById('alwaysOnTopToggle'),
    showTrayStatsToggle: document.getElementById('showTrayStatsToggle'),
    warnThreshold: document.getElementById('warnThreshold'),
    dangerThreshold: document.getElementById('dangerThreshold'),
    themeBtns: document.querySelectorAll('.theme-btn'),
    timeFormat: document.getElementById('timeFormat'),
    weeklyDateFormat: document.getElementById('weeklyDateFormat'),
    refreshInterval: document.getElementById('refreshInterval'),
    orgSelector: document.getElementById('orgSelector'),
    orgSelectorCol: document.getElementById('orgSelectorCol'),

    settingsVersionLabel: document.getElementById('settingsVersionLabel'),
    usageAlertsToggle: document.getElementById('usageAlertsToggle'),
    compactModeToggle: document.getElementById('compactModeToggle'),
    compactModeToggleCompact: document.getElementById('compactModeToggleCompact'),
    compactContent: document.getElementById('compactContent'),
    compactCollapseBtn: document.getElementById('compactCollapseBtn'),
    compactExpandBtn: document.getElementById('compactExpandBtn'),
    compactSessionFill: document.getElementById('compactSessionFill'),
    compactSessionPct: document.getElementById('compactSessionPct'),
    compactWeeklyFill: document.getElementById('compactWeeklyFill'),
    compactWeeklyPct: document.getElementById('compactWeeklyPct'),
    compactFableRow: document.getElementById('compactFableRow'),
    compactFableFill: document.getElementById('compactFableFill'),
    compactFablePct: document.getElementById('compactFablePct'),
    compactSettingsOverlay: document.getElementById('compactSettingsOverlay'),
    closeCompactSettingsBtn: document.getElementById('closeCompactSettingsBtn')
};

// Populate organization selector dropdown
function populateOrgSelector(organizations, selectedOrgId) {
    if (!organizations || organizations.length === 0) {
        // No orgs - hide selector column
        elements.orgSelectorCol.style.display = 'none';
        return;
    }

    // Only show selector if user has multiple chat orgs
    if (organizations.length > 1) {
        elements.orgSelectorCol.style.display = '';  // Show column (use default flex display)
        
        // Clear existing options
        elements.orgSelector.innerHTML = '';
        
        // Add each org as an option
        organizations.forEach(org => {
            const option = document.createElement('option');
            option.value = org.id;
            option.textContent = `${org.name}${org.isTeam ? ' (Team)' : ' (Personal)'}`;
            if (org.id === selectedOrgId) {
                option.selected = true;
            }
            elements.orgSelector.appendChild(option);
        });
    } else {
        // Single org - hide selector column
        elements.orgSelectorCol.style.display = 'none';
    }
}

// Handle organization change
async function handleOrgChange() {
    const newOrgId = elements.orgSelector.value;
    if (newOrgId && newOrgId !== credentials.organizationId) {
        credentials.organizationId = newOrgId;
        await window.electronAPI.saveCredentials(credentials);
        // Refresh usage data with new org
        await fetchUsageData();
    }
}

// Initialize
async function init() {
    setupEventListeners();
    credentials = await window.electronAPI.getCredentials();

    // Apply saved theme and load thresholds immediately
    const settings = await window.electronAPI.getSettings();
    window._cachedSettings = settings;
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    // Restore compact mode from saved settings
    if (settings.compactMode) {
        applyCompactMode(true);
    } else {
        // Ensure compact overlay is hidden in normal mode
        if (elements.compactSettingsOverlay) elements.compactSettingsOverlay.style.display = 'none';
    }

    // Restore graph visibility
    if (settings.graphVisible) {
        if (!settings.compactMode) {
            // Normal mode — show graph immediately
            graphVisible = true;
            elements.graphBtn.classList.add('active');
            elements.graphSection.style.display = 'block';
        } else {
            // Compact mode — store so it restores when exiting compact
            graphWasVisible = true;
        }
    }

    // Restore expanded state
    if (settings.expandedOpen) {
        isExpanded = true;
        elements.expandArrow.classList.add('expanded');
        elements.expandSection.style.display = 'block';
    }

    if (credentials.sessionKey && credentials.organizationId) {
        // Populate org selector if user has multiple orgs
        if (credentials.organizations && credentials.organizations.length > 0) {
            populateOrgSelector(credentials.organizations, credentials.organizationId);
        }
        showMainContent();
        await fetchUsageData();
        startAutoUpdate();
    } else {
        showLoginRequired();
    }

    // Populate the version label shown in settings
    const version = await window.electronAPI.getAppVersion();
    if (elements.settingsVersionLabel) {
        elements.settingsVersionLabel.textContent = `Application Version: v${version}`;
    }

    // The system monitor is always on in both views, so it starts with the app
    // and runs for its lifetime. Same for the Claude service indicator.
    startSysmonPolling();
    startServiceStatusPolling();
    startCodexPolling();
    // The manual ChatGPT connect window nudges the rows the moment a token lands.
    window.electronAPI.onCodexRefresh(() => refreshCodexUsage());

    // Reflect docking that is already in effect (e.g. after a renderer reload),
    // and disable the control outright where the platform cannot support it.
    try {
        const bar = await window.electronAPI.getBarMode();
        if (bar) {
            elements.barModeToggle.checked = !!bar.enabled;
            elements.barModeToggle.disabled = !bar.supported;
            if (!bar.supported) {
                elements.barModeLabel.title = 'Windows only';
                elements.barModeCol.style.opacity = '0.5';
                elements.dockBtn.style.display = 'none';
            }
            if (bar.enabled) applyBarMode(true);
        }
    } catch { /* bar mode unsupported — stay in the normal layout */ }

    // Startup restore complete — allow _saveViewState to persist changes
    appInitializing = false;
}

// Event Listeners
function setupEventListeners() {
    // Step 1: Login via BrowserWindow
    elements.autoDetectBtn.addEventListener('click', handleAutoDetect);

    // Step navigation
    elements.nextStepBtn.addEventListener('click', () => {
        elements.loginStep1.style.display = 'none';
        elements.loginStep2.style.display = 'block';
        elements.sessionKeyInput.focus();
    });

    elements.backStepBtn.addEventListener('click', () => {
        elements.loginStep2.style.display = 'none';
        elements.loginStep1.style.display = 'flex';
        elements.sessionKeyError.textContent = '';
    });

    // Open browser link in step 2
    elements.openBrowserLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://claude.ai');
    });

    // Step 2: Manual sessionKey connect
    elements.connectBtn.addEventListener('click', handleConnect);
    elements.sessionKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleConnect();
        elements.sessionKeyError.textContent = '';
    });

    elements.refreshBtn.addEventListener('click', async () => {
        debugLog('Refresh button clicked');
        elements.refreshBtn.classList.add('spinning');
        await fetchUsageData();
        elements.refreshBtn.classList.remove('spinning');
    });

    elements.graphBtn.addEventListener('click', async () => {
        graphVisible = !graphVisible;
        elements.graphBtn.classList.toggle('active', graphVisible);
        elements.graphSection.style.display = graphVisible ? 'block' : 'none';
        if (graphVisible) {
            await loadChart();
        }
        if (!isCompactMode) resizeWidget();
        _saveViewState();
    });

    elements.dockBtn.addEventListener('click', async () => {
        // One-way: the title bar is hidden while docked, so undocking is the
        // bar's own button. Nothing here needs a toggle.
        await window.electronAPI.setBarMode(true);
    });

    elements.barRefreshBtn.addEventListener('click', async () => {
        // Same fetch the title-bar refresh runs; the bar has no title bar of
        // its own, so this is the only way to force a refresh while docked.
        elements.barRefreshBtn.classList.add('spinning');
        await fetchUsageData();
        elements.barRefreshBtn.classList.remove('spinning');
    });

    elements.barUndockBtn.addEventListener('click', () => {
        window.electronAPI.setBarMode(false);
    });

    // Every status indicator toggles the detail panel. Nothing in the widget
    // can act on an outage, so the affordance is "show me the details" — and
    // the details belong in the popup, not crammed into a 34px strip.
    for (const el of [elements.statusRow, elements.barStatusItem, elements.compactStatusItem]) {
        el.addEventListener('click', () => toggleStatusPanel(el));
    }

    elements.barModeToggle.addEventListener('change', async () => {
        const achieved = await window.electronAPI.setBarMode(elements.barModeToggle.checked);
        // Docking can be refused; snap the checkbox back to reality.
        elements.barModeToggle.checked = !!achieved;
    });

    // main.js is the source of truth for whether docking actually succeeded —
    // the shell can refuse — so the layout follows this event, never the click.
    window.electronAPI.onBarModeChanged((enabled) => applyBarMode(enabled));

    elements.minimizeBtn.addEventListener('click', () => {
        window.electronAPI.minimizeWindow();
    });

    elements.closeBtn.addEventListener('click', () => {
        window.electronAPI.closeWindow();
    });

    // Expand/collapse toggle
    elements.expandToggle.addEventListener('click', async () => {
        const wasExpanded = isExpanded;
        isExpanded = !isExpanded;
        elements.expandArrow.classList.toggle('expanded', isExpanded);
        elements.expandSection.style.display = isExpanded ? 'block' : 'none';
        if (graphVisible) {
            loadChart();
        }
        resizeWidget();
        
        // CRITICAL: Update expandedOpen setting IMMEDIATELY (no debounce) to prevent race condition
        // If we wait for the debounced save, auto-refresh might fetch with stale expandedOpen=false
        const settings = window._cachedSettings || await window.electronAPI.getSettings();
        settings.expandedOpen = isExpanded;
        window._cachedSettings = settings;
        await window.electronAPI.saveSettings(settings);
        
        // Trigger immediate fetch if panel was just opened (collapsed → expanded)
        // This ensures fresh overage/prepaid data is available when user expands the panel
        // Pass forceExtended to bypass any cached setting and fetch extended data immediately
        if (!wasExpanded && isExpanded) {
            debugLog('[Conditional Polling] Panel expanded - triggering immediate fetch with extended data');
            await fetchUsageData({ forceExtended: true });
        }
    });

    // Settings close
    elements.closeSettingsBtn.addEventListener('click', async () => {
        await saveSettings();
        elements.settingsOverlay.style.display = 'none';
        if (_settingsOpenedFromCompact) {
            _settingsOpenedFromCompact = false;
            if (isCompactMode) {
                window.electronAPI.setCompactMode(true);
            } else {
                resizeWidget();
            }
        } else if (!isCompactMode) {
            resizeWidget();
        }
        startAutoUpdate();
    });

    elements.logoutBtn.addEventListener('click', async () => {
        await window.electronAPI.deleteCredentials();
        credentials = { sessionKey: null, organizationId: null };
        elements.settingsOverlay.style.display = 'none';
        showLoginRequired();
    });

    // Connect / disconnect a ChatGPT account. Only shown when Codex's own
    // token is not already serving the Codex rows (renderChatGPTButton).
    elements.chatgptBtn.addEventListener('click', async () => {
        const state = await window.electronAPI.getChatGPTState();
        if (state.connected && !state.connectExpired) {
            if (!window.confirm('Disconnect ChatGPT?\n\nThe Codex rows will hide unless Codex is signed in on this PC.')) return;
            renderChatGPTButton(await window.electronAPI.disconnectChatGPT());
        } else {
            // Opens the real browser to sign in; resolves when the loopback
            // callback lands (or it times out). Show progress meanwhile.
            renderChatGPTButton({ codexToken: false, connecting: true });
            renderChatGPTButton(await window.electronAPI.connectChatGPT());
        }
        refreshCodexUsage();
    });

    // Theme buttons
    elements.themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.themeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyTheme(btn.dataset.theme);
        });
    });

    // Prevent accidental app hiding: bidirectional coupling between Hide from Taskbar and Show Tray Stats
    // If user enables "Hide from Taskbar", automatically enable "Show Tray Stats" (ensures tray icon is visible)
    elements.minimizeToTrayToggle.addEventListener('change', () => {
        if (elements.minimizeToTrayToggle.checked && !elements.showTrayStatsToggle.checked) {
            elements.showTrayStatsToggle.checked = true;
        }
    });

    // If user disables "Show Tray Stats", automatically disable "Hide from Taskbar" (prevents app from being completely hidden)
    elements.showTrayStatsToggle.addEventListener('change', () => {
        if (!elements.showTrayStatsToggle.checked && elements.minimizeToTrayToggle.checked) {
            elements.minimizeToTrayToggle.checked = false;
        }
    });

    // Listen for refresh requests from tray
    window.electronAPI.onRefreshUsage(async () => {
        if (elements.refreshBtn) elements.refreshBtn.classList.add('spinning');
        await fetchUsageData();
        if (elements.refreshBtn) elements.refreshBtn.classList.remove('spinning');
    });

    // Listen for session expiration events (403 errors)
    window.electronAPI.onSessionExpired(() => {
        debugLog('Session expired event received');
        credentials = { sessionKey: null, organizationId: null };
        showLoginRequired();
    });

    // Compact mode — collapse chevron (normal → compact)
    elements.compactCollapseBtn.addEventListener('click', async () => {
        applyCompactMode(true);
        await _saveCompactSetting(true);
    });

    // Compact mode — expand chevron (compact → normal)
    elements.compactExpandBtn.addEventListener('click', async () => {
        applyCompactMode(false);
        await _saveCompactSetting(false);
    });

    // Compact mode toggle in normal settings panel — deferred to Done click

    // Compact mode toggle in compact settings panel — just updates the checkbox, Done applies it
    elements.compactModeToggleCompact.addEventListener('change', () => {
        // No immediate action — Done button reads this value and applies
    });

    // Organization selector — change triggers immediate save and refresh
    elements.orgSelector.addEventListener('change', handleOrgChange);

    // Settings button — always open full settings; if in compact mode, temporarily expand the window first
    elements.settingsBtn.addEventListener('click', async () => {
        stopAutoUpdate();
        if (isCompactMode) {
            _settingsOpenedFromCompact = true;
            window.electronAPI.setCompactMode(false);
        }
        await loadSettings();
        elements.settingsOverlay.style.display = 'flex';
        window.electronAPI.resizeWindow(318);
    });

    // Close compact settings — apply compact toggle value then close
    elements.closeCompactSettingsBtn.addEventListener('click', async () => {
        const compact = elements.compactModeToggleCompact.checked;
        if (compact !== isCompactMode) {
            applyCompactMode(compact);
            await _saveCompactSetting(compact);
        }
        elements.compactSettingsOverlay.style.display = 'none';
        startAutoUpdate();
    });
}

// Handle manual sessionKey connect
async function handleConnect() {
    const sessionKey = elements.sessionKeyInput.value.trim();
    if (!sessionKey) {
        elements.sessionKeyError.textContent = 'Please paste your session key';
        return;
    }

    elements.connectBtn.disabled = true;
    elements.connectBtn.textContent = '...';
    elements.sessionKeyError.textContent = '';

    try {
        const result = await window.electronAPI.validateSessionKey(sessionKey);
        if (result.success) {
            credentials = { 
                sessionKey, 
                organizationId: result.organizationId,
                organizations: result.organizations || []
            };
            await window.electronAPI.saveCredentials(credentials);
            populateOrgSelector(result.organizations || [], result.organizationId);
            elements.sessionKeyInput.value = '';
            showMainContent();
            await fetchUsageData();
            startAutoUpdate();
        } else {
            elements.sessionKeyError.textContent = result.error || 'Invalid session key';
        }
    } catch (error) {
        elements.sessionKeyError.textContent = 'Connection failed. Check your key.';
    } finally {
        elements.connectBtn.disabled = false;
        elements.connectBtn.textContent = 'Connect';
    }
}

// Handle auto-detect from browser cookies
async function handleAutoDetect() {
    elements.autoDetectBtn.disabled = true;
    elements.autoDetectBtn.textContent = 'Waiting...';
    elements.autoDetectError.textContent = '';

    try {
        const result = await window.electronAPI.detectSessionKey();
        if (!result.success) {
            elements.autoDetectError.textContent = result.error || 'Login failed';
            return;
        }

        // Got sessionKey from login, now validate it
        elements.autoDetectBtn.textContent = 'Validating...';
        const validation = await window.electronAPI.validateSessionKey(result.sessionKey);

        if (validation.success) {
            credentials = {
                sessionKey: result.sessionKey,
                organizationId: validation.organizationId,
                organizations: validation.organizations || []
            };
            await window.electronAPI.saveCredentials(credentials);
            populateOrgSelector(validation.organizations || [], validation.organizationId);
            showMainContent();
            await fetchUsageData();
            startAutoUpdate();
        } else {
            elements.autoDetectError.textContent =
                'Session invalid. Try again or use Manual →';
        }
    } catch (error) {
        elements.autoDetectError.textContent = error.message || 'Login failed';
    } finally {
        elements.autoDetectBtn.disabled = false;
        elements.autoDetectBtn.textContent = 'Log in';
    }
}

// Fetch usage data from Claude API
async function fetchUsageData(options = {}) {
    debugLog('fetchUsageData called');

    if (isFetching) {
        debugLog('Fetch already in flight — skipping');
        return;
    }

    if (!credentials.sessionKey || !credentials.organizationId) {
        debugLog('Missing credentials, showing login');
        showLoginRequired();
        return;
    }

    isFetching = true;
    try {
        debugLog('Calling electronAPI.fetchUsageData...');
        const data = await window.electronAPI.fetchUsageData(options);
        debugLog('Received usage data:', data);
        updateUI(data);
    } catch (error) {
        console.error('Error fetching usage data:', error);
        if (error.message.includes('SessionExpired') || error.message.includes('Unauthorized')) {
            credentials = { sessionKey: null, organizationId: null };
            showLoginRequired();
        } else {
            debugLog('Failed to fetch usage data');
        }
    } finally {
        isFetching = false;
    }
}


// Update UI with usage data
// Format a cent-based amount with the correct currency symbol.
// Known unambiguous symbols are used; everything else falls back to the
// ISO 4217 code as a suffix so the display is always correct.
function formatCurrency(amountCents, currencyCode) {
  const amount = (amountCents / 100).toFixed(2);
  const symbols = { USD: '$', EUR: '€', GBP: '£' };
  const sym = symbols[currencyCode];
  return sym ? `${sym}${amount}` : `${amount} ${currencyCode || 'USD'}`;
}

// Extra row label mapping for API fields
const EXTRA_ROW_CONFIG = {
    seven_day_sonnet: { label: 'Sonnet (7d)', color: 'sonnet' },
    seven_day_opus: { label: 'Opus (7d)', color: 'opus' },
    seven_day_fable: { label: 'Fable (7d)', color: 'fable' },
    seven_day_cowork: { label: 'Cowork (7d)', color: 'cowork' },
    seven_day_omelette: { label: 'Design (7d)', color: 'design' },
    seven_day_oauth_apps: { label: 'OAuth Apps (7d)', color: 'oauth' },
};

// Expiry warning thresholds for the credits row (days until next_expires_at)
const CREDIT_EXPIRY_WARN_DAYS = 21;
const CREDIT_EXPIRY_DANGER_DAYS = 7;

// Builds the credit-balance row shown beneath Monthly Spend.
// Promo/paid split renders only when purchased credits exist (money at risk);
// the expiry chip renders only when the next expiry is within the warn window.
function buildCreditsRow(value) {
    const row = document.createElement('div');
    row.className = 'usage-section credits-row';

    const label = document.createElement('span');
    label.className = 'usage-label credits-label';
    // Invisible clone of the spend row's ON/OFF badge so "Credits" aligns
    // with "Monthly Spend" regardless of badge width
    if (value.is_enabled === true || value.is_enabled === false) {
        const spacer = document.createElement('span');
        spacer.className = 'extra-status badge-spacer';
        spacer.textContent = value.is_enabled ? 'ON' : 'OFF';
        label.appendChild(spacer);
    }
    label.appendChild(document.createTextNode(' Credits'));
    row.appendChild(label);

    const amount = document.createElement('span');
    amount.className = 'credits-amount';
    amount.textContent = formatCurrency(value.balance_cents, value.currency);
    row.appendChild(amount);

    if (typeof value.paid_cents === 'number' && value.paid_cents > 0) {
        const split = document.createElement('span');
        split.className = 'credits-split';
        split.textContent = `promo ${formatCurrency(value.promo_cents || 0, value.currency)} / paid ${formatCurrency(value.paid_cents, value.currency)}`;
        row.appendChild(split);
    }

    if (value.next_expires_at && typeof value.next_expiry_cents === 'number' && value.next_expiry_cents > 0) {
        const daysLeft = Math.ceil((new Date(value.next_expires_at).getTime() - Date.now()) / 86400000);
        if (daysLeft >= 0 && daysLeft <= CREDIT_EXPIRY_WARN_DAYS) {
            const chip = document.createElement('span');
            chip.className = 'credits-chip' + (daysLeft <= CREDIT_EXPIRY_DANGER_DAYS ? ' danger' : '');
            const when = daysLeft <= CREDIT_EXPIRY_DANGER_DAYS
                ? `in ${daysLeft}d`
                : new Date(value.next_expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            chip.textContent = `${formatCurrency(value.next_expiry_cents, value.currency)} expires ${when}`;
            chip.title = `Expires ${new Date(value.next_expires_at).toLocaleDateString()}`;
            row.appendChild(chip);
        }
    }

    return row;
}

function buildExtraRows(data) {

    // Don't clear existing rows if we don't have new data to replace them with
    // This preserves the last known state when expanding the panel
    const hasAnyExtendedData = Object.entries(EXTRA_ROW_CONFIG).some(([key, config]) => {
        const value = data[key];
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        return hasUtilization || hasBalance;
    });
    
    // Only rebuild if we have data, otherwise keep existing rows
    if (!hasAnyExtendedData && elements.extraRows.children.length > 0) {
        return; // Keep existing rows
    }
    
    elements.extraRows.innerHTML = '';
    let count = 0;

    for (const [key, config] of Object.entries(EXTRA_ROW_CONFIG)) {
        const value = data[key];
        // extra_usage is valid with utilization OR balance_cents (prepaid only)
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        if (!hasUtilization && !hasBalance) continue;

        const utilization = value.utilization || 0;
        const resetsAt = value.resets_at;
        const colorClass = config.color;

        const row = document.createElement('div');
        row.className = 'usage-section';

        // Build row using DOM methods (no innerHTML)
        const label = document.createElement('span');
        label.className = 'usage-label';
        
        if (key === 'extra_usage') {
            // Extra usage: ON/OFF indicator goes next to label
            if (value.is_enabled === true) {
                const statusTag = document.createElement('span');
                statusTag.className = 'extra-status on';
                statusTag.textContent = 'ON';
                label.appendChild(statusTag);
            } else if (value.is_enabled === false) {
                const statusTag = document.createElement('span');
                statusTag.className = 'extra-status off';
                statusTag.textContent = 'OFF';
                label.appendChild(statusTag);
            }
            label.appendChild(document.createTextNode(' Monthly Spend'));
        } else {
            label.textContent = config.label;
        }
        row.appendChild(label);

        if (key === 'extra_usage') {
            // Spend row uses flex (like the credits row): label | stretching bar | right-flush $ text
            row.classList.add('spend-row');
            const barGroup = document.createElement('div');
            barGroup.className = 'usage-bar-group spend-bar-group';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = `progress-fill ${colorClass}`;
            progressFill.style.width = `${Math.min(utilization, 100)}%`;

            // Apply warning/danger thresholds to extra usage bar
            if (utilization >= dangerThreshold) {
                progressFill.classList.add('danger');
            } else if (utilization >= warnThreshold) {
                progressFill.classList.add('warning');
            }
            
            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);
            row.appendChild(barGroup);

            // Dollar text lives in the (now empty) timer+resets columns so the
            // bar keeps the full bar-column width like the session/weekly rows
            const spendText = document.createElement('span');
            if (value.used_cents != null && value.limit_cents != null) {
                spendText.className = 'usage-percentage extra-spending spend-cap-text';
                let limitStr = formatCurrency(value.limit_cents, value.currency);
                if (value.limit_cents % 100 === 0) limitStr = limitStr.replace('.00', '');
                spendText.textContent = `${formatCurrency(value.used_cents, value.currency)}/${limitStr} cap`;
            } else {
                spendText.className = 'usage-percentage spend-cap-text';
                spendText.textContent = `${Math.round(utilization)}%`;
            }
            row.appendChild(spendText);
        } else {
            const totalMinutes = key.includes('seven_day') ? 7 * 24 * 60 : 5 * 60;

            const barGroup = document.createElement('div');
            barGroup.className = 'usage-bar-group';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = `progress-fill ${colorClass}`;
            progressFill.style.width = `${Math.min(utilization, 100)}%`;
            // Apply warning/danger thresholds — same check the spend row and
            // compact mode already use, previously missing here so every
            // model row (Sonnet, Opus, Fable, etc.) rendered flat regardless
            // of usage level.
            if (utilization >= dangerThreshold) {
                progressFill.classList.add('danger');
            } else if (utilization >= warnThreshold) {
                progressFill.classList.add('warning');
            }
            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);

            const percentage = document.createElement('span');
            percentage.className = 'usage-percentage';
            percentage.textContent = `${Math.round(utilization)}%`;
            barGroup.appendChild(percentage);
            row.appendChild(barGroup);

            const elapsedGroup = document.createElement('div');
            elapsedGroup.className = 'usage-elapsed-group';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'mini-timer');
            svg.setAttribute('width', '24');
            svg.setAttribute('height', '24');
            svg.setAttribute('viewBox', '0 0 24 24');
            const circleBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circleBg.setAttribute('class', 'timer-bg');
            circleBg.setAttribute('cx', '12');
            circleBg.setAttribute('cy', '12');
            circleBg.setAttribute('r', '10');
            svg.appendChild(circleBg);
            const circleProgress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circleProgress.setAttribute('class', `timer-progress ${colorClass}`);
            circleProgress.setAttribute('cx', '12');
            circleProgress.setAttribute('cy', '12');
            circleProgress.setAttribute('r', '10');
            circleProgress.style.strokeDasharray = '63';
            circleProgress.style.strokeDashoffset = '63';
            svg.appendChild(circleProgress);
            elapsedGroup.appendChild(svg);
            row.appendChild(elapsedGroup);

            const timerText = document.createElement('div');
            timerText.className = 'timer-text';
            timerText.dataset.resets = resetsAt || '';
            timerText.dataset.total = totalMinutes;
            timerText.textContent = '--:--';
            row.appendChild(timerText);

            const resetsText = document.createElement('span');
            resetsText.className = 'resets-at-text';
            if (resetsAt) {
                const settings = window._cachedSettings || {};
                resetsText.textContent = formatResetsAt(resetsAt, true, settings.timeFormat || '12h', settings.weeklyDateFormat || 'date');
            }
            row.appendChild(resetsText);
        }

        elements.extraRows.appendChild(row);
        count++;

        // Credit balance gets its own row beneath Monthly Spend
        if (key === 'extra_usage' && value.balance_cents != null) {
            elements.extraRows.appendChild(buildCreditsRow(value));
            count++;
        }
    }

    // Hide toggle if no extra rows
    elements.expandToggle.style.display = count > 0 ? 'flex' : 'none';
    if (count === 0 && isExpanded) {
        isExpanded = false;
        elements.expandArrow.classList.remove('expanded');
        elements.expandSection.style.display = 'none';
    }

    return count;
}

function refreshExtraTimers() {
    // Pair each row's timer text with its own circle. Pairing the two
    // querySelectorAll lists by index breaks as soon as a row has a text but
    // no circle (the extra_usage row), which shifts every later row's circle
    // and leaves those timers stuck at --:--.
    elements.extraRows.querySelectorAll('.usage-section').forEach((row) => {
        const textEl = row.querySelector('.timer-text');
        const circleEl = row.querySelector('.timer-progress');
        if (!textEl || !circleEl) return;
        const resetsAt = textEl.dataset.resets;
        const totalMinutes = parseInt(textEl.dataset.total);
        if (resetsAt) {
            updateTimer(circleEl, textEl, resetsAt, totalMinutes);
        }
    });
}

// --- System monitor rendering -------------------------------------------------

function formatGB(bytes) {
    return (bytes / 1073741824).toFixed(1) + ' GB';
}

/**
 * Paint one monitor row. Passing percent === null renders the row as having no
 * reading (dashes, empty bar) rather than showing a misleading 0%.
 */
function renderSysmonRow(fillEl, pctEl, detailEl, percent, detailText) {
    const row = fillEl.closest('.sysmon-row');
    const hasValue = percent !== null && percent !== undefined && !Number.isNaN(percent);

    if (row) row.classList.toggle('unavailable', !hasValue);
    fillEl.style.width = hasValue ? Math.min(100, Math.max(0, percent)) + '%' : '0%';
    fillEl.classList.toggle('hot', hasValue && percent >= SYSMON_HOT_THRESHOLD);
    pctEl.textContent = hasValue ? Math.round(percent) + '%' : '--';
    detailEl.textContent = detailText || '--';
}

/**
 * Paint one value in the compact strip. Compact has no bars, so "hot" shows as
 * a red number instead of a red meter.
 */
function renderCompactSysVal(el, percent, tooltip) {
    const hasValue = percent !== null && percent !== undefined && !Number.isNaN(percent);
    el.textContent = hasValue ? Math.round(percent) + '%' : '--';
    el.classList.toggle('hot', hasValue && percent >= SYSMON_HOT_THRESHOLD);
    el.classList.toggle('unavailable', !hasValue);
    if (tooltip) el.parentElement.title = tooltip;
}

/** Paint one meter+value pair in the docked bar. */
function renderBarItem(fillEl, valEl, percent, suffix = '%') {
    const has = percent !== null && percent !== undefined && !Number.isNaN(percent);
    fillEl.style.width = has ? Math.min(100, Math.max(0, percent)) + '%' : '0%';
    fillEl.classList.toggle('hot', has && percent >= SYSMON_HOT_THRESHOLD);
    valEl.textContent = has ? Math.round(percent) + suffix : '--';
    valEl.classList.toggle('hot', has && percent >= SYSMON_HOT_THRESHOLD);
    valEl.classList.toggle('unavailable', !has);
}

/**
 * Bar mode replaces the whole widget chrome rather than sitting inside it, so
 * this swaps the body class and lets CSS hide the normal/compact views.
 */
function applyBarMode(enabled) {
    isBarMode = enabled;
    document.body.classList.toggle('bar-mode', enabled);
    elements.barContent.style.display = enabled ? 'flex' : 'none';
    if (enabled) {
        refreshSystemStats();
        if (latestUsageData) updateBarUsage(latestUsageData);
        return;
    }

    // Coming back from the bar: main.js restored the pre-dock position but can
    // only guess the height, since the real one depends on which sections are
    // open. isBarMode is already false here, so resizeWidget is live again.
    if (isCompactMode) {
        window.electronAPI.setCompactMode(true);
    } else {
        resizeWidget();
    }
    refreshSystemStats();
}

/** Claude-side values in the docked bar. */
function updateBarUsage(data) {
    if (!data) return;
    renderBarItem(elements.barSessionFill, elements.barSessionPct,
        Math.min(Math.max(data.five_hour?.utilization || 0, 0), 100));
    renderBarItem(elements.barWeeklyFill, elements.barWeeklyPct,
        Math.min(Math.max(data.seven_day?.utilization || 0, 0), 100));
    // Fable draws on its own weekly pool, and only accounts that have one get
    // the field at all — same rule the compact view uses, so the item drops
    // out of the strip entirely rather than sitting there at 0%.
    if (data.seven_day_fable) {
        elements.barFableItem.style.display = '';
        renderBarItem(elements.barFableFill, elements.barFablePct,
            Math.min(Math.max(data.seven_day_fable.utilization || 0, 0), 100));
    } else {
        elements.barFableItem.style.display = 'none';
    }
    // The session countdown is already rendered for the normal view; mirror
    // its text rather than recomputing the same value a second way.
    elements.barResetsIn.textContent = elements.sessionTimeText.textContent || '--:--';
}

async function refreshSystemStats() {
    let stats;
    try {
        stats = await window.electronAPI.getSystemStats();
    } catch (err) {
        console.warn('System stats unavailable:', err);
        return;
    }
    if (!stats) return;

    // CPU
    renderSysmonRow(
        elements.cpuFill, elements.cpuPct, elements.cpuDetail,
        stats.cpu.percent,
        stats.cpu.cores ? stats.cpu.cores + ' threads' : null
    );
    // The full model string is too long for the row, so it lives in the tooltip.
    if (stats.cpu.model) elements.cpuLabel.title = stats.cpu.model;

    // GPU + VRAM. Both rows come from the same nvidia-smi sample, so when the
    // GPU is unavailable they blank together rather than one going stale.
    const gpu = stats.gpu || { available: false };
    if (gpu.available) {
        renderSysmonRow(
            elements.gpuFill, elements.gpuPct, elements.gpuDetail,
            gpu.percent,
            gpu.tempC !== null && gpu.tempC !== undefined ? gpu.tempC + '°C' : null
        );
        renderSysmonRow(
            elements.vramFill, elements.vramPct, elements.vramDetail,
            gpu.memPercent,
            (gpu.memUsedMB / 1024).toFixed(1) + ' / ' + (gpu.memTotalMB / 1024).toFixed(1) + ' GB'
        );
    } else {
        renderSysmonRow(elements.gpuFill, elements.gpuPct, elements.gpuDetail, null, 'n/a');
        renderSysmonRow(elements.vramFill, elements.vramPct, elements.vramDetail, null, 'n/a');
        elements.gpuLabel.title = gpu.reason ? 'GPU: ' + gpu.reason : 'GPU';
    }

    // System RAM
    renderSysmonRow(
        elements.ramFill, elements.ramPct, elements.ramDetail,
        stats.memory.percent,
        formatGB(stats.memory.usedBytes) + ' / ' + formatGB(stats.memory.totalBytes)
    );

    // Compact strip. VRAM has no slot of its own here, so it rides along in the
    // GPU item's tooltip rather than being dropped entirely.
    renderCompactSysVal(
        elements.compactCpuPct, stats.cpu.percent,
        stats.cpu.model || 'CPU'
    );
    renderCompactSysVal(
        elements.compactGpuPct, gpu.available ? gpu.percent : null,
        gpu.available
            ? 'VRAM ' + (gpu.memUsedMB / 1024).toFixed(1) + ' / ' + (gpu.memTotalMB / 1024).toFixed(1) + ' GB'
              + (gpu.tempC !== null && gpu.tempC !== undefined ? '  ·  ' + gpu.tempC + '°C' : '')
            : (gpu.reason ? 'GPU: ' + gpu.reason : 'GPU')
    );
    renderCompactSysVal(
        elements.compactRamPct, stats.memory.percent,
        formatGB(stats.memory.usedBytes) + ' / ' + formatGB(stats.memory.totalBytes)
    );

    // Docked bar
    renderBarItem(elements.barCpuFill, elements.barCpuPct, stats.cpu.percent);
    renderBarItem(elements.barGpuFill, elements.barGpuPct, gpu.available ? gpu.percent : null);
    renderBarItem(elements.barVramFill, elements.barVramPct, gpu.available ? gpu.memPercent : null);
    renderBarItem(elements.barRamFill, elements.barRamPct, stats.memory.percent);
}

/** Runs for the app's lifetime — both views always display these stats. */
function startSysmonPolling() {
    if (sysmonTimer) return;
    refreshSystemStats();
    sysmonTimer = setInterval(refreshSystemStats, SYSMON_INTERVAL);
}

// --- Claude service status ----------------------------------------------------

/**
 * Paint the indicator in all three views from a single main-process snapshot.
 * Level 'unknown' is rendered as grey and says so, rather than falling back to
 * an optimistic green — the same rule the system monitor uses for a missing
 * reading.
 */
function renderServiceStatus(status) {
    if (!status) return;

    const components = status.components || [];
    const incidents = status.incidents || [];
    const failing = components.filter((c) => c.level !== 'ok');

    // One tooltip for every view: it is where the detail the collapsed views
    // drop has to end up, so it is built once and shared.
    const lines = components.map((c) => `${c.label}: ${c.statusText}`);
    for (const inc of incidents) lines.push('— ' + inc.name);
    if (status.error) lines.push('(' + status.error + ')');
    lines.push('Click to open status.claude.com');
    const tooltip = lines.join('\n');

    // Widget row: a chip per component, then a one-line summary on the right.
    elements.statusChips.replaceChildren(...components.map((c) => {
        const chip = document.createElement('span');
        chip.className = 'status-chip';
        chip.title = `${c.label}: ${c.statusText}`;
        const dot = document.createElement('span');
        dot.className = 'status-dot ' + c.level;
        chip.append(dot, document.createTextNode(c.short));
        return chip;
    }));
    // An incident title says more than the component state it produced, so it
    // takes the summary slot whenever there is one.
    elements.statusText.textContent = incidents.length && status.level !== 'ok'
        ? incidents[0].name
        : status.overallText;
    elements.statusText.className = 'status-text ' + status.level;
    elements.statusRow.title = tooltip;

    // Compact strip and docked bar: one dot for the worst of the three.
    elements.compactStatusDot.className = 'status-dot ' + status.level;
    elements.compactStatusItem.title = tooltip;
    elements.barStatusDot.className = 'status-dot ' + status.level;
    elements.barStatusItem.title = tooltip;

    // Naming the affected service costs ~40px of a strip that has none to
    // spare, so the bar's label appears only while something is actually
    // wrong, and collapses to a count once more than one service is involved.
    let barLabel = '';
    if (status.level === 'unknown') barLabel = 'status?';
    else if (failing.length === 1) barLabel = failing[0].short;
    else if (failing.length > 1) barLabel = failing.length + ' services';
    elements.barStatusText.textContent = barLabel;
    elements.barStatusText.className = 'bar-status-text ' + status.level;
    elements.barStatusText.style.display = barLabel ? '' : 'none';
}

/**
 * Open (or close) the detail popup, anchored to whichever indicator was
 * clicked. The anchor goes over as the element's own CSS-pixel rect; the main
 * process turns it into a screen position, since only it knows where the window
 * sits and which display it is on.
 *
 * The theme rides along because the panel is a separate window with no access
 * to the settings store.
 */
function toggleStatusPanel(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    window.electronAPI.toggleStatusPanel({
        anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
        theme: document.body.classList.contains('theme-light') ? 'light' : 'dark',
    });
}

async function refreshServiceStatus() {
    try {
        renderServiceStatus(await window.electronAPI.getServiceStatus());
    } catch (err) {
        console.warn('Service status unavailable:', err);
    }
}

/**
 * Runs for the app's lifetime — every view carries this indicator, and unlike
 * usage data it costs nothing to keep current: main.js owns the network poll
 * and answers from cache.
 */
function startServiceStatusPolling() {
    if (statusTimer) return;
    refreshServiceStatus();
    statusTimer = setInterval(refreshServiceStatus, STATUS_INTERVAL);
}
// --- OpenAI Codex plan limits ------------------------------------------------

/** One Codex row in the widget, painted with the same helpers as Claude's. */
function renderCodexRow(win, progressEl, pctEl, timerEl, timeTextEl, resetsAtEl,
                        isWeekly, fallbackMinutes, timeFormat, weeklyDateFormat) {
    const resetsAt = win && win.resetsAt ? win.resetsAt : null;
    updateProgressBar(progressEl, pctEl, win ? win.usedPercent : 0);
    updateTimer(timerEl, timeTextEl, resetsAt, (win && win.windowMinutes) || fallbackMinutes);
    resetsAtEl.textContent = formatResetsAt(resetsAt, isWeekly, timeFormat, weeklyDateFormat);
    resetsAtEl.style.opacity = resetsAt ? '1' : '0.4';
}

/** One half of the split Codex row in compact mode. */
function renderCompactCodex(fillEl, pctEl, win, tag, fillClass) {
    const pct = win ? win.usedPercent : 0;
    fillEl.style.width = `${pct}%`;
    pctEl.textContent = `${tag} ${Math.round(pct)}%`;
    fillEl.className = 'compact-bar-fill ' + fillClass;
    if (pct >= dangerThreshold) fillEl.classList.add('danger');
    else if (pct >= warnThreshold) fillEl.classList.add('warning');
}

/**
 * Paint the Codex rows in all three views from one main-process snapshot.
 *
 * Hidden outright when there is nothing to show — no Codex on this machine,
 * or no turn recorded yet — rather than parked at 0%: the rule the Fable rows
 * follow, and why a clone on a machine without Codex looks as it did before.
 */
function renderCodexUsage(usage) {
    // Keep the Settings button in step with the account state every poll.
    if (usage && usage.account) renderChatGPTButton(usage.account);

    const visible = !!(usage && usage.available);
    const changed = visible !== (latestCodexUsage !== null);
    latestCodexUsage = visible ? usage : null;

    elements.codexSection.style.display = visible ? '' : 'none';
    elements.compactCodexRow.style.display = visible ? '' : 'none';
    elements.barCodexGroup.style.display = visible ? '' : 'none';
    // The docked strip's narrow tiers budget for the group only while it is up.
    document.body.classList.toggle('has-codex', visible);

    if (changed) {
        // Both window heights are sums of fixed sections, so a section coming
        // or going has to be told to whichever layout is live. Either call
        // no-ops while docked.
        if (isCompactMode) window.electronAPI.setCompactMode(true);
        else resizeWidget();
    }
    if (!visible) return;

    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    renderCodexRow(usage.session, elements.codexSessionProgress, elements.codexSessionPercentage,
        elements.codexSessionTimer, elements.codexSessionTimeText, elements.codexSessionResetsAt,
        false, 5 * 60, timeFormat, weeklyDateFormat);
    renderCodexRow(usage.weekly, elements.codexWeeklyProgress, elements.codexWeeklyPercentage,
        elements.codexWeeklyTimer, elements.codexWeeklyTimeText, elements.codexWeeklyResetsAt,
        true, 7 * 24 * 60, timeFormat, weeklyDateFormat);

    renderCompactCodex(elements.compactCodexSessionFill, elements.compactCodexSessionPct,
        usage.session, '5h', 'codex');
    renderCompactCodex(elements.compactCodexWeeklyFill, elements.compactCodexWeeklyPct,
        usage.weekly, 'Wk', 'codex-weekly');

    renderBarItem(elements.barCodexSessionFill, elements.barCodexSessionPct,
        usage.session ? usage.session.usedPercent : null);
    renderBarItem(elements.barCodexWeeklyFill, elements.barCodexWeeklyPct,
        usage.weekly ? usage.weekly.usedPercent : null);

    // The numbers are only as fresh as the last Codex turn on this machine,
    // which nothing else on screen can say, so every view's tooltip does.
    const plan = usage.plan ? ` (${usage.plan[0].toUpperCase()}${usage.plan.slice(1)} plan)` : '';
    const asOf = usage.capturedAt
        ? formatResetsAt(usage.capturedAt, true, timeFormat, 'date-day-time')
        : 'unknown';
    const lines = ['OpenAI Codex' + plan];
    if (usage.source === 'chatgpt') {
        const via = (usage.account && usage.account.source === 'account')
            ? 'via your connected ChatGPT account'
            : 'via the Codex sign-in on this PC';
        lines.push('Live from chatgpt.com (' + via + '), checked ' + asOf);
        lines.push('Includes use on other devices and the web.');
    } else {
        lines.push('As of the last Codex turn on this PC: ' + asOf);
        const account = usage.account || {};
        if (account.connectExpired) {
            lines.push('ChatGPT sign-in expired — reconnect in Settings.');
        } else if (!account.codexToken && !account.connected) {
            lines.push('Connect ChatGPT in Settings to include other devices.');
        }
    }
    if (usage.error) lines.push('(' + usage.error + ')');
    const tooltip = lines.join('\n');
    elements.codexSection.title = tooltip;
    elements.compactCodexRow.title = tooltip;
    elements.barCodexGroup.title = tooltip;
}

/**
 * The Settings-footer ChatGPT button. Hidden entirely when Codex's own token
 * already serves the rows — there is nothing to connect. Otherwise it offers
 * to connect, reconnect (session lapsed), or disconnect (currently connected).
 */
function renderChatGPTButton(state) {
    const btn = elements.chatgptBtn;
    if (!btn || !state) return;
    // Codex token covers it: no account to manage here.
    if (state.codexToken) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    const live = state.connected && !state.connectExpired;
    btn.disabled = !!state.connecting;
    btn.classList.toggle('connected', live);
    btn.classList.toggle('expired', state.connected && state.connectExpired);
    if (state.connecting) btn.textContent = 'Connecting…';
    else if (live) btn.textContent = 'ChatGPT connected';
    else if (state.connected && state.connectExpired) btn.textContent = 'Reconnect ChatGPT';
    else btn.textContent = 'Connect ChatGPT';
    btn.title = live
        ? 'Codex limits come live from your ChatGPT account. Click to disconnect.'
        : (state.connected && state.connectExpired)
            ? 'The ChatGPT sign-in expired. Click to sign in again.'
            : 'Sign in to ChatGPT in your browser so Codex limits show here without running Codex.';
}

async function refreshCodexUsage() {
    try {
        renderCodexUsage(await window.electronAPI.getCodexUsage());
    } catch (err) {
        console.warn('Codex usage unavailable:', err);
    }
}

/**
 * Runs for the app's lifetime. main.js owns the file reads and answers from
 * cache; the poll here also keeps the countdown text moving.
 */
function startCodexPolling() {
    if (codexTimer) return;
    refreshCodexUsage();
    codexTimer = setInterval(refreshCodexUsage, CODEX_INTERVAL);
}

const EXPAND_OVERHEAD = 28; // margin-top(12) + padding-top(6) + bottom buffer(10)

function resizeWidget() {
    // The docked bar's size is fixed by the appbar reservation.
    if (isBarMode) return;
    const extraCount = elements.extraRows.children.length;
    const expandedOffset = isExpanded && extraCount > 0
        ? EXPAND_OVERHEAD + (extraCount * WIDGET_ROW_HEIGHT)
        : 0;
    const graphOffset = graphVisible ? GRAPH_HEIGHT : 0;
    const sysmonOffset = SYSMON_HEIGHT; // always shown
    const statusOffset = STATUS_HEIGHT; // always shown, one fixed row
    const codexOffset = latestCodexUsage ? CODEX_HEIGHT : 0; // only with Codex usage
    const totalHeight = WIDGET_HEIGHT_COLLAPSED + expandedOffset + graphOffset
        + sysmonOffset + statusOffset + codexOffset;
    window.electronAPI.resizeWindow(totalHeight);
}

function normalizeUsageData(data) {
    // The synthetic seven_day_<name> fields for scoped weekly limits (e.g.
    // Fable) are produced centrally in main.js (normalize-usage-limits.js), so
    // `data` already carries them here. This renderer step only ensures every
    // scoped model has a matching EXTRA_ROW_CONFIG entry: statically known
    // models (Fable) already do; any unknown model is registered generically
    // (label "<DisplayName> (7d)", fallback color).
    for (const limit of (data && data.limits) || []) {
        if (!limit || limit.kind !== 'weekly_scoped' || limit.percent == null) continue;
        const displayName = limit.scope && limit.scope.model && limit.scope.model.display_name;
        if (!displayName) continue;
        const key = 'seven_day_' + String(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (EXTRA_ROW_CONFIG[key]) continue; // already known (e.g. seven_day_fable)
        EXTRA_ROW_CONFIG[key] = { label: `${displayName} (7d)`, color: 'scoped' };
    }
    return data;
}

function updateUI(data) {
    latestUsageData = normalizeUsageData(data);

    showMainContent();
    buildExtraRows(data);
    refreshTimers();
    if (isExpanded) refreshExtraTimers();
    if (!isCompactMode) resizeWidget();
    startCountdown();
    if (graphVisible) {
        loadChart();
    }

    // Update compact bars in parallel if compact mode is active
    if (isCompactMode) updateCompactBars(data);
    if (isBarMode) updateBarUsage(data);

    // On first load, seed alert flags so we don't fire for thresholds
    // the user can already see when the app starts
    if (isFirstDataLoad) {
        isFirstDataLoad = false;
        seedAlertFlags(data);
    }

    checkUsageAlerts(data);
}

// Fire OS desktop notifications when usage crosses warn/danger thresholds.
// Only fires once per threshold crossing per session window — not on every refresh.
function checkUsageAlerts(data) {
    const settings = window._cachedSettings || {};
    if (!settings.usageAlerts) return;

    const sessionPct = data.five_hour?.utilization || 0;
    const weeklyPct = data.seven_day?.utilization || 0;

    // Reset alert flags when a session window resets (utilization drops back low)
    if (sessionPct < warnThreshold) {
        alertFired.session_warn = false;
        alertFired.session_danger = false;
    }
    if (weeklyPct < warnThreshold) {
        alertFired.weekly_warn = false;
        alertFired.weekly_danger = false;
    }

    // Current Session — danger threshold (check first, higher priority)
    // Capped below 100 so the dedicated "limit reached" notification owns that moment exclusively
    if (sessionPct >= dangerThreshold && sessionPct < 100 && !alertFired.session_danger) {
        alertFired.session_danger = true;
        alertFired.session_warn = true; // suppress warn if we jumped straight to danger
        window.electronAPI.showNotification(
            'Claude Usage Widget',
            `Current Session usage is at ${Math.round(sessionPct)}% — usage is extremely low`
        );
    // Current Session — warn threshold
    } else if (sessionPct >= warnThreshold && sessionPct < 100 && !alertFired.session_warn) {
        alertFired.session_warn = true;
        window.electronAPI.showNotification(
            'Claude Usage Widget',
            `Current Session usage is at ${Math.round(sessionPct)}% — usage is low`
        );
    }

    // Weekly Limit — danger threshold
    // Capped below 100 so the dedicated "limit reached" notification owns that moment exclusively
    if (weeklyPct >= dangerThreshold && weeklyPct < 100 && !alertFired.weekly_danger) {
        alertFired.weekly_danger = true;
        alertFired.weekly_warn = true;
        window.electronAPI.showNotification(
            'Claude Usage Widget',
            `Weekly Limit usage is at ${Math.round(weeklyPct)}% — usage is extremely low`
        );
    // Weekly Limit — warn threshold
    } else if (weeklyPct >= warnThreshold && weeklyPct < 100 && !alertFired.weekly_warn) {
        alertFired.weekly_warn = true;
        window.electronAPI.showNotification(
            'Claude Usage Widget',
            `Weekly Limit usage is at ${Math.round(weeklyPct)}% — usage is low`
        );
    }

    // Combined blocked/available — fires once when the user actually can't use
    // Claude anymore (either window at 100%), and once when it genuinely clears.
    // Single flag by design: if weekly is still at 100% when session resets, isBlocked
    // stays true, so a session-only reset never fires a false "available again".
    // Weekly checked first since it's the more restrictive limit when both are maxed.
    const isBlocked = weeklyPct >= 100 || sessionPct >= 100;
    if (isBlocked && !alertFired.blocked) {
        alertFired.blocked = true;
        if (weeklyPct >= 100) {
            window.electronAPI.showNotification(
                'Weekly limit reached.',
                // Build date and time as separate pieces and join with "at" — formatResetsAt's
                // combined date-day-time mode concatenates them with no connector, which read
                // run-on. Independent of dashboard's weeklyDateFormat setting on purpose.
                `Usage resets on ${formatResetsAt(data.seven_day?.resets_at, true, settings.timeFormat || '12h', 'date-day')} at ${formatResetsAt(data.seven_day?.resets_at, false, settings.timeFormat || '12h', 'date-day')}.`
            );
        } else {
            window.electronAPI.showNotification(
                'Session limit reached.',
                `Usage resets at ${formatResetsAt(data.five_hour?.resets_at, false, settings.timeFormat || '12h', settings.weeklyDateFormat || 'date')}.`
            );
        }
    } else if (!isBlocked && alertFired.blocked) {
        alertFired.blocked = false;
        window.electronAPI.showNotification(
            'Claude Usage Widget',
            'Usage is available again.'
        );
    }
}

// Apply or remove compact mode — switches view, resizes window, syncs all toggles
function applyCompactMode(compact) {
    isCompactMode = compact;

    // Add/remove compact-mode class from body for CSS styling
    if (compact) {
        document.body.classList.add('compact-mode');
    } else {
        document.body.classList.remove('compact-mode');
    }

    // Show/hide the correct content view
    elements.mainContent.style.display = compact ? 'none' : 'block';
    elements.compactContent.style.display = compact ? 'flex' : 'none';

    // Collapse extra rows when entering compact — prevents stale isExpanded state
    if (compact && isExpanded) {
        isExpanded = false;
        elements.expandArrow.classList.remove('expanded');
        elements.expandSection.style.display = 'none';
    }

    if (compact && graphVisible) {
        graphWasVisible = true;
        graphVisible = false;
        elements.graphBtn.classList.remove('active');
        elements.graphSection.style.display = 'none';
    } else if (!compact && graphWasVisible) {
        graphWasVisible = false;
        graphVisible = true;
        elements.graphBtn.classList.add('active');
        elements.graphSection.style.display = 'block';
        loadChart();
    }

    // Both views carry stats, so switching modes only needs an immediate
    // repaint of the view being switched to; the poll keeps running either way.
    refreshSystemStats();

    // Show/hide the collapse chevron (only visible in normal mode with data)
    if (elements.compactCollapseBtn) {
        elements.compactCollapseBtn.style.display = compact ? 'none' : 'flex';
    }

    // Keep refresh button visible in compact mode so users can see when data updates
    // Hide graph button in compact mode (not applicable)
    if (elements.graphBtn) {
        elements.graphBtn.style.display = compact ? 'none' : '';
    }

    // Tell main process to resize the window width
    window.electronAPI.setCompactMode(compact);

    // Sync both settings toggles
    if (elements.compactModeToggle) elements.compactModeToggle.checked = compact;
    if (elements.compactModeToggleCompact) elements.compactModeToggleCompact.checked = compact;

    // Update compact bars if we have data
    if (compact && latestUsageData) updateCompactBars(latestUsageData);
    if (!compact) resizeWidget();

    // Persist graph/expanded state changes caused by compact mode toggle
    _saveViewState();
}

// Update the compact mode progress bars
function updateCompactBars(data) {
    const sessionPct = Math.min(Math.max(data.five_hour?.utilization || 0, 0), 100);
    const weeklyPct = Math.min(Math.max(data.seven_day?.utilization || 0, 0), 100);

    elements.compactSessionFill.style.width = `${sessionPct}%`;
    elements.compactSessionPct.textContent = `${Math.round(sessionPct)}%`;
    elements.compactWeeklyFill.style.width = `${weeklyPct}%`;
    elements.compactWeeklyPct.textContent = `${Math.round(weeklyPct)}%`;

    // Apply warning/danger classes to compact bars
    elements.compactSessionFill.className = 'compact-bar-fill';
    if (sessionPct >= dangerThreshold) elements.compactSessionFill.classList.add('danger');
    else if (sessionPct >= warnThreshold) elements.compactSessionFill.classList.add('warning');

    elements.compactWeeklyFill.className = 'compact-bar-fill weekly';
    if (weeklyPct >= dangerThreshold) elements.compactWeeklyFill.classList.add('danger');
    else if (weeklyPct >= warnThreshold) elements.compactWeeklyFill.classList.add('warning');

    // Fable — only shown when the account has a scoped Fable weekly limit
    // (data.seven_day_fable, normalized centrally by main.js before this ever
    // reaches the renderer — see src/normalize-usage-limits.js)
    if (data.seven_day_fable) {
        const fablePct = Math.min(Math.max(data.seven_day_fable.utilization || 0, 0), 100);
        elements.compactFableRow.style.display = '';
        elements.compactFableFill.style.width = `${fablePct}%`;
        elements.compactFablePct.textContent = `${Math.round(fablePct)}%`;
        elements.compactFableFill.className = 'compact-bar-fill fable';
        if (fablePct >= dangerThreshold) elements.compactFableFill.classList.add('danger');
        else if (fablePct >= warnThreshold) elements.compactFableFill.classList.add('warning');
    } else {
        elements.compactFableRow.style.display = 'none';
    }
}

// Persist compact mode setting without touching the rest of settings — debounced
let _saveCompactTimer = null;
async function _saveCompactSetting(compact) {
    if (_saveCompactTimer) clearTimeout(_saveCompactTimer);
    _saveCompactTimer = setTimeout(async () => {
        const settings = window._cachedSettings || await window.electronAPI.getSettings();
        settings.compactMode = compact;
        window._cachedSettings = settings;
        await window.electronAPI.saveSettings(settings);
    }, 300);
}

// Persist graph/expanded visibility state — debounced to avoid hammering disk on rapid toggles
let _saveViewStateTimer = null;
async function _saveViewState() {
    if (appInitializing) return;
    if (_saveViewStateTimer) clearTimeout(_saveViewStateTimer);
    _saveViewStateTimer = setTimeout(async () => {
        const settings = window._cachedSettings || await window.electronAPI.getSettings();
        settings.graphVisible = graphVisible;
        settings.expandedOpen = isExpanded;
        window._cachedSettings = settings;
        await window.electronAPI.saveSettings(settings);
    }, 300);
}

let sessionResetTriggered = false;
let weeklyResetTriggered = false;
let isFirstDataLoad = true; // used to seed alert flags on startup

// Track which usage alert thresholds have already fired this window
// Prevents repeat notifications on every refresh cycle
// Keys: 'session_warn', 'session_danger', 'weekly_warn', 'weekly_danger', 'blocked'
// Seeded on startup so thresholds already exceeded at launch don't fire immediately
// 'blocked' is a single combined flag (not per-window) — see checkUsageAlerts for why:
// it must stay true if EITHER session or weekly is at 100%, so a session-only reset
// while weekly is still maxed never fires a false "available again" notification.
const alertFired = {
    session_warn: false,
    session_danger: false,
    weekly_warn: false,
    weekly_danger: false,
    blocked: false
};

// Seed alertFired flags based on current utilization at startup.
// Any threshold already exceeded when the app launches is treated as already fired,
// so the user doesn't get a notification for something they can already see.
function seedAlertFlags(data) {
    const sessionPct = data.five_hour?.utilization || 0;
    const weeklyPct = data.seven_day?.utilization || 0;

    if (sessionPct >= dangerThreshold) {
        alertFired.session_danger = true;
        alertFired.session_warn = true;
    } else if (sessionPct >= warnThreshold) {
        alertFired.session_warn = true;
    }

    if (weeklyPct >= dangerThreshold) {
        alertFired.weekly_danger = true;
        alertFired.weekly_warn = true;
    } else if (weeklyPct >= warnThreshold) {
        alertFired.weekly_warn = true;
    }

    // Seed the combined blocked flag the same way — if either is already at 100%
    // when the app launches, don't fire "limit reached" immediately.
    if (sessionPct >= 100 || weeklyPct >= 100) {
        alertFired.blocked = true;
    }
}

function refreshTimers() {
    if (!latestUsageData) return;

    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    // Session data
    const sessionUtilization = latestUsageData.five_hour?.utilization || 0;
    const sessionResetsAt = latestUsageData.five_hour?.resets_at;

    // Check if session timer has expired and we need to refresh
    if (sessionResetsAt) {
        const sessionDiff = new Date(sessionResetsAt) - new Date();
        if (sessionDiff <= 0 && !sessionResetTriggered) {
            sessionResetTriggered = true;
            debugLog('Session timer expired, triggering refresh...');
            // Wait a few seconds for the server to update, then refresh
            setTimeout(() => {
                fetchUsageData();
            }, 3000);
        } else if (sessionDiff > 0) {
            sessionResetTriggered = false; // Reset flag when timer is active again
        }
    }

    updateProgressBar(
        elements.sessionProgress,
        elements.sessionPercentage,
        sessionUtilization
    );

    updateTimer(
        elements.sessionTimer,
        elements.sessionTimeText,
        sessionResetsAt,
        5 * 60 // 5 hours in minutes
    );
    elements.sessionResetsAt.textContent = formatResetsAt(sessionResetsAt, false, timeFormat, weeklyDateFormat);
    elements.sessionResetsAt.style.opacity = sessionResetsAt ? '1' : '0.4';

    // Weekly data
    const weeklyUtilization = latestUsageData.seven_day?.utilization || 0;
    const weeklyResetsAt = latestUsageData.seven_day?.resets_at;

    // Check if weekly timer has expired and we need to refresh
    if (weeklyResetsAt) {
        const weeklyDiff = new Date(weeklyResetsAt) - new Date();
        if (weeklyDiff <= 0 && !weeklyResetTriggered) {
            weeklyResetTriggered = true;
            debugLog('Weekly timer expired, triggering refresh...');
            setTimeout(() => {
                fetchUsageData();
            }, 3000);
        } else if (weeklyDiff > 0) {
            weeklyResetTriggered = false;
        }
    }

    updateProgressBar(
        elements.weeklyProgress,
        elements.weeklyPercentage,
        weeklyUtilization,
        true
    );

    updateTimer(
        elements.weeklyTimer,
        elements.weeklyTimeText,
        weeklyResetsAt,
        7 * 24 * 60 // 7 days in minutes
    );
    elements.weeklyResetsAt.textContent = formatResetsAt(weeklyResetsAt, true, timeFormat, weeklyDateFormat);
    elements.weeklyResetsAt.style.opacity = weeklyResetsAt ? '1' : '0.4';
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        refreshTimers();
        if (isExpanded) refreshExtraTimers();
    }, 30000);
}

// Update progress bar
function updateProgressBar(progressElement, percentageElement, value, isWeekly = false) {
    const percentage = Math.min(Math.max(value, 0), 100);

    progressElement.style.width = `${percentage}%`;
    percentageElement.textContent = `${Math.round(percentage)}%`;

    progressElement.classList.remove('warning', 'danger');
    if (percentage >= dangerThreshold) {
        progressElement.classList.add('danger');
    } else if (percentage >= warnThreshold) {
        progressElement.classList.add('warning');
    }
}

// Format reset date for the "Resets At" column
// Session: shows time like "3:59 PM" or "15:59"
// Weekly: shows date like "Mar 13", "Fri Mar 13", or "Fri Mar 13 3:59 PM"
function formatResetsAt(resetsAt, isWeekly, timeFormat, weeklyDateFormat) {
    if (!resetsAt) return '—';
    const date = new Date(resetsAt);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const formatTime = (d) => {
        if (timeFormat === '24h') {
            return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        } else {
            let hours = d.getHours();
            const minutes = d.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            return `${hours}:${minutes} ${ampm}`;
        }
    };

    if (isWeekly) {
        const dayStr = days[date.getDay()];
        const monthStr = months[date.getMonth()];
        const dayNum = date.getDate();
        const fmt = weeklyDateFormat || 'date';
        if (fmt === 'date-day') return `${dayStr} ${monthStr} ${dayNum}`;
        if (fmt === 'date-day-time') return `${dayStr} ${monthStr} ${dayNum} ${formatTime(date)}`;
        return `${monthStr} ${dayNum}`; // default: 'date'
    } else {
        return formatTime(date);
    }
}

// Update circular timer
function updateTimer(timerElement, textElement, resetsAt, totalMinutes) {
    if (!resetsAt) {
        textElement.textContent = 'Not started';
        textElement.style.opacity = '0.4';
        textElement.style.fontSize = '10px';
        textElement.title = 'Starts when a message is sent';
        timerElement.style.strokeDashoffset = 63;
        return;
    }

    // Clear the greyed out styling when timer is active
    textElement.style.opacity = '1';
    textElement.style.fontSize = '';
    textElement.title = '';

    const resetDate = new Date(resetsAt);
    const now = new Date();
    const diff = resetDate - now;

    if (diff <= 0) {
        textElement.textContent = 'Resetting...';
        timerElement.style.strokeDashoffset = 0;
        return;
    }

    // Calculate remaining time
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    // const seconds = Math.floor((diff % (1000 * 60)) / 1000); // Optional seconds

    // Format time display
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        textElement.textContent = `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        textElement.textContent = `${hours}h ${minutes}m`;
    } else {
        textElement.textContent = `${minutes}m`;
    }

    // Calculate progress (elapsed percentage)
    const totalMs = totalMinutes * 60 * 1000;
    const elapsedMs = totalMs - diff;
    const elapsedPercentage = (elapsedMs / totalMs) * 100;

    // Update circle (63 is ~2*pi*10)
    const circumference = 63;
    const offset = circumference - (elapsedPercentage / 100) * circumference;
    timerElement.style.strokeDashoffset = offset;

    // Update color based on time remaining until reset — hardcoded thresholds,
    // intentionally independent of the usage warnThreshold/dangerThreshold
    // settings (see ELAPSED_AMBER_THRESHOLD/ELAPSED_GREEN_THRESHOLD above).
    timerElement.classList.remove('elapsed-warn', 'elapsed-soon');
    if (elapsedPercentage >= ELAPSED_GREEN_THRESHOLD) {
        timerElement.classList.add('elapsed-soon');
    } else if (elapsedPercentage >= ELAPSED_AMBER_THRESHOLD) {
        timerElement.classList.add('elapsed-warn');
    }
}

// UI State Management
function showLoginRequired() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'flex';
    elements.noUsageContainer.style.display = 'none';
    elements.mainContent.style.display = 'none';
    // Reset to step 1
    elements.loginStep1.style.display = 'flex';
    elements.loginStep2.style.display = 'none';
    elements.sessionKeyError.textContent = '';
    elements.sessionKeyInput.value = '';
    // Close any open overlays
    elements.settingsOverlay.style.display = 'none';
    elements.compactSettingsOverlay.style.display = 'none';
    // Hide header buttons during login
    elements.settingsBtn.style.display = 'none';
    elements.refreshBtn.style.display = 'none';
    elements.graphBtn.style.display = 'none';
    stopAutoUpdate();
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    // Reset fetch guard so it can't get permanently stuck across login/logout
    isFetching = false;
    // Reset alert state so a new session doesn't inherit suppressed alerts
    isFirstDataLoad = true;
    alertFired.session_warn = false;
    alertFired.session_danger = false;
    alertFired.weekly_warn = false;
    alertFired.weekly_danger = false;
    // Resize window to fit login content — without this the window stays at
    // the default 155px widget height and the "Log in"/"Manual" buttons are
    // clipped off-screen and unreachable on a frameless, non-resizable window.
    window.electronAPI.resizeWindow(360);
}

function showMainContent() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'none';
    // Respect compact mode — don't force mainContent visible if we're in compact
    if (!isCompactMode) {
        elements.mainContent.style.display = 'block';
    }
    elements.compactContent.style.display = isCompactMode ? 'flex' : 'none';
    // Always show collapse chevron here — applyCompactMode hides it when needed
    if (elements.compactCollapseBtn) {
        elements.compactCollapseBtn.style.display = isCompactMode ? 'none' : 'flex';
    }
    // Restore header buttons after login - but respect compact mode for graph button
    elements.settingsBtn.style.display = 'flex';
    elements.refreshBtn.style.display = 'flex';
    elements.graphBtn.style.display = isCompactMode ? 'none' : 'flex';
}

// Auto-update management
function startAutoUpdate() {
    stopAutoUpdate();
    const settings = window._cachedSettings || {};
    const intervalSecs = parseInt(settings.refreshInterval) || 300;
    updateInterval = setInterval(async () => {
        if (elements.refreshBtn) elements.refreshBtn.classList.add('spinning');
        await fetchUsageData();
        if (elements.refreshBtn) elements.refreshBtn.classList.remove('spinning');
    }, intervalSecs * 1000);
}

function stopAutoUpdate() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
}

async function loadChart() {
    const history = await window.electronAPI.getUsageHistory();
    if (!history.length) return;
    renderChart(history);
}

function renderChart(history) {
    if (usageChart) usageChart.destroy();

    const showSonnet = isExpanded && !!latestUsageData?.seven_day_sonnet;
    const showOpus = isExpanded && !!latestUsageData?.seven_day_opus;
    const showFable = isExpanded && !!latestUsageData?.seven_day_fable;
    const showCowork = isExpanded && !!latestUsageData?.seven_day_cowork;
    const showDesign = isExpanded && !!latestUsageData?.seven_day_omelette;
    const showOAuthApps = isExpanded && !!latestUsageData?.seven_day_oauth_apps;
    const showExtraUsage = isExpanded && !!latestUsageData?.extra_usage;
    const allValues = history.flatMap((entry) => {
        const values = [entry.session, entry.weekly];
        if (showSonnet) values.push(entry.sonnet || 0);
        if (showOpus) values.push(entry.opus || 0);
        if (showFable) values.push(entry.fable || 0);
        if (showCowork) values.push(entry.cowork || 0);
        if (showDesign) values.push(entry.design || 0);
        if (showOAuthApps) values.push(entry.oauthApps || 0);
        if (showExtraUsage) values.push(entry.extraUsage || 0);
        return values;
    });
    const yMax = Math.max(10, Math.ceil(Math.max(...allValues) / 10) * 10);

    const datasets = [
        {
            label: 'Session',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.session })),
            borderColor: '#8b5cf6',
            backgroundColor: 'transparent',
            borderWidth: 2,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
        },
        {
            label: 'Weekly',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.weekly })),
            borderColor: '#3b82f6',
            backgroundColor: 'transparent',
            borderWidth: 2,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
        }
    ];

    if (showSonnet) {
        const sonnetData = history.map((entry) => entry.sonnet || 0);
        if (sonnetData.some((value) => value > 0)) {
            datasets.push({
                label: 'Sonnet',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.sonnet || 0 })),
                borderColor: '#f43f5e',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showOpus) {
        const opusData = history.map((entry) => entry.opus || 0);
        if (opusData.some((value) => value > 0)) {
            datasets.push({
                label: 'Opus',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.opus || 0 })),
                borderColor: '#f59e0b',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showFable) {
        const fableData = history.map((entry) => entry.fable || 0);
        if (fableData.some((value) => value > 0)) {
            datasets.push({
                label: 'Fable',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.fable || 0 })),
                borderColor: '#d946ef',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showCowork) {
        const coworkData = history.map((entry) => entry.cowork || 0);
        if (coworkData.some((value) => value > 0)) {
            datasets.push({
                label: 'Cowork',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.cowork || 0 })),
                borderColor: '#06b6d4',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showDesign) {
        const designData = history.map((entry) => entry.design || 0);
        if (designData.some((value) => value > 0)) {
            datasets.push({
                label: 'Design',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.design || 0 })),
                borderColor: '#92400e',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showOAuthApps) {
        const oauthAppsData = history.map((entry) => entry.oauthApps || 0);
        if (oauthAppsData.some((value) => value > 0)) {
            datasets.push({
                label: 'OAuth Apps',
                data: history.map((entry) => ({ x: entry.timestamp, y: entry.oauthApps || 0 })),
                borderColor: '#f97316',
                backgroundColor: 'transparent',
                borderWidth: 2,
                stepped: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHitRadius: 10
            });
        }
    }

    if (showExtraUsage) {
        const extraUsageData = history.map((entry) => entry.extraUsage || 0);
        if (extraUsageData.some((value) => value > 0)) {
            datasets.push({
            label: 'Extra Usage',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.extraUsage || 0 })),
            borderColor: '#f59e0b',
            backgroundColor: 'transparent',
            borderWidth: 2,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
            });
        }
    }

    const firstDayMidnight = new Date(history[0].timestamp);
    firstDayMidnight.setHours(0, 0, 0, 0);

    usageChart = new Chart(elements.usageChart.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            scales: {
                x: {
                    type: 'linear',
                    min: firstDayMidnight.getTime(),
                    max: history[history.length - 1].timestamp,
                    afterBuildTicks(axis) {
                        const end = history[history.length - 1].timestamp;
                        const d = new Date(firstDayMidnight.getTime());
                        const ticks = [];
                        while (d.getTime() <= end) {
                            ticks.push({ value: d.getTime() });
                            d.setDate(d.getDate() + 1);
                        }
                        axis.ticks = ticks;
                    },
                    ticks: {
                        maxRotation: 0,
                        minRotation: 0,
                        font: {
                            size: 10
                        },
                        callback(value) {
                            const tf = (window._cachedSettings || {}).timeFormat || '12h';
                            const spanMs = history.length > 1
                                ? history[history.length - 1].timestamp - history[0].timestamp
                                : 0;
                            return formatTimestampTick(value, spanMs, tf);
                        }
                    },
                    grid: {
                        display: false
                    }
                },
                y: {
                    min: 0,
                    max: yMax,
                    ticks: {
                        font: {
                            size: 10
                        },
                        callback: (value) => `${value}%`
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        title(items) {
                            return new Date(items[0].parsed.x).toLocaleString([], {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit'
                            });
                        },
                        label(item) {
                            return `${item.dataset.label}: ${Math.round(item.parsed.y)}%`;
                        }
                    }
                }
            }
        }
    });
}

function formatTimestampTick(timestamp, spanMs, timeFormat) {
    const date = new Date(timestamp);
    const hour12 = (timeFormat || '12h') !== '24h';

    if (spanMs < 12 * 60 * 60 * 1000) {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
    }
    if (spanMs < 48 * 60 * 60 * 1000) {
        return date.toLocaleString([], { weekday: 'short', hour: 'numeric', hour12 });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Add spinning animation for refresh button
const style = document.createElement('style');
style.textContent = `
    @keyframes spin-refresh {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    
    .refresh-btn.spinning svg {
        animation: spin-refresh 1s linear infinite;
    }
`;
document.head.appendChild(style);

// Settings management
let warnThreshold = 75;
let dangerThreshold = 90;

async function loadSettings() {
    const settings = await window.electronAPI.getSettings();
    const isLinux = window.electronAPI.platform === 'linux';
    const isPortable = window.electronAPI.isPortable;
    const autoStartUnsupported = isLinux || isPortable;

    elements.autoStartToggle.checked = autoStartUnsupported ? false : settings.autoStart;
    elements.autoStartToggle.disabled = autoStartUnsupported;
    if (elements.autoStartCol) {
        elements.autoStartCol.classList.toggle('settings-col-disabled', autoStartUnsupported);
    }
    if (elements.autoStartHint) {
        elements.autoStartHint.style.display = autoStartUnsupported ? 'inline' : 'none';
        elements.autoStartHint.textContent = isPortable
            ? 'Not supported in portable mode!'
            : 'Not supported on Linux';
    }
    elements.minimizeToTrayToggle.checked = settings.minimizeToTray;
    elements.alwaysOnTopToggle.checked = settings.alwaysOnTop;
    elements.showTrayStatsToggle.checked = settings.showTrayStats || false;
    elements.warnThreshold.value = settings.warnThreshold;
    elements.dangerThreshold.value = settings.dangerThreshold;
    elements.timeFormat.value = settings.timeFormat || '12h';
    elements.weeklyDateFormat.value = settings.weeklyDateFormat || 'date';
    if (elements.refreshInterval) elements.refreshInterval.value = settings.refreshInterval || '300';
    elements.usageAlertsToggle.checked = settings.usageAlerts !== false;
    if (elements.compactModeToggle) elements.compactModeToggle.checked = !!settings.compactMode;

    // Populate org selector if user has organizations
    if (credentials.organizations && credentials.organizations.length > 0) {
        populateOrgSelector(credentials.organizations, credentials.organizationId);
    }


    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    elements.themeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === settings.theme);
    });

    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
}

async function saveSettings() {
    const activeThemeBtn = document.querySelector('.theme-btn.active');
    const warn = parseInt(elements.warnThreshold.value) || 75;
    const danger = parseInt(elements.dangerThreshold.value) || 90;

    warnThreshold = warn;
    dangerThreshold = danger;

    // Apply compact mode change first, then include in saved settings
    const compactToggleValue = elements.compactModeToggle.checked;
    if (compactToggleValue !== isCompactMode) {
        applyCompactMode(compactToggleValue);
    }

    const settings = {
        autoStart: (window.electronAPI.platform === 'linux' || window.electronAPI.isPortable) ? false : elements.autoStartToggle.checked,
        minimizeToTray: elements.minimizeToTrayToggle.checked,
        alwaysOnTop: elements.alwaysOnTopToggle.checked,
        showTrayStats: elements.showTrayStatsToggle.checked,
        theme: activeThemeBtn ? activeThemeBtn.dataset.theme : 'dark',
        warnThreshold: warn,
        dangerThreshold: danger,
        timeFormat: elements.timeFormat.value || '12h',
        weeklyDateFormat: elements.weeklyDateFormat.value || 'date',
        refreshInterval: elements.refreshInterval ? (elements.refreshInterval.value || '300') : '300',
        usageAlerts: elements.usageAlertsToggle.checked,
        compactMode: isCompactMode,
        graphVisible: graphVisible,
        expandedOpen: isExpanded
    };
    await window.electronAPI.saveSettings(settings);
    window._cachedSettings = settings;
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }

    // Re-render resets-at values immediately with new format
    if (latestUsageData) {
        refreshTimers();
        // Rebuild extra rows to apply new threshold colors
        if (isExpanded) {
            buildExtraRows(latestUsageData);
            refreshExtraTimers();
        }
    }
    // Restart auto-update with new interval if it changed
    startAutoUpdate();
}

function applyTheme(theme) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = theme === 'dark' || (theme === 'system' && prefersDark);
    document.body.classList.toggle('theme-light', !useDark);
}

// Start the application
init();
window.addEventListener('beforeunload', () => {
    stopAutoUpdate();
    if (countdownInterval) clearInterval(countdownInterval);
});
