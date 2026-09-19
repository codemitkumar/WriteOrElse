const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const punisher = require('./punisher');

let mainWindow = null;
let tray = null;
let store = null;
let trayTimer = null;
let boundsTimer = null;

function getDataPath() {
  return path.join(app.getPath('userData'), 'write-or-else-data.json');
}

function saveBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    store.setWindowBounds(mainWindow.getNormalBounds());
  }, 400);
}

// Saved bounds go stale when a monitor is unplugged, and Windows will happily
// restore a window onto coordinates nobody can see. Only trust bounds that still
// overlap a live display.
function usableBounds(saved) {
  if (!saved || !saved.width || !saved.height) return null;
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return saved.x < a.x + a.width && saved.x + saved.width > a.x &&
           saved.y < a.y + a.height && saved.y + saved.height > a.y;
  });
  return visible ? saved : null;
}

function createWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const saved = usableBounds(store.data.windowBounds);
  mainWindow = new BrowserWindow({
    width: saved?.width || 1120,
    height: saved?.height || 760,
    x: saved?.x,
    y: saved?.y,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0c0e12',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', saveBoundsSoon);
  mainWindow.on('move', saveBoundsSoon);
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      saveBoundsSoon();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function focusMainAndLog() {
  const alreadyLoaded = mainWindow && !mainWindow.webContents.isLoading();
  createWindow();
  mainWindow.show();
  mainWindow.focus();
  // A window created by this very call has no renderer yet, so the message would
  // land in the void — wait for the first load in that case.
  if (alreadyLoaded) mainWindow.webContents.send('open-log-modal');
  else mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('open-log-modal'));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function describeTargetShort(state) {
  if (state.isRestDay) return 'Rest day — nothing due';
  if (!state.target || !state.targetBook) return 'No target today';
  const t = state.target;
  const title = state.targetBook.title;
  if (t.type === 'plan') return `Plan a chapter of "${title}"`;
  if (t.type === 'write') return `Write ${t.amount} words of "${title}"`;
  return `Edit ${t.amount} chapter(s) of "${title}"`;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const state = store.getState();
  const done = state.target ? state.target.met : true;
  const summary = describeTargetShort(state);
  tray.setToolTip(`Write or Else — ${summary}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: summary, enabled: false },
    { label: done ? '✓ Target met today' : `Streak: ${state.streak.current} day(s)`, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => createWindow() },
    { label: 'Log progress…', click: () => focusMainAndLog() },
    {
      label: state.isRestDay ? 'Cancel rest day' : `Take a rest day (${state.restDaysLeft} left)`,
      enabled: state.isRestDay || state.restDaysLeft > 0,
      click: () => { store.toggleRestDay(); refreshTray(); sendToRenderer('state-changed'); }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.on('click', () => createWindow());
  refreshTray();
  trayTimer = setInterval(refreshTray, 60 * 1000);
}

app.whenReady().then(() => {
  store = new Store(getDataPath());
  app.setLoginItemSettings({ openAtLogin: !!store.data.settings.autoLaunch });

  createWindow();
  createTray();
  punisher.start(store, focusMainAndLog);

  globalShortcut.register('CommandOrControl+Alt+W', () => focusMainAndLog());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // keep running in the tray
});

app.on('before-quit', () => {
  app.isQuiting = true;
  clearInterval(trayTimer);
  globalShortcut.unregisterAll();
  punisher.stop();
});

// ---- IPC ----

// Every mutating handler funnels through here so the tray label never drifts
// out of sync with what the dashboard is showing.
function withTrayRefresh(fn) {
  return (...args) => {
    const result = fn(...args);
    if (result && typeof result.then === 'function') return result.then(r => { refreshTray(); return r; });
    refreshTray();
    return result;
  };
}

ipcMain.handle('state:get', () => store.getState());
ipcMain.handle('stats:get', () => store.getStats());
ipcMain.handle('logs:query', (e, filter) => store.queryLogs(filter || {}));

ipcMain.handle('book:add', withTrayRefresh((e, title) => { store.addBook(title); return store.getState(); }));
ipcMain.handle('book:markCompleted', withTrayRefresh((e, { bookId, totalChapters }) => {
  store.markCompleted(bookId, totalChapters);
  return store.getState();
}));
ipcMain.handle('book:startEditing', withTrayRefresh((e, bookId) => {
  store.startEditing(bookId);
  return store.getState();
}));
ipcMain.handle('book:needsPlanning', withTrayRefresh((e, bookId) => {
  store.needsPlanning(bookId);
  return store.getState();
}));
ipcMain.handle('book:cancelPlanning', withTrayRefresh((e, bookId) => {
  store.cancelPlanning(bookId);
  return store.getState();
}));
ipcMain.handle('book:delete', withTrayRefresh((e, bookId) => {
  store.deleteBook(bookId);
  return store.getState();
}));
ipcMain.handle('book:reopenDraft', withTrayRefresh((e, bookId) => store.reopenDraft(bookId)));
ipcMain.handle('book:rename', withTrayRefresh((e, { bookId, title }) => store.renameBook(bookId, title)));
ipcMain.handle('book:setPaused', withTrayRefresh((e, { bookId, paused }) => store.setPaused(bookId, paused)));
ipcMain.handle('book:setTargetWords', (e, { bookId, words }) => store.setTargetWords(bookId, words));

ipcMain.handle('log:add', withTrayRefresh((e, payload) => store.logProgress(payload)));
ipcMain.handle('log:delete', withTrayRefresh((e, logId) => store.deleteLog(logId)));

ipcMain.handle('day:toggleRest', withTrayRefresh(() => store.toggleRestDay()));
ipcMain.handle('day:reroll', withTrayRefresh(() => store.rerollTarget()));

ipcMain.handle('book:pickCover', async (e, bookId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a book cover',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return store.getState();
  return store.setCover(bookId, result.filePaths[0]);
});
ipcMain.handle('book:setCoverPath', (e, { bookId, filePath }) => store.setCover(bookId, filePath));
ipcMain.handle('book:clearCover', (e, bookId) => store.clearCover(bookId));

ipcMain.handle('book:setBlurb', (e, { bookId, blurb }) => store.setBlurb(bookId, blurb));

ipcMain.handle('book:setChaptersEdited', withTrayRefresh((e, { bookId, count }) => store.setChaptersEdited(bookId, count)));
ipcMain.handle('book:markEditingDone', withTrayRefresh((e, bookId) => store.markEditingDone(bookId)));
ipcMain.handle('book:setChaptersPlanned', (e, { bookId, count }) => store.setChaptersPlanned(bookId, count));
ipcMain.handle('book:setChaptersWritten', (e, { bookId, count }) => store.setChaptersWritten(bookId, count));
ipcMain.handle('book:setWordsWritten', (e, { bookId, words }) => store.setWordsWritten(bookId, words));
ipcMain.handle('book:setTotalChapters', (e, { bookId, count }) => store.setTotalChapters(bookId, count));

ipcMain.handle('settings:update', withTrayRefresh((e, partial) => {
  const updated = store.updateSettings(partial);
  app.setLoginItemSettings({ openAtLogin: !!updated.autoLaunch });
  return store.getState();
}));

ipcMain.handle('data:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Write or Else data',
    defaultPath: `write-or-else-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.writeFileSync(result.filePath, JSON.stringify(store.data, null, 2), 'utf-8');
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('data:reveal', () => {
  shell.showItemInFolder(getDataPath());
  return { ok: true };
});
