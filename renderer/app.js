let state = null;

const el = (id) => document.getElementById(id);

function toFileUrl(p) {
  if (!p) return '';
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function refresh() {
  state = await window.api.getState();
  render();
}

function switchView(view) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function render() {
  renderDashboard();
  renderBooks();
  renderHistory();
  renderSettings();
}

// ---------------- Dashboard ----------------
function renderDashboard() {
  el('streakNum').textContent = state.streak.current;

  const target = state.target;
  const book = state.targetBook;
  if (!target || !book) {
    el('targetTitle').textContent = 'No target today';
    el('targetSub').textContent = 'Add a book in the Books tab to get your first mission.';
    el('targetProgressFill').style.width = '0%';
    el('targetProgressCaption').textContent = '';
    el('targetCoverImg').classList.add('hidden');
    el('targetBlurb').classList.add('hidden');
  } else {
    if (target.type === 'plan') {
      el('targetTitle').textContent = `Plan your next chapter of "${book.title}"`;
    } else {
      const verb = target.type === 'write' ? 'Write' : 'Edit';
      const unit = target.type === 'write' ? 'words' : 'chapter(s)';
      el('targetTitle').textContent = `${verb} ${target.amount} ${unit} of "${book.title}"`;
    }
    const sumToday = state.todaysLogs
      .filter(l => l.bookId === target.bookId && l.type === target.type)
      .reduce((a, l) => a + l.amount, 0);
    const pct = Math.min(100, Math.round((sumToday / target.amount) * 100));
    el('targetProgressFill').style.width = pct + '%';
    if (target.met) {
      el('targetSub').textContent = "Done. Streak's safe today.";
      el('targetProgressCaption').textContent = target.type === 'plan' ? 'Planned — complete' : `${sumToday} / ${target.amount} — complete`;
    } else if (target.type === 'plan') {
      el('targetSub').textContent = 'No word count today — just figure out what happens next, then log it as planned.';
      el('targetProgressCaption').textContent = '';
    } else {
      el('targetSub').textContent = target.type === 'write'
        ? 'Word count is whatever your writing tool reports — enter it manually below.'
        : 'Mark chapters as edited when you finish a pass on them.';
      el('targetProgressCaption').textContent = `${sumToday} / ${target.amount}`;
    }

    if (book.coverPath) {
      el('targetCoverImg').src = toFileUrl(book.coverPath);
      el('targetCoverImg').classList.remove('hidden');
    } else {
      el('targetCoverImg').classList.add('hidden');
    }
    if (book.blurb) {
      el('targetBlurb').textContent = book.blurb;
      el('targetBlurb').classList.remove('hidden');
    } else {
      el('targetBlurb').classList.add('hidden');
    }
  }

  const counts = { planning: 0, writing: 0, completed: 0, editing: 0, done: 0 };
  state.books.forEach(b => counts[b.stage] = (counts[b.stage] || 0) + 1);
  el('statsRow').innerHTML = `
    <div class="stat-chip"><div class="num">${counts.planning}</div><div class="label">Planning</div></div>
    <div class="stat-chip"><div class="num">${counts.writing}</div><div class="label">Writing</div></div>
    <div class="stat-chip"><div class="num">${counts.completed}</div><div class="label">Completed</div></div>
    <div class="stat-chip"><div class="num">${counts.editing}</div><div class="label">Editing</div></div>
    <div class="stat-chip"><div class="num">${counts.done}</div><div class="label">Done</div></div>
    <div class="stat-chip"><div class="num">${state.wordTarget.current}</div><div class="label">Word level / ${state.wordTarget.cap}</div></div>
  `;

  const recent = state.recentLogs.slice(0, 8);
  el('recentActivity').innerHTML = recent.length ? recent.map(l => {
    const b = state.books.find(x => x.id === l.bookId);
    const verb = logVerb(l);
    return `<div class="activity-item"><span>${verb} — ${b ? b.title : 'Unknown'}</span><span class="meta">${l.date}</span></div>`;
  }).join('') : `<div class="empty-hint">Nothing logged yet.</div>`;
}

function logVerb(l) {
  if (l.type === 'write') return `+${l.amount} words`;
  if (l.type === 'plan') return 'Chapter planned';
  return `${l.amount} chapter(s) edited`;
}

// ---------------- Books ----------------
const STAGE_ORDER = ['planning', 'writing', 'completed', 'editing', 'done'];
const STAGE_LABEL = { planning: 'Planning', writing: 'Writing', completed: 'Completed', editing: 'Editing', done: 'Done' };

function renderBooks() {
  const cols = STAGE_ORDER.map(stage => {
    const books = state.books.filter(b => b.stage === stage);
    const cards = books.map(b => bookCardHtml(b)).join('') || `<div class="empty-hint">Empty</div>`;
    return `<div class="book-col"><h3>${STAGE_LABEL[stage]} (${books.length})</h3>${cards}</div>`;
  }).join('');
  el('bookColumns').innerHTML = cols;

  el('bookColumns').querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onBookAction(btn.dataset.action, btn.dataset.id));
  });
}

