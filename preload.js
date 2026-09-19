const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  addBook: (title) => ipcRenderer.invoke('book:add', title),
  markCompleted: (bookId, totalChapters) => ipcRenderer.invoke('book:markCompleted', { bookId, totalChapters }),
  startEditing: (bookId) => ipcRenderer.invoke('book:startEditing', bookId),
  needsPlanning: (bookId) => ipcRenderer.invoke('book:needsPlanning', bookId),
  cancelPlanning: (bookId) => ipcRenderer.invoke('book:cancelPlanning', bookId),
  deleteBook: (bookId) => ipcRenderer.invoke('book:delete', bookId),
  logProgress: (payload) => ipcRenderer.invoke('log:add', payload),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  pickCover: (bookId) => ipcRenderer.invoke('book:pickCover', bookId),
  setBlurb: (bookId, blurb) => ipcRenderer.invoke('book:setBlurb', { bookId, blurb }),
  onOpenLogModal: (cb) => ipcRenderer.on('open-log-modal', cb)
});
