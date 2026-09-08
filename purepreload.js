'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The shell's own "DSH Desktop Pure" page (pure.html) is a dedicated, local
// (file://) WebContentsView, isolated from the dsh web page. It uses the
// `dshPure` surface below. No Node access is exposed; every callback is wrapped
// so a bad payload can never crash the shell. Safe under sandbox: true.
contextBridge.exposeInMainWorld('dshPure', {
  // Awaitable snapshot of version / theme / layout / connection state.
  getInfo() {
    return ipcRenderer.invoke('pure:get-info');
  },
  // Remote repository changelog. The main process fixes the repository and
  // accepts only zh/en; no arbitrary URL crosses this bridge.
  getChangelog(language, options) {
    return ipcRenderer.invoke('pure:get-changelog', language === 'en' ? 'en' : 'zh', {
      cachedOnly: Boolean(options && options.cachedOnly)
    });
  },
  // GitHub release metadata and a deliberately explicit, system-browser
  // download hand-off. The main process validates the asset id.
  checkUpdate() {
    return ipcRenderer.invoke('pure:check-update');
  },
  downloadUpdate(assetId) {
    return ipcRenderer.invoke('pure:download-update', assetId);
  },
  onReleaseUpdate(callback) {
    ipcRenderer.on('pure:release-update', (_event, data) => {
      try {
        callback(data);
      } catch {
        /* ignore bad payload */
      }
    });
  },
  onShowSection(callback) {
    ipcRenderer.on('pure:show-section', (_event, section) => {
      try {
        callback(String(section));
      } catch {
        /* ignore bad payload */
      }
    });
  },
  setStartupPage(page) {
    return ipcRenderer.invoke('pure:set-startup-page', page === 'local' || page === 'wsl' ? page : 'pure');
  },
  chooseStartupPage(page) {
    return ipcRenderer.invoke('pure:choose-startup-page', page === 'local' || page === 'wsl' ? page : null);
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
  // "Open DSH Web": reveal the web view (preserve session) or connect it.
  // Optional id = which endpoint; defaults to the one the Pure page selected.
  openWeb(id) {
    ipcRenderer.send('pure:open-web', typeof id === 'string' ? id : '');
  },
  // Pick an endpoint in the DSH Web tab bar (does not connect yet).
  selectEndpoint(id) {
    ipcRenderer.send('pure:select-endpoint', String(id));
  },
  // Add a custom remote endpoint (awaitable: resolves { ok, error? }).
  addEndpoint(name, url, token) {
    return ipcRenderer.invoke('pure:add-endpoint', String(name), String(url), typeof token === 'string' ? token : undefined);
  },
  // Remove a custom endpoint (local / WSL are permanent).
  removeEndpoint(id) {
    ipcRenderer.send('pure:remove-endpoint', String(id));
  },
  // Edit an endpoint (name / port / dsh / url) — awaitable { ok, error? }.
  editEndpoint(id, patch) {
    return ipcRenderer.invoke('pure:edit-endpoint', String(id), patch);
  },
  // Reset a local / WSL endpoint to defaults.
  resetEndpoint(id) {
    ipcRenderer.send('pure:reset-endpoint', String(id));
  },
  // Probe a custom endpoint immediately (fire-and-forget; the push follows).
  probeEndpoint(id) {
    ipcRenderer.send('pure:probe-endpoint', String(id));
  },
  // Hand a web URL to the system browser (about / repo links).
  openExternal(url) {
    ipcRenderer.send('pure:open-external', String(url));
  },
  openEndpointBrowser(id) {
    return ipcRenderer.invoke('pure:open-endpoint-browser', String(id));
  },
  // "Restart dsh server" from the Pure page (given id, or the displayed one).
  restartServer(id) {
    ipcRenderer.send('pure:restart', typeof id === 'string' ? id : '');
  },
  // Live state push (view / theme / layout / server went online or offline).
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
