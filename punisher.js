// Background nag/escalation logic. Runs regardless of whether the main window is open.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let nagWin = null;
let shameWin = null;
let checkTimer = null;

function killProcesses(names) {
  names.forEach(name => {
    exec(`taskkill /IM "${name}" /F`, () => {});
  });
}

function anyRunning(names, cb) {
  exec('tasklist', (err, stdout) => {
    if (err || !stdout) return cb(false);
    const lower = stdout.toLowerCase();
    cb(names.some(n => lower.includes(n.toLowerCase())));
  });
}

function closeNag() {
  if (nagWin && !nagWin.isDestroyed()) nagWin.close();
  nagWin = null;
}

function closeShame() {
  if (shameWin && !shameWin.isDestroyed()) shameWin.close();
  shameWin = null;
}

function describeTarget(target, bookTitle) {
  if (target.type === 'write') return `Write ${target.amount.toLocaleString()} words of "${bookTitle}"`;
  if (target.type === 'plan') return `Plan your next chapter of "${bookTitle}"`;
  return `Edit ${target.amount} chapter(s) of "${bookTitle}"`;
}

function showNag(store, onFocusMain) {
  if (nagWin && !nagWin.isDestroyed()) return;
  const state = store.getState();
  const target = state.target;
  if (!target) return;
  const bookTitle = state.targetBook ? state.targetBook.title : 'your book';
  const desc = describeTarget(target, bookTitle);

  const disp = screen.getPrimaryDisplay().workAreaSize;
  nagWin = new BrowserWindow({
    width: 380,
    height: 200,
    x: disp.width - 400,
    y: disp.height - 220,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'renderer', 'nag_preload.js') }
  });
  nagWin.setAlwaysOnTop(true, 'screen-saver');
  nagWin.loadFile(path.join(__dirname, 'renderer', 'nag.html'), {
    query: { desc, escalated: '0', accent: store.data.settings.accent || 'ember' }
  });
  nagWin.once('ready-to-show', () => nagWin && nagWin.show());

  const { ipcMain } = require('electron');
  const onSnooze = () => {
    store.bumpSnooze();
    closeNag();
    cleanup();
  };
  const onLogNow = () => {
    closeNag();
    cleanup();
    onFocusMain();
  };
  function cleanup() {
    ipcMain.removeListener('nag:snooze', onSnooze);
    ipcMain.removeListener('nag:lognow', onLogNow);
  }
  ipcMain.once('nag:snooze', onSnooze);
  ipcMain.once('nag:lognow', onLogNow);
  nagWin.on('closed', cleanup);
}

function showShame(store, onFocusMain) {
  if (shameWin && !shameWin.isDestroyed()) return;
  const settings = store.data.settings;
  anyRunning(settings.distractionProcesses, (running) => {
    if (running) killProcesses(settings.distractionProcesses);

    const state = store.getState();
    const target = state.target;
    const bookTitle = state.targetBook ? state.targetBook.title : 'your book';
    const desc = target ? describeTarget(target, bookTitle) : 'log today\'s progress';

    shameWin = new BrowserWindow({
      fullscreen: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'renderer', 'nag_preload.js') }
    });
    shameWin.setAlwaysOnTop(true, 'screen-saver');
    shameWin.loadFile(path.join(__dirname, 'renderer', 'nag.html'), {
      query: { desc, escalated: '1', accent: settings.accent || 'ember' }
    });
    shameWin.once('ready-to-show', () => shameWin && shameWin.show());

    const { ipcMain } = require('electron');
    const onSnooze = () => {
      store.bumpSnooze();
      closeShame();
      cleanup();
    };
    const onLogNow = () => {
      closeShame();
      cleanup();
      onFocusMain();
    };
    function cleanup() {
      ipcMain.removeListener('nag:snooze', onSnooze);
      ipcMain.removeListener('nag:lognow', onLogNow);
    }
    ipcMain.once('nag:snooze', onSnooze);
    ipcMain.once('nag:lognow', onLogNow);
    shameWin.on('closed', cleanup);
  });
}

function tick(store, onFocusMain) {
  const settings = store.data.settings;
  if (!settings.punishmentEnabled) return;
  if (store.isTargetMetToday()) {
    closeNag();
    closeShame();
    return;
  }
  const now = new Date();
  const hour = now.getHours();
  if (hour < settings.punishmentStartHour || hour >= settings.punishmentEndHour) return;

  const ps = store.getPunishState();
  const intervalMs = settings.checkIntervalMinutes * 60 * 1000;
  const last = ps.lastNagAt ? new Date(ps.lastNagAt).getTime() : 0;
  if (Date.now() - last < intervalMs) return;

  if (ps.escalated) {
    store.setLastNagAt();
    showShame(store, onFocusMain);
  } else {
    if (Math.random() <= settings.nagProbability) {
      store.setLastNagAt();
      showNag(store, onFocusMain);
    }
  }
}

function start(store, onFocusMain) {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => tick(store, onFocusMain), 60 * 1000);
  // also run once shortly after start
  setTimeout(() => tick(store, onFocusMain), 5000);
}

function stop() {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
  closeNag();
  closeShame();
}

module.exports = { start, stop };
