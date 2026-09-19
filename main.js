const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { Store } = require('./store');
const punisher = require('./punisher');

let mainWindow = null;
let tray = null;
let store = null;


function getDataPath() {
  return path.join(app.getPath('userData'), 'write-or-else-data.json');
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function focusMainAndLog() {
  createWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('open-log-modal');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Write or Else');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => createWindow() },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => createWindow());
}

app.whenReady().then(() => {
  store = new Store(getDataPath());
  app.setLoginItemSettings({ openAtLogin: !!store.data.settings.autoLaunch });

  createWindow();
  createTray();
  punisher.start(store, focusMainAndLog);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', (e) => {
  // keep running in the tray
});

app.on('before-quit', () => {
  app.isQuiting = true;
  punisher.stop();
});

// ---- IPC ----

ipcMain.handle('state:get', () => store.getState());

ipcMain.handle('book:add', (e, title) => store.addBook(title));
ipcMain.handle('book:markCompleted', (e, { bookId, totalChapters }) => {
  store.markCompleted(bookId, totalChapters);
  return store.getState();
});
ipcMain.handle('book:startEditing', (e, bookId) => {
  store.startEditing(bookId);
  return store.getState();
});
ipcMain.handle('book:needsPlanning', (e, bookId) => {
  store.needsPlanning(bookId);
  return store.getState();
});
ipcMain.handle('book:cancelPlanning', (e, bookId) => {
  store.cancelPlanning(bookId);
  return store.getState();
});
ipcMain.handle('book:delete', (e, bookId) => {
  store.deleteBook(bookId);
  return store.getState();
});

ipcMain.handle('log:add', (e, payload) => store.logProgress(payload));

ipcMain.handle('book:pickCover', async (e, bookId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a book cover',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return store.getState();
  return store.setCover(bookId, result.filePaths[0]);
});

ipcMain.handle('book:setBlurb', (e, { bookId, blurb }) => store.setBlurb(bookId, blurb));

ipcMain.handle('settings:update', (e, partial) => {
  const updated = store.updateSettings(partial);
  app.setLoginItemSettings({ openAtLogin: !!updated.autoLaunch });
  return store.getState();
});
