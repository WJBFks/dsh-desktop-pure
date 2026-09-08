'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The title bar is shell-owned UI. It renders status / maximize pushes and
// forwards menu-button + window-control interactions to the main process. No
// Node access is exposed; every callback is wrapped so a bad payload can never
// crash the shell. Safe under sandbox: true.
contextBridge.exposeInMainWorld('dshTitlebar', {
  // The current platform ('win32' | 'darwin' | 'linux'), for CSS adaptation.
  platform: process.platform,

  subscribe(callback) {
    ipcRenderer.on('dsh:status', (_event, data) => {
      try {
        callback(data);
      } catch {
        /* ignore bad payload */
      }
    });
  },
  onMaximized(callback) {
    ipcRenderer.on('titlebar:maximized', (_event, maximized) => {
      try {
        callback(Boolean(maximized));
      } catch {
        /* ignore bad payload */
      }
    });
  },
  // Native drag regions do not reliably dispatch renderer mouse events. The
  // main process therefore owns hit testing and sends only this boolean back.
  onStatusHover(callback) {
    ipcRenderer.on('titlebar:status-hover', (_event, hovered) => {
      try {
        callback(Boolean(hovered));
      } catch {
        /* ignore bad payload */
      }
    });
  },
  onReleaseUpdate(callback) {
    ipcRenderer.on('titlebar:release-update', (_event, data) => {
      try {
        callback(data);
      } catch {
        /* ignore bad payload */
      }
    });
  },
  openUpdateAbout() {
    ipcRenderer.send('titlebar:open-update-about');
  },
  // Content-relative rectangle of the redacted status. This contains no URL
  // or token; the main process validates that only this shell view can report.
  reportStatusHitbox(rect) {
    if (!rect || typeof rect !== 'object') return;
    ipcRenderer.send('titlebar:status-hitbox', {
      x: Number(rect.x), y: Number(rect.y),
      width: Number(rect.width), height: Number(rect.height)
    });
  },
  // Click a menu button: open it, or close it if already open.
  toggleMenu(name, relLeft) {
    ipcRenderer.send('menu:toggle', String(name), Number(relLeft) || 0);
  },
  // Hover a menu button: switch to it only while another menu is open.
  hoverMenu(name, relLeft) {
    ipcRenderer.send('menu:hover', String(name), Number(relLeft) || 0);
  },
  closeMenu() {
    ipcRenderer.send('menu:close');
  },
  windowControl(action) {
    ipcRenderer.send('titlebar:window-control', String(action));
  }
});