function bookCardHtml(b) {
  let meta = '';
  if (b.stage === 'planning') meta = `Waiting to be planned &middot; no word count while it's here`;
  else if (b.stage === 'writing') meta = `${b.wordsWritten || 0} words written so far`;
  else if (b.stage === 'completed') meta = `${b.totalChapters} chapters total &middot; ready to edit`;
  else if (b.stage === 'editing') {
    meta = `${b.chaptersEdited || 0} / ${b.totalChapters} chapters edited`;
    meta += b.id === state.activeEditingBookId ? ' &middot; in progress' : ' &middot; queued (waiting its turn)';
  }
  else if (b.stage === 'done') meta = `Fully edited &middot; ${b.totalChapters} chapters`;

  let actions = `<button class="btn ghost" data-action="details" data-id="${b.id}">Details</button>`;
  if (b.stage === 'planning') {
    actions = `<button class="btn ghost" data-action="cancelPlanning" data-id="${b.id}">Back to writing</button>` + actions;
  } else if (b.stage === 'writing') {
    actions = `<button class="btn primary" data-action="markCompleted" data-id="${b.id}">Mark drafted</button>`
      + `<button class="btn ghost" data-action="needsPlanning" data-id="${b.id}">Needs planning</button>` + actions;
  } else if (b.stage === 'completed') {
    actions = `<button class="btn primary" data-action="startEditing" data-id="${b.id}">Start editing</button>` + actions;
  }
  actions += `<button class="btn ghost" data-action="delete" data-id="${b.id}">Delete</button>`;

  const cover = b.coverPath
    ? `<img class="cover-thumb" src="${toFileUrl(b.coverPath)}" alt="" />`
    : `<div class="cover-thumb-placeholder">&#128214;</div>`;

  return `
    <div class="book-card">
      ${cover}
      <div class="card-body">
        <span class="badge ${b.stage}">${STAGE_LABEL[b.stage]}</span>
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="meta">${meta}</div>
        <div class="actions">${actions}</div>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function onBookAction(action, id) {
  if (action === 'delete') {
    if (!confirm('Delete this book and its history reference? This cannot be undone.')) return;
    state = await window.api.deleteBook(id);
    render();
  } else if (action === 'markCompleted') {
    openChaptersModal(id);
  } else if (action === 'startEditing') {
    state = await window.api.startEditing(id);
    render();
  } else if (action === 'needsPlanning') {
    state = await window.api.needsPlanning(id);
    render();
  } else if (action === 'cancelPlanning') {
    state = await window.api.cancelPlanning(id);
    render();
  } else if (action === 'details') {
    openDetailsModal(id);
  }
}

el('addBookBtn').addEventListener('click', async () => {
  const title = el('newBookTitle').value.trim();
  if (!title) return;
  await window.api.addBook(title);
  el('newBookTitle').value = '';
  await refresh();
});
el('newBookTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('addBookBtn').click(); });

// ---------------- Chapters modal ----------------
let pendingChaptersBookId = null;
function openChaptersModal(bookId) {
  pendingChaptersBookId = bookId;
  el('chaptersModalBackdrop').classList.remove('hidden');
}
el('chaptersCancelBtn').addEventListener('click', () => el('chaptersModalBackdrop').classList.add('hidden'));
el('chaptersSubmitBtn').addEventListener('click', async () => {
  const total = parseInt(el('totalChaptersInput').value, 10) || 1;
  await window.api.markCompleted(pendingChaptersBookId, total);
  el('chaptersModalBackdrop').classList.add('hidden');
  await refresh();
});

// ---------------- Book details modal (cover + blurb) ----------------
let pendingDetailsBookId = null;
function openDetailsModal(bookId) {
  pendingDetailsBookId = bookId;
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  refreshDetailsCoverPreview(book);
  el('detailsBlurbInput').value = book.blurb || '';
  el('detailsModalBackdrop').classList.remove('hidden');
}

function refreshDetailsCoverPreview(book) {
  if (book.coverPath) {
    el('detailsCoverPreview').src = toFileUrl(book.coverPath);
    el('detailsCoverPreview').classList.remove('hidden');
    el('detailsCoverPlaceholder').classList.add('hidden');
  } else {
    el('detailsCoverPreview').classList.add('hidden');
    el('detailsCoverPlaceholder').classList.remove('hidden');
  }
}

el('detailsChooseCoverBtn').addEventListener('click', async () => {
  state = await window.api.pickCover(pendingDetailsBookId);
  const book = state.books.find(b => b.id === pendingDetailsBookId);
  if (book) refreshDetailsCoverPreview(book);
  render();
});
el('detailsCancelBtn').addEventListener('click', () => el('detailsModalBackdrop').classList.add('hidden'));
el('detailsSaveBtn').addEventListener('click', async () => {
  state = await window.api.setBlurb(pendingDetailsBookId, el('detailsBlurbInput').value.trim());
  el('detailsModalBackdrop').classList.add('hidden');
  render();
});

// ---------------- History ----------------
function renderHistory() {
  el('logList').innerHTML = state.recentLogs.length ? state.recentLogs.map(l => {
    const b = state.books.find(x => x.id === l.bookId);
    const verb = logVerb(l);
    return `<div class="activity-item"><span>${verb} — ${b ? b.title : 'Unknown'}${l.note ? ' &mdash; ' + escapeHtml(l.note) : ''}</span><span class="meta">${l.date}</span></div>`;
  }).join('') : `<div class="empty-hint">Nothing logged yet.</div>`;

  // Heatmap: we only know today's target-met state reliably from server data we have;
  // approximate using recentLogs presence + today's target.
  const days = [];
  const today = new Date(state.today);
  for (let i = 34; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    days.push(ds);
  }
  el('heatmap').innerHTML = days.map(ds => {
    const hasLog = state.recentLogs.some(l => l.date === ds) || (ds === state.today && state.target && state.target.met);
    const cls = ds === state.today ? (state.target ? (state.target.met ? 'met' : 'inactive') : 'inactive')
      : (hasLog ? 'met' : 'inactive');
    return `<div class="heat-cell ${cls}" title="${ds}"></div>`;
  }).join('');
}

// ---------------- Settings ----------------
function renderSettings() {
  const s = state.settings;
  el('setPunishmentEnabled').checked = s.punishmentEnabled;
  el('setStartHour').value = s.punishmentStartHour;
  el('setEndHour').value = s.punishmentEndHour;
  el('setInterval').value = s.checkIntervalMinutes;
  el('setSnoozeThreshold').value = s.snoozeThreshold;
  el('setDistractions').value = s.distractionProcesses.join(', ');
  el('setStartWords').value = s.startWords;
  el('setWordIncrement').value = s.wordIncrement;
  el('setWordCap').value = s.wordCap;
  el('setMinChapters').value = s.minChapters;
  el('setMaxChapters').value = s.maxChapters;
  el('setPlanningProbability').value = Math.round(s.planningProbability * 100);
  el('setAutoLaunch').checked = s.autoLaunch;
}

el('saveSettingsBtn').addEventListener('click', async () => {
  const partial = {
    punishmentEnabled: el('setPunishmentEnabled').checked,
    punishmentStartHour: parseInt(el('setStartHour').value, 10),
    punishmentEndHour: parseInt(el('setEndHour').value, 10),
    checkIntervalMinutes: parseInt(el('setInterval').value, 10),
    snoozeThreshold: parseInt(el('setSnoozeThreshold').value, 10),
    distractionProcesses: el('setDistractions').value.split(',').map(s => s.trim()).filter(Boolean),
    startWords: parseInt(el('setStartWords').value, 10),
    wordIncrement: parseInt(el('setWordIncrement').value, 10),
    wordCap: parseInt(el('setWordCap').value, 10),
    minChapters: parseInt(el('setMinChapters').value, 10),
    maxChapters: parseInt(el('setMaxChapters').value, 10),
    planningProbability: Math.max(0, Math.min(100, parseInt(el('setPlanningProbability').value, 10) || 0)) / 100,
    autoLaunch: el('setAutoLaunch').checked
  };
  state = await window.api.updateSettings(partial);
  render();
});

// ---------------- Log modal ----------------
function openLogModal() {
  const options = state.books.filter(b => b.stage !== 'done');
  el('logBookSelect').innerHTML = options.map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`).join('');
  if (state.target) {
    // Trust today's actual assigned type as-is (a writing book may have randomly
    // gotten a planning day) rather than re-deriving it from the book's stage.
    el('logBookSelect').value = state.target.bookId;
    el('logTypeSelect').value = state.target.type;
    syncChapterCompleteVisibility();
    syncAmountVisibility();
  } else {
    syncLogTypeToStage();
  }
  el('logAmountInput').value = '';
  el('logNoteInput').value = '';
  el('chapterCompleteInput').checked = false;
  el('logModalBackdrop').classList.remove('hidden');
}

