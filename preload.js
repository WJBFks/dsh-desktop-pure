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

// The shell's own "DSH Desktop Pure" page (pure.html) loads in the SAME
// WebContentsView as the harness, so it shares this preload. It uses the
// `dshPure` surface below; the real dsh web page simply ignores it (no clash,
// no injection into the harness DOM). Safe under sandbox: true.
contextBridge.exposeInMainWorld('dshPure', {
  // Awaitable snapshot of version / theme / connection state.
  getInfo() {
    return ipcRenderer.invoke('pure:get-info');
  },
  // Appearance choice from the Pure page (system / light / dark) — drives the
  // whole shell's theme, exactly like the 视图 → theme menu items.
  setTheme(source) {
    ipcRenderer.send('pure:set-theme', String(source));
  },
  // Full-window vs centered-card layout (persisted by the shell).
  setLayout(mode) {
    ipcRenderer.send('pure:set-layout', String(mode));
  },
  // "Open DSH Web": resolve (probe → reuse → spawn) and show the web view.
  openWeb() {
    ipcRenderer.send('pure:open-web');
  },
  // Hand a web URL to the system browser (about / repo links).
  openExternal(url) {
    ipcRenderer.send('pure:open-external', String(url));
  },
  // "Restart dsh server" from the Pure page.
  restartServer() {
    ipcRenderer.send('pure:restart');
  },
  // Live state push (view switched, theme changed, server went online/offline).
  subscribe(callback) {
    ipcRenderer.on('pure:info', (_event, data) => {
      try {
        callback(data);
      } catch {
        /* ignore bad payload */
      }
    });
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
