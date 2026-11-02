// Frog desktop: a thin window onto a frog server. The server address lives in
// ~/.config/frog/desktop.json → { "url": "http://my-mac:7777" }; first run asks for it.
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, dialog, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isMac = process.platform === 'darwin';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'frog');
const CONFIG = path.join(CONFIG_DIR, 'desktop.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); };
let config = readConfig();

let win;
let retryTimer;

app.setAppUserModelId('dev.frog.desktop'); // Windows notifications need this

function offlinePage(err) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0d1110;color:#8a978f;font:14px -apple-system,system-ui,Segoe UI,sans-serif;-webkit-app-region:drag">
  <div style="text-align:center"><div style="font-size:40px">🐸</div><div style="color:#d7e0da;font-weight:600;margin:8px 0">Connecting to ${config.url}…</div>
  <div>${err || ''}</div><div style="margin-top:8px;font-size:12px">Is the frog server running and Tailscale on? Retrying automatically.</div>
  <div style="margin-top:16px;-webkit-app-region:no-drag"><a href="frog://setup" style="color:#4ade80">Change server</a></div></div></body></html>`);
}

function load() {
  clearTimeout(retryTimer);
  if (!config.url) { win.loadFile(path.join(__dirname, 'setup.html')); return; }
  win.loadURL(config.url).catch(() => {});
}

function createWindow() {
  const b = config.bounds || { width: 1400, height: 900 };
  win = new BrowserWindow({
    ...b,
    minWidth: 480,
    minHeight: 320,
    title: 'Frog',
    backgroundColor: '#0d1110',
    show: false,
    autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : {}),
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted (navigation replaced)
    win.loadURL(offlinePage(desc));
    retryTimer = setTimeout(load, 2000);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === 'frog://setup') { e.preventDefault(); clearTimeout(retryTimer); win.loadFile(path.join(__dirname, 'setup.html')); return; }
    if (config.url && !url.startsWith(config.url) && !url.startsWith('data:') && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  // No app menu on Windows/Linux, so wire the few window-level keys by hand.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (!isMac && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  const saveBounds = () => { if (!win.isFullScreen() && !win.isMaximized()) { config.bounds = win.getBounds(); writeConfig(config); } };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; });
  load();
}

ipcMain.on('notify', (_e, { title, body, id }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!win) createWindow();
    win.show();
    win.focus();
    win.webContents.send('notification-click', id);
  });
  n.show();
  if (win && !win.isFocused()) isMac ? app.dock?.bounce('informational') : win.flashFrame(true);
});
ipcMain.on('badge', (_e, n) => {
  if (isMac) app.dock?.setBadge(n ? String(n) : '');
  else app.setBadgeCount?.(n || 0);
});
// Double-clicking frog's header acts like a native title bar. On macOS honour the
// system setting (Desktop & Dock → "Double-click a window's title bar to").
ipcMain.on('toggle-maximize', () => {
  if (!win || win.isFullScreen()) return;
  const action = isMac ? systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') : 'Maximize';
  if (action === 'None') return;
  if (action === 'Minimize') { win.minimize(); return; }
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('get-server', () => config.url || '');
ipcMain.handle('set-server', (_e, url) => {
  config = { ...config, url: url.replace(/\/+$/, '') };
  writeConfig(config);
  load();
});

function buildMenu() {
  if (!isMac) {
    // Chromium handles copy/paste itself on Windows/Linux; a menu would steal Ctrl keys.
    Menu.setApplicationMenu(null);
    return;
  }
  // No accelerators for ⌘T/⌘W/⌘D etc.: the web app owns those.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Frog', submenu: [
      { role: 'about' },
      { label: 'Change Server…', click: () => win?.loadFile(path.join(__dirname, 'setup.html')) },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    ] },
    { label: 'View', submenu: [
      { label: 'Reload Frog', accelerator: 'CmdOrCtrl+Shift+Alt+R', click: () => load() },
      { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); else win.show(); });
});
app.on('window-all-closed', () => app.quit());
