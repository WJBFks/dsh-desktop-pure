/**
 * Get (or lazily create) the WebContentsView for an endpoint. Each endpoint
 * has its OWN view so switching preserves sessions (no re-navigation, no
 * React re-boot). Views are parked off-screen when not displayed, never
 * destroyed while the app runs.
 */
function getEndpointView(epId) {
  if (appState.views[epId]) return appState.views[epId];
  const v = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  hardenWebContents(v.webContents);
  v.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    if (win !== null) win.setTitle(WINDOW_TITLE);
  });
  v.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    if (!validatedURL || validatedURL.startsWith('file://') || validatedURL === 'about:blank') return;
    if (appState.view !== 'web' || appState.currentPage !== epId) return;
    const ep = getEndpoint(epId);
    const name = ep ? ep.name : '';
    const detail = errorDescription || '连接失败';
    if (ep) { ep.status = 'offline'; ep.detail = detail; }
    appState.url = null;
    v.webContents.loadURL(routerUrl(epId, 'error', name, detail));
    setStatus({ reason: `连接断开：${detail}` });
    pushPureInfo();
  });
  win.contentView.addChildView(v);
  v.setBounds({ x: -100000, y: 0, width: 0, height: 0 });
  appState.views[epId] = v;
  return v;
}

function layout() {
  if (win === null || titlebarView === null || pureView === null) return;
  const [width, height] = win.getContentSize();
  const y = TITLEBAR_HEIGHT;
  const h = Math.max(0, height - TITLEBAR_HEIGHT);
  const OFF = -100000;
  titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
  if (appState.view === 'pure') {
    pureView.setBounds({ x: 0, y, width, height: h });
    for (const v of Object.values(appState.views)) {
      v.setBounds({ x: OFF, y, width: 0, height: 0 });
    }
    webView = null;
  } else {
    pureView.setBounds({ x: OFF, y, width: 0, height: 0 });
    webView = null;
    for (const [epId, v] of Object.entries(appState.views)) {
      if (epId === appState.currentPage) {
        v.setBounds({ x: 0, y, width, height: h });
        webView = v;
      } else {
        v.setBounds({ x: OFF, y, width: 0, height: 0 });
      }
    }
  }
}
