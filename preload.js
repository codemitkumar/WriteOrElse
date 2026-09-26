const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  getStats: () => ipcRenderer.invoke('stats:get'),
  queryLogs: (filter) => ipcRenderer.invoke('logs:query', filter),

  addBook: (title) => ipcRenderer.invoke('book:add', title),
  renameBook: (bookId, title) => ipcRenderer.invoke('book:rename', { bookId, title }),
  markCompleted: (bookId, totalChapters) => ipcRenderer.invoke('book:markCompleted', { bookId, totalChapters }),
  startEditing: (bookId) => ipcRenderer.invoke('book:startEditing', bookId),
  needsPlanning: (bookId) => ipcRenderer.invoke('book:needsPlanning', bookId),
  cancelPlanning: (bookId) => ipcRenderer.invoke('book:cancelPlanning', bookId),
  reopenDraft: (bookId) => ipcRenderer.invoke('book:reopenDraft', bookId),
  setPaused: (bookId, paused) => ipcRenderer.invoke('book:setPaused', { bookId, paused }),
  setTargetWords: (bookId, words) => ipcRenderer.invoke('book:setTargetWords', { bookId, words }),
  deleteBook: (bookId) => ipcRenderer.invoke('book:delete', bookId),

  addIdea: (title, notes) => ipcRenderer.invoke('idea:add', { title, notes }),
  updateIdea: (ideaId, title, notes) => ipcRenderer.invoke('idea:update', { ideaId, title, notes }),
  deleteIdea: (ideaId) => ipcRenderer.invoke('idea:delete', ideaId),
  promoteIdea: (ideaId) => ipcRenderer.invoke('idea:promote', ideaId),

  logProgress: (payload) => ipcRenderer.invoke('log:add', payload),
  deleteLog: (logId) => ipcRenderer.invoke('log:delete', logId),

  toggleRestDay: () => ipcRenderer.invoke('day:toggleRest'),
  rerollTarget: (index) => ipcRenderer.invoke('day:reroll', index),
  setDifficulty: (mode) => ipcRenderer.invoke('day:setDifficulty', mode),
  rerollBonus: (index) => ipcRenderer.invoke('day:rerollBonus', index),
  pickTomorrow: (bookId) => ipcRenderer.invoke('reward:pickTomorrow', bookId),

  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),

  pickCover: (bookId) => ipcRenderer.invoke('book:pickCover', bookId),
  setCoverPath: (bookId, filePath) => ipcRenderer.invoke('book:setCoverPath', { bookId, filePath }),
  clearCover: (bookId) => ipcRenderer.invoke('book:clearCover', bookId),
  setBlurb: (bookId, blurb) => ipcRenderer.invoke('book:setBlurb', { bookId, blurb }),
  setChaptersEdited: (bookId, count) => ipcRenderer.invoke('book:setChaptersEdited', { bookId, count }),
  markEditingDone: (bookId) => ipcRenderer.invoke('book:markEditingDone', bookId),
  setChaptersPlanned: (bookId, count) => ipcRenderer.invoke('book:setChaptersPlanned', { bookId, count }),
  setChaptersWritten: (bookId, count) => ipcRenderer.invoke('book:setChaptersWritten', { bookId, count }),
  setWordsWritten: (bookId, words) => ipcRenderer.invoke('book:setWordsWritten', { bookId, words }),
  setTotalChapters: (bookId, count) => ipcRenderer.invoke('book:setTotalChapters', { bookId, count }),

  listApps: () => ipcRenderer.invoke('apps:list'),

  exportData: () => ipcRenderer.invoke('data:export'),
  revealData: () => ipcRenderer.invoke('data:reveal'),

  onOpenLogModal: (cb) => ipcRenderer.on('open-log-modal', cb),
  onStateChanged: (cb) => ipcRenderer.on('state-changed', cb)
});
