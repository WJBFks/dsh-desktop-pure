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
  },
  // Live status pushes (main → renderer): the WSL setup-guide page keeps the
  // step the user is on (never re-lands on background auto-detection) and
  // refreshes its status bar in place when a probe lands.
  onWslStatus(cb) {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('wsl:status', listener);
    return () => ipcRenderer.removeListener('wsl:status', listener);
  },
  onWslInstallProgress(cb) {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('wsl:install-progress', listener);
    return () => ipcRenderer.removeListener('wsl:install-progress', listener);
  },
  // WSL setup-guide page (loaded in an endpoint view): re-run WSL detection,
  // or (re)connect the WSL endpoint. Harmless on the plain dsh web page.
  wslRecheck() {
    ipcRenderer.send('router:wsl-recheck');
  },
  wslRetry() {
    ipcRenderer.send('router:wsl-retry');
  },
  wslInstallDsh() {
    ipcRenderer.send('router:wsl-install-dsh');
  },
  wslInstallWsl(distro) {
    ipcRenderer.send('router:wsl-install-wsl', typeof distro === 'string' ? distro : '');
  },
  wslInstallNode() {
    ipcRenderer.send('router:wsl-install-node');
  }
});

// Note: the shell's own DSH Desktop Pure page (pure.html) now runs in its own
// WebContentsView with its own preload (purepreload.js → window.dshPure). The
// dsh web page uses only window.dshShell below.
//
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
