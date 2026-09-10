const { contextBridge, ipcRenderer } = require('electron');

// Allowed domains for openExternal — prevents renderer from opening arbitrary URLs
const ALLOWED_EXTERNAL_DOMAINS = [
  'claude.ai',
  // status.claude.com — the service-status indicator links out to it, and it
  // is a different registrable domain from claude.ai.
  'claude.com',
  'github.com'
];

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_EXTERNAL_DOMAINS.some(domain =>
      parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Credentials management
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  saveCredentials: (credentials) => ipcRenderer.invoke('save-credentials', credentials),
  deleteCredentials: () => ipcRenderer.invoke('delete-credentials'),
  validateSessionKey: (sessionKey) => ipcRenderer.invoke('validate-session-key', sessionKey),
  detectSessionKey: () => ipcRenderer.invoke('detect-session-key'),

  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  resizeWindow: (height) => ipcRenderer.send('resize-window', height),

  // Window position
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (position) => ipcRenderer.invoke('set-window-position', position),

  // Event listeners
  onRefreshUsage: (callback) => {
    ipcRenderer.on('refresh-usage', () => callback());
  },
  onSessionExpired: (callback) => {
    ipcRenderer.on('session-expired', () => callback());
  },

  // API
  fetchUsageData: () => ipcRenderer.invoke('fetch-usage-data'),
  getUsageHistory: () => ipcRenderer.invoke('get-usage-history'),
  openExternal: (url) => {
    if (isAllowedExternalUrl(url)) {
      ipcRenderer.send('open-external', url);
    } else {
      console.warn('openExternal blocked — URL not in allowlist:', url);
    }
  },

  // Platform
  platform: process.platform,
  isPortable: process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE,

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Notifications
  showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body }),

  // System monitor
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

  // Claude service health (status.claude.com)
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),
  toggleStatusPanel: (payload) => ipcRenderer.invoke('toggle-status-panel', payload),

  // OpenAI Codex plan limits, read from Codex's local session logs
  getCodexUsage: () => ipcRenderer.invoke('get-codex-usage'),

  // Bar mode (Windows appbar docking)
  setBarMode: (enabled, edge) => ipcRenderer.invoke('set-bar-mode', { enabled, edge }),
  getBarMode: () => ipcRenderer.invoke('get-bar-mode'),
  onBarModeChanged: (callback) => {
    ipcRenderer.on('bar-mode-changed', (_e, enabled) => callback(enabled));
  },

  // Compact mode
  setCompactMode: (compact) => ipcRenderer.send('set-compact-mode', compact)
});