function syncLogTypeToStage() {
  const bookId = el('logBookSelect').value;
  const book = state.books.find(b => b.id === bookId);
  if (book && book.stage === 'editing') el('logTypeSelect').value = 'edit';
  else if (book && book.stage === 'planning') el('logTypeSelect').value = 'plan';
  else if (book && book.stage === 'writing') el('logTypeSelect').value = 'write';
  syncChapterCompleteVisibility();
  syncAmountVisibility();
}

function syncChapterCompleteVisibility() {
  const isWrite = el('logTypeSelect').value === 'write';
  el('chapterCompleteRow').classList.toggle('hidden', !isWrite);
}

function syncAmountVisibility() {
  el('logAmountRow').classList.toggle('hidden', el('logTypeSelect').value === 'plan');
}

el('logBookSelect').addEventListener('change', syncLogTypeToStage);
el('logTypeSelect').addEventListener('change', () => { syncChapterCompleteVisibility(); syncAmountVisibility(); });
el('logProgressBtnMain').addEventListener('click', openLogModal);
el('logProgressBtnSide').addEventListener('click', openLogModal);
el('logCancelBtn').addEventListener('click', () => el('logModalBackdrop').classList.add('hidden'));
el('logSubmitBtn').addEventListener('click', async () => {
  const bookId = el('logBookSelect').value;
  const type = el('logTypeSelect').value;
  const amount = type === 'plan' ? 1 : (parseInt(el('logAmountInput').value, 10) || 0);
  const note = el('logNoteInput').value;
  const chapterComplete = type === 'write' && el('chapterCompleteInput').checked;
  if (!bookId || amount <= 0) return;
  state = await window.api.logProgress({ bookId, type, amount, note, chapterComplete });
  el('logModalBackdrop').classList.add('hidden');
  render();
});

window.api.onOpenLogModal(() => openLogModal());

refresh();
setInterval(refresh, 60 * 1000);
