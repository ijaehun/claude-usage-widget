const { contextBridge, ipcRenderer } = require('electron');

// A dedicated, deliberately tiny bridge for the status panel. It could have
// reused preload.js, but that exposes credential and window-control channels
// the panel has no business reaching — this is the whole surface it needs.
contextBridge.exposeInMainWorld('statusPanel', {
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),
  close: () => ipcRenderer.send('close-status-panel'),
  // The only URL the panel ever opens. Passing it from here rather than taking
  // one from the page means there is nothing to validate: main.js re-checks its
  // own allowlist regardless.
  openStatusPage: () => ipcRenderer.send('open-external', 'https://status.claude.com'),
});
