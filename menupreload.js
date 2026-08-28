'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The dropdown menu is shell-owned UI. It renders menu data pushed by the main
// process and reports item clicks / dismissals. No Node access is exposed; every
// callback is wrapped so a bad payload can never crash the shell. Safe under
// sandbox: true.
contextBridge.exposeInMainWorld('dshMenu', {
  onShow(callback) {
    ipcRenderer.on('menu:show', (_event, data) => {
      try {
        callback(data);
      } catch {
        /* ignore bad payload */
      }
    });
  },
  onHide(callback) {
    ipcRenderer.on('menu:hide', () => {
      try {
        callback();
      } catch {
        /* ignore */
      }
    });
  },
  action(id) {
    ipcRenderer.send('menu:action', String(id));
  },
  close() {
    ipcRenderer.send('menu:close');
  }
});
