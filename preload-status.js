const { contextBridge, ipcRenderer } = require('electron');

// A dedicated, deliberately tiny bridge for the status panel. It could have
// reused preload.js, but that exposes credential and window-control channels
// the panel has no business reaching — this is the whole surface it needs.
contextBridge.exposeInMainWorld('statusPanel', {
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),
  getCodexServiceStatus: () => ipcRenderer.invoke('get-codex-service-status'),
  // The system panel (system-panel.html) shares this window and bridge.
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  close: () => ipcRenderer.send('close-status-panel'),
  // The only URLs the panel ever opens. Passing them from here rather than
  // taking one from the page means there is nothing to validate: main.js
  // re-checks its own allowlist regardless.
  openStatusPage: () => ipcRenderer.send('open-external', 'https://status.claude.com'),
  openCodexStatusPage: () => ipcRenderer.send('open-external', 'https://status.openai.com'),
});
