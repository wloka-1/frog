const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('frogDesktop', {
  platform: process.platform,
  notify: (n) => ipcRenderer.send('notify', n),
  setBadge: (n) => ipcRenderer.send('badge', n),
  onNotificationClick: (cb) => ipcRenderer.on('notification-click', (_e, id) => cb(id)),
  getServer: () => ipcRenderer.invoke('get-server'),
  setServer: (url) => ipcRenderer.invoke('set-server', url),
});
