const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nag', {
  snooze: () => ipcRenderer.send('nag:snooze'),
  logNow: () => ipcRenderer.send('nag:lognow')
});
