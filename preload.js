'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, read-only surface for the (already trusted) harness page.
// The renderer never needs Node access; this only announces the shell.
// Safe under sandbox: true — contextBridge and process.versions are available
// in sandboxed preloads.
contextBridge.exposeInMainWorld('dshShell', {
  runtime: 'electron',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
});

// Notify the shell when the harness page is clicked, so an open dropdown menu
// can be dismissed. Passive observation (capture phase, never preventDefault) —
// it does not alter the harness page's own behavior.
document.addEventListener(
  'click',
  () => {
    try {
      ipcRenderer.send('harness:click');
    } catch {
      /* ignore */
    }
  },
  true
);
