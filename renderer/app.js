let state = null;
let currentView = 'dashboard';
const ui = { search: '', sort: 'recent', showPaused: false };

const el = (id) => document.getElementById(id);
const fmt = (n) => (n || 0).toLocaleString();

function toFileUrl(p) {
  if (!p) return '';
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

// Every cover for a book reuses one filename, so the URL alone can't tell the
// browser a replacement happened. coverUpdatedAt changes only when the cover
// does, so this busts the cache on a swap without re-fetching on every render.
function coverUrl(book) {
  if (!book || !book.coverPath) return '';
  return toFileUrl(book.coverPath) + '?v=' + (book.coverUpdatedAt || 0);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emptyState(icon, text) {
  return `<div class="empty-state"><span class="empty-icon">${icon}</span><span>${escapeHtml(text)}</span></div>`;
}

function prettyDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function relativeDate(ds) {
  if (!state) return ds;
  if (ds === state.today) return 'Today';
  const a = new Date(state.today + 'T00:00:00');
  const b = new Date(ds + 'T00:00:00');
  const diff = Math.round((a - b) / 86400000);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff}d ago`;
  return ds.slice(5);
}

// ---------------- Toasts ----------------
function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toastStack').appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

// ---------------- Modals ----------------
function openModal(id) { el(id).classList.remove('hidden'); }
function closeModal(id) { el(id).classList.add('hidden'); }
function anyModalOpen() { return !!document.querySelector('.modal-backdrop:not(.hidden)'); }

let confirmResolver = null;
function confirmDialog({ title, body, okLabel = 'Confirm', danger = true }) {
  el('confirmTitle').textContent = title;
  el('confirmBody').textContent = body || '';
  el('confirmOkBtn').textContent = okLabel;
  el('confirmOkBtn').className = 'btn ' + (danger ? 'danger' : 'primary');
  openModal('confirmModalBackdrop');
  return new Promise(resolve => { confirmResolver = resolve; });
}
function settleConfirm(value) {
  closeModal('confirmModalBackdrop');
  if (confirmResolver) { confirmResolver(value); confirmResolver = null; }
}
el('confirmOkBtn').addEventListener('click', () => settleConfirm(true));
el('confirmCancelBtn').addEventListener('click', () => settleConfirm(false));

function closeTopModal() {
  const open = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')];
  if (!open.length) return false;
  const top = open[open.length - 1];
  if (top.id === 'confirmModalBackdrop') settleConfirm(false);
  else top.classList.add('hidden');
  return true;
}

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target !== backdrop) return;
    if (backdrop.id === 'confirmModalBackdrop') settleConfirm(false);
    else backdrop.classList.add('hidden');
  });
});
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('.modal-backdrop').classList.add('hidden'));
});

// ---------------- Boot / refresh ----------------
async function refresh() {
  state = await window.api.getState();
  applyAppearance(state.settings);
  render();
}

function render() {
  renderDashboard();
  renderBooks();
  renderStats();
  renderHeatmap();
  renderLogFilters();
}

function applyAppearance(s) {
  document.documentElement.dataset.theme = s.theme || 'dark';
  document.documentElement.dataset.accent = s.accent || 'ember';
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'settings') renderSettings();
  if (view === 'history') refreshLogList();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.goto));
});

// ---------------- Dashboard ----------------
function ringHtml(pct, big, small, met) {
  const r = 44;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(100, pct)) / 100);
  const stroke = met ? 'var(--green)' : 'url(#ringGrad)';
  return `<div class="ring-wrap">
    <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
      <defs>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--accent)" />
          <stop offset="100%" stop-color="var(--accent-2)" />
        </linearGradient>
      </defs>
      <circle class="ring-track" cx="52" cy="52" r="${r}" fill="none" stroke-width="9" />
      <circle class="ring-fill" cx="52" cy="52" r="${r}" fill="none" stroke-width="9" stroke-linecap="round"
        style="stroke:${stroke}" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" />
    </svg>
    <div class="ring-center"><div class="ring-pct">${big}</div><div class="ring-sub">${small}</div></div>
  </div>`;
}

function targetProgressToday() {
  const t = state.target;
  if (!t) return 0;
  return state.todaysLogs
    .filter(l => l.bookId === t.bookId && l.type === t.type)
    .reduce((a, l) => a + l.amount, 0);
}

function renderDashboard() {
  const st = state.stats;
  el('streakNum').textContent = state.streak.current;
  el('streakPill').classList.toggle('lit', state.streak.current > 0);
  el('streakBest').innerHTML = state.streak.longest ? `best<br>${state.streak.longest}` : '';

  el('targetDate').textContent = prettyDate(state.today);

  const target = state.target;
  const book = state.targetBook;
  const card = el('targetCard');
  card.classList.toggle('is-met', !!(target && target.met));
  card.classList.toggle('is-rest', state.isRestDay);

  const done = targetProgressToday();
  const pct = target ? Math.min(100, Math.round((done / target.amount) * 100)) : 0;

  el('targetProgressFill').style.width = pct + '%';
  el('targetProgressFill').classList.toggle('complete', !!(target && target.met));

  if (state.isRestDay) {
    el('targetTag').textContent = 'Rest day';
    el('targetTag').className = 'hero-tag rest';
    el('targetTitle').textContent = 'Today is a declared day off.';
    el('targetSub').textContent = 'Your streak is protected and the nagging is switched off. Log something anyway if the mood strikes.';
  } else if (!target || !book) {
    el('targetTag').textContent = "Today's Mission";
    el('targetTag').className = 'hero-tag';
    el('targetTitle').textContent = 'No target today';
    el('targetSub').textContent = 'Add a book in the Books tab to get your first mission.';
  } else {
    el('targetTag').textContent = target.met ? 'Mission complete' : "Today's Mission";
    el('targetTag').className = 'hero-tag' + (target.met ? ' met' : '');
    if (target.type === 'plan') {
      el('targetTitle').textContent = `Plan your next chapter of "${book.title}"`;
    } else {
      const verb = target.type === 'write' ? 'Write' : 'Edit';
      const unit = target.type === 'write' ? 'words' : (target.amount === 1 ? 'chapter' : 'chapters');
      el('targetTitle').textContent = `${verb} ${fmt(target.amount)} ${unit} of "${book.title}"`;
    }
    if (target.met) {
      el('targetSub').textContent = "Done. Streak's safe today.";
    } else if (target.type === 'plan') {
      el('targetSub').textContent = 'No word count today — just figure out what happens next, then log it as planned.';
    } else if (target.type === 'write') {
      el('targetSub').textContent = `${fmt(Math.max(0, target.amount - done))} words to go. Word count is whatever your writing tool reports.`;
    } else {
      el('targetSub').textContent = 'Mark chapters as edited when you finish a pass on them.';
    }
  }

  if (target && !state.isRestDay) {
    el('targetProgressCaption').textContent = target.type === 'plan'
      ? (target.met ? 'Planned — complete' : 'One chapter outline')
      : `${fmt(done)} / ${fmt(target.amount)}${target.met ? ' — complete' : ''}`;
  } else {
    el('targetProgressCaption').textContent = '';
  }

  const cover = el('targetCoverImg');
  if (book && book.coverPath) {
    cover.src = coverUrl(book);
    cover.classList.remove('hidden');
  } else {
    cover.classList.add('hidden');
  }

  const blurb = el('targetBlurb');
  if (book && book.blurb) {
    blurb.textContent = book.blurb;
    blurb.classList.remove('hidden');
  } else {
    blurb.classList.add('hidden');
  }

  // Ring
  if (target && !state.isRestDay) {
    const big = target.type === 'plan' ? (target.met ? '✓' : '—') : pct + '%';
    el('heroRing').innerHTML = ringHtml(target.met ? 100 : pct, big, target.type === 'plan' ? 'plan' : 'of target', target.met);
  } else {
    el('heroRing').innerHTML = ringHtml(state.isRestDay ? 100 : 0, state.isRestDay ? '☁' : '—', state.isRestDay ? 'resting' : 'idle', false);
  }

  renderQuickAdd(target, done);
  renderBonus();

  // Reroll / rest controls
  const reroll = el('rerollBtn');
  reroll.disabled = !state.canReroll;
  el('rerollLabel').textContent = state.rerollsLeft > 0 ? `Reroll (${state.rerollsLeft})` : 'Reroll';
  reroll.title = state.canReroll
    ? "Swap today's target for a different one"
    : 'Rerolls are only available before you log anything, and while you have one left';
  const rest = el('restDayBtn');
  rest.textContent = state.isRestDay ? 'Cancel rest day' : `Rest day (${state.restDaysLeft})`;
  rest.disabled = !state.isRestDay && state.restDaysLeft <= 0;

  // Metrics
  const delta = st.words7 - st.wordsPrev7;
  el('weekDelta').textContent = st.wordsPrev7
    ? `${delta >= 0 ? '+' : ''}${fmt(delta)} vs previous week`
    : `${fmt(st.words7)} words this week`;
  el('weekDelta').className = 'card-note ' + (st.wordsPrev7 ? (delta >= 0 ? 'up' : 'down') : '');

  el('metricRow').innerHTML = [
    metricCard('Current streak', state.streak.current, `longest ${state.streak.longest}`, state.streak.current > 0 ? 'accent' : ''),
    metricCard('Words today', fmt(st.wordsToday), target && target.type === 'write' ? `target ${fmt(target.amount)}` : 'no word target today'),
    metricCard('This week', fmt(st.words7), 'last 7 days'),
    metricCard('Word level', fmt(state.wordTarget.current), `cap ${fmt(state.wordTarget.cap)}`),
    metricCard('Consistency', st.consistency + '%', 'targets met, 10 weeks', st.consistency >= 70 ? 'good' : '')
  ].join('');

  // Mini chart, last 14 days. All-zero days render as 3px slivers, which reads as
  // a broken chart rather than an empty one — say so instead.
  const days = st.history.slice(-14);
  const max = Math.max(1, ...days.map(d => d.words));
  if (!days.some(d => d.words > 0)) {
    el('miniChart').innerHTML = emptyState('&#128202;', 'No words logged in the last 14 days.');
    el('miniChart').classList.add('is-empty');
  } else {
    el('miniChart').classList.remove('is-empty');
    el('miniChart').innerHTML = days.map((d, i) => {
      const h = d.words ? Math.max(4, Math.round((d.words / max) * 100)) : 3;
      const cls = d.words ? (d.status === 'rest' ? 'rest' : '') : (d.status === 'rest' ? 'rest' : 'empty');
      const label = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'narrow' });
      return `<div class="mini-col ${d.date === state.today ? 'today' : ''}" title="${prettyDate(d.date)} — ${fmt(d.words)} words">
        <div class="mini-bar-wrap"><div class="mini-bar ${cls}" style="height:${h}%;animation-delay:${i * 18}ms"></div></div>
        <div class="mini-tick">${label}</div>
      </div>`;
    }).join('');
  }

  // Recent activity
  const recent = state.recentLogs.slice(0, 8);
  el('recentActivity').innerHTML = recent.length
    ? recent.map(l => activityItemHtml(l, false)).join('')
    : emptyState('&#128221;', 'Nothing logged yet.');

  // Stage counts
  const counts = { planning: 0, writing: 0, completed: 0, editing: 0, done: 0 };
  state.books.forEach(b => { counts[b.stage] = (counts[b.stage] || 0) + 1; });
  el('statsRow').innerHTML = STAGE_ORDER.map(stage =>
    `<div class="stat-chip" data-stage="${stage}"><div class="num">${counts[stage]}</div><div class="label">${STAGE_LABEL[stage]}</div></div>`
  ).join('');
  el('statsRow').querySelectorAll('[data-stage]').forEach(chip => {
    chip.addEventListener('click', () => switchView('books'));
  });
}

function metricCard(label, value, sub, valueClass = '') {
  return `<div class="metric-card">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value ${valueClass}">${value}</div>
    <div class="metric-sub">${escapeHtml(sub)}</div>
  </div>`;
}

// Hitting the target doesn't mean you stopped working — this opens the full log
// dialog on the same book and type so an over-target session gets counted too.
function extraChipLabel(type) {
  if (type === 'edit') return 'I edited extra…';
  if (type === 'plan') return 'I planned extra…';
  return 'I wrote extra…';
}

function quickAddChips(task, done) {
  const remaining = Math.max(0, task.amount - done);
  if (task.met) return [];
  if (task.type === 'write') {
    const chips = [100, 250, 500].filter(n => n < remaining).map(n => ({ label: `+${n}`, amount: n }));
    if (remaining > 0) chips.push({ label: `+${fmt(remaining)} (finish)`, amount: remaining });
    return chips;
  }
  if (task.type === 'edit') {
    const chips = [{ label: '+1 chapter', amount: 1 }];
    if (remaining > 1) chips.push({ label: `+${remaining} (finish)`, amount: remaining });
    return chips;
  }
  return [{ label: 'Mark chapter planned', amount: 1 }];
}

function renderQuickAdd(target, done) {
  const row = el('quickAddRow');
  if (!target || state.isRestDay) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  const chips = quickAddChips(target, done)
    .map(c => `<button class="chip" data-amount="${c.amount}">${escapeHtml(c.label)}</button>`);
  chips.push(`<button class="chip extra" data-extra="1">${escapeHtml(extraChipLabel(target.type))}</button>`);
  row.innerHTML = chips.join('');
  row.classList.remove('hidden');
  row.querySelectorAll('[data-amount]').forEach(btn => {
    btn.addEventListener('click', () => quickLog(parseInt(btn.dataset.amount, 10)));
  });
  const extra = row.querySelector('[data-extra]');
  if (extra) extra.addEventListener('click', () => openLogModal(target.bookId, target.type, true));
}

function describeTask(task, book, done) {
  const title = book ? book.title : 'your book';
  if (task.type === 'plan') return `Plan another chapter of "${title}"`;
  const verb = task.type === 'write' ? 'Write' : 'Edit';
  const unit = task.type === 'write' ? 'more words' : (task.amount === 1 ? 'chapter' : 'chapters');
  return `${verb} ${fmt(task.amount)} ${unit} of "${title}"`;
}

function renderBonus() {
  const card = el('bonusCard');
  const bonus = state.bonus;
  if (!bonus) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  card.classList.toggle('is-met', !!bonus.met);

  const done = state.bonusDone || 0;
  const cleared = state.bonusCleared || 0;
  const round = state.bonusRound || 1;
  const pct = bonus.met ? 100 : Math.min(100, Math.round((done / bonus.amount) * 100));
  el('bonusTag').textContent = bonus.met ? 'Bonus complete' : (round > 1 ? `Bonus round ${round}` : 'Bonus round');
  // A cleared round normally hands out the next one straight away, so this only
  // reads "met" when nothing was left to offer (no eligible books, or the day
  // has run out).
  el('bonusTitle').textContent = bonus.met
    ? 'Bonus done. Nothing more is asked of you today.'
    : describeTask(bonus, state.bonusBook, done);
  el('bonusFree').textContent = cleared
    ? `${cleared} cleared today · the next one is still optional`
    : 'Optional — skipping it costs you nothing';
  el('bonusProgressFill').style.width = pct + '%';
  el('bonusProgressFill').classList.toggle('complete', !!bonus.met);
  el('bonusProgressCaption').textContent = bonus.type === 'plan'
    ? (bonus.met ? 'Planned' : 'One chapter outline')
    : `${fmt(done)} / ${fmt(bonus.amount)}`;

  const row = el('bonusQuickAdd');
  const chips = quickAddChips(bonus, done)
    .map(c => `<button class="chip" data-bonus-amount="${c.amount}">${escapeHtml(c.label)}</button>`);
  chips.push(`<button class="chip extra" data-extra="1">${escapeHtml(extraChipLabel(bonus.type))}</button>`);
  row.innerHTML = chips.join('');
  row.classList.remove('hidden');
  row.querySelectorAll('[data-bonus-amount]').forEach(btn => {
    btn.addEventListener('click', () => quickLogBonus(parseInt(btn.dataset.bonusAmount, 10)));
  });
  const extra = row.querySelector('[data-extra]');
  if (extra) extra.addEventListener('click', () => openLogModal(bonus.bookId, bonus.type, true));
}

async function quickLogBonus(amount) {
  const bonus = state.bonus;
  if (!bonus) return;
  const clearedBefore = state.bonusCleared || 0;
  state = await window.api.logProgress({ bookId: bonus.bookId, type: bonus.type, amount, note: '', chapterComplete: false });
  render();
  if ((state.bonusCleared || 0) > clearedBefore) {
    toast(state.bonus && !state.bonus.met
      ? 'Bonus round cleared. Here comes another.'
      : 'Bonus round cleared. Show-off.', 'good');
  } else {
    toast('Bonus progress logged.', 'good');
  }
}

async function quickLog(amount) {
  const target = state.target;
  if (!target) return;
  state = await window.api.logProgress({ bookId: target.bookId, type: target.type, amount, note: '', chapterComplete: false });
  render();
  if (state.target && state.target.met) toast("Target met. Streak's safe today.", 'good');
  else toast(`Logged ${target.type === 'write' ? fmt(amount) + ' words' : amount + ' chapter(s)'}.`, 'good');
}

function logVerb(l) {
  if (l.type === 'write') return `+${fmt(l.amount)} words`;
  if (l.type === 'plan') return 'Chapter planned';
  return `${l.amount} chapter${l.amount === 1 ? '' : 's'} edited`;
}

function activityItemHtml(l, deletable) {
  const b = state.books.find(x => x.id === l.bookId);
  return `<div class="activity-item">
    <div class="activity-main">
      <span class="type-dot ${l.type}"></span>
      <span class="what">${escapeHtml(logVerb(l))}</span>
      <span class="where">&mdash; ${escapeHtml(b ? b.title : 'Deleted book')}${l.note ? ' <span class="activity-note">' + escapeHtml(l.note) + '</span>' : ''}</span>
    </div>
    <div class="activity-right">
      <span class="meta">${relativeDate(l.date)}</span>
      ${deletable ? `<button class="icon-btn" data-del-log="${l.id}" title="Delete this entry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
      </button>` : ''}
    </div>
  </div>`;
}

// ---------------- Books ----------------
const STAGE_ORDER = ['planning', 'writing', 'completed', 'editing', 'done'];
const STAGE_LABEL = { planning: 'Planning', writing: 'Writing', completed: 'Completed', editing: 'Editing', done: 'Done' };

function sortBooks(books) {
  const copy = books.slice();
  if (ui.sort === 'title') copy.sort((a, b) => a.title.localeCompare(b.title));
  else if (ui.sort === 'words') copy.sort((a, b) => (b.wordsWritten || 0) - (a.wordsWritten || 0));
  else if (ui.sort === 'created') copy.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else copy.sort((a, b) => (b.lastWorkedAt || '').localeCompare(a.lastWorkedAt || ''));
  return copy;
}

function renderBooks() {
  const needle = ui.search.trim().toLowerCase();
  const visible = state.books.filter(b => {
    if (b.paused && !ui.showPaused) return false;
    if (needle && !b.title.toLowerCase().includes(needle) && !(b.blurb || '').toLowerCase().includes(needle)) return false;
    return true;
  });

  const cols = STAGE_ORDER.map(stage => {
    const books = sortBooks(visible.filter(b => b.stage === stage));
    const cards = books.map(bookCardHtml).join('') || emptyState('&#128230;', 'Empty');
    return `<div class="book-col"><h3>${STAGE_LABEL[stage]} <span class="count">${books.length}</span></h3>${cards}</div>`;
  }).join('');
  el('bookColumns').innerHTML = cols;

  el('bookColumns').querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onBookAction(btn.dataset.action, btn.dataset.id));
  });
  el('bookColumns').querySelectorAll('[data-menu]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (openMenu && openMenu.trigger === btn) closeCardMenu();
      else openCardMenu(btn, btn.dataset.menu);
    });
  });
}

function bookProgress(b) {
  if (b.stage === 'editing' && b.totalChapters) {
    return Math.min(100, Math.round(((b.chaptersEdited || 0) / b.totalChapters) * 100));
  }
  if (b.stage === 'writing' && b.targetWords) {
    return Math.min(100, Math.round(((b.wordsWritten || 0) / b.targetWords) * 100));
  }
  if (b.stage === 'done') return 100;
  return null;
}

function bookMeta(b) {
  if (b.stage === 'planning') {
    let meta = `Waiting to be planned &middot; no word count while it's here`;
    if (b.chaptersPlanned) meta += ` &middot; ${b.chaptersPlanned} planned`;
    return meta;
  }
  if (b.stage === 'writing') {
    let meta = `${fmt(b.wordsWritten)} words`;
    if (b.targetWords) {
      const pct = Math.min(100, Math.round(((b.wordsWritten || 0) / b.targetWords) * 100));
      meta += ` of ${fmt(b.targetWords)} (${pct}%)`;
    }
    if (b.chaptersWritten) meta += ` &middot; ${b.chaptersWritten} chapter(s)`;
    return meta;
  }
  if (b.stage === 'completed') return `${b.totalChapters} chapters total &middot; ready to edit`;
  if (b.stage === 'editing') {
    let meta = `${b.chaptersEdited || 0} / ${b.totalChapters} chapters edited`;
    meta += b.id === state.activeEditingBookId ? ' &middot; in progress' : ' &middot; queued';
    return meta;
  }
  return `Fully edited &middot; ${b.totalChapters} chapters &middot; ${fmt(b.wordsWritten)} words`;
}

// One obvious action stays on the card; everything else lives behind the kebab,
// otherwise a five-column board turns into five columns of button soup.
const PRIMARY_ACTION = {
  writing: { action: 'markCompleted', label: 'Mark drafted' },
  completed: { action: 'startEditing', label: 'Start editing' },
  editing: { action: 'logEdit', label: 'Log chapters' },
  planning: { action: 'cancelPlanning', label: 'Back to writing', ghost: true }
};

function bookMenuItems(b) {
  const items = [{ action: 'details', label: 'Details, cover & goal…' }];
  if (b.stage === 'writing') items.push({ action: 'needsPlanning', label: 'Flag as needing planning' });
  if (b.stage === 'editing') items.push({ action: 'markEditingDone', label: 'Mark fully edited' });
  if (b.stage === 'completed') items.push({ action: 'reopenDraft', label: 'Back to writing' });
  if (b.stage !== 'done') items.push({ action: 'togglePause', label: b.paused ? 'Resume in rotation' : 'Pause from rotation' });
  items.push({ sep: true });
  items.push({ action: 'delete', label: 'Delete book', danger: true });
  return items;
}

function bookCardHtml(b) {
  const isTarget = state.target && state.target.bookId === b.id;
  const primary = PRIMARY_ACTION[b.stage];
  const actions = primary
    ? `<button class="btn ${primary.ghost ? 'ghost' : 'primary'}" data-action="${primary.action}" data-id="${b.id}">${primary.label}</button>`
    : '';

  // A book with no cover gets a thin stage-coloured spine instead of a 46px
  // placeholder — in a five-column board that width is worth more to the title.
  const cover = b.coverPath
    ? `<img class="cover-thumb" src="${coverUrl(b)}" alt="" />`
    : `<div class="book-spine ${b.stage}"></div>`;

  const pct = bookProgress(b);
  const progress = pct == null ? '' : `<div class="card-progress" title="${pct}%"><i style="width:${pct}%"></i></div>`;

  return `
    <div class="book-card ${isTarget ? 'is-target' : ''} ${b.paused ? 'is-paused' : ''}">
      ${cover}
      <button class="card-kebab" data-menu="${b.id}" title="More actions" aria-label="More actions">&#8942;</button>
      <div class="card-body">
        <div class="badge-row">
          <span class="badge ${b.stage}">${STAGE_LABEL[b.stage]}</span>
          ${isTarget ? '<span class="badge today">Today</span>' : ''}
          ${b.paused ? '<span class="badge paused">Paused</span>' : ''}
        </div>
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="meta">${bookMeta(b)}</div>
        ${progress}
        ${actions ? `<div class="actions">${actions}</div>` : ''}
      </div>
    </div>
  `;
}

// ---- card overflow menu ----
let openMenu = null;
function closeCardMenu() {
  if (!openMenu) return;
  openMenu.node.remove();
  openMenu.trigger.classList.remove('open');
  openMenu = null;
}

function openCardMenu(trigger, bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  closeCardMenu();

  const node = document.createElement('div');
  node.className = 'popmenu';
  node.innerHTML = bookMenuItems(book).map(item => item.sep
    ? '<div class="sep"></div>'
    : `<button data-action="${item.action}" class="${item.danger ? 'danger' : ''}">${escapeHtml(item.label)}</button>`
  ).join('');
  document.body.appendChild(node);

  const rect = trigger.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  node.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
  node.style.top = (rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 4 : rect.bottom + 4) + 'px';

  node.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      closeCardMenu();
      onBookAction(action, bookId);
    });
  });

  trigger.classList.add('open');
  openMenu = { node, trigger };
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.node.contains(e.target) && !e.target.closest('.card-kebab')) closeCardMenu();
});
window.addEventListener('blur', closeCardMenu);
document.querySelector('.content').addEventListener('scroll', closeCardMenu, { passive: true });

async function onBookAction(action, id) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;

  if (action === 'delete') {
    const ok = await confirmDialog({
      title: `Delete "${book.title}"?`,
      body: 'The book disappears from every board. Its log entries stay in history but lose their title. This cannot be undone.',
      okLabel: 'Delete book'
    });
    if (!ok) return;
    state = await window.api.deleteBook(id);
    render();
    toast('Book deleted.');
  } else if (action === 'markCompleted') {
    openChaptersModal(id);
  } else if (action === 'startEditing') {
    state = await window.api.startEditing(id);
    render();
    toast(`"${book.title}" moved to Editing.`, 'good');
  } else if (action === 'needsPlanning') {
    state = await window.api.needsPlanning(id);
    render();
    toast('Flagged for planning — no word counts until you plan a chapter.');
  } else if (action === 'cancelPlanning') {
    state = await window.api.cancelPlanning(id);
    render();
    toast('Back to writing.');
  } else if (action === 'reopenDraft') {
    state = await window.api.reopenDraft(id);
    render();
    toast('Back in the writing rotation.');
  } else if (action === 'logEdit') {
    openLogModal(id, 'edit');
  } else if (action === 'togglePause') {
    state = await window.api.setPaused(id, !book.paused);
    render();
    toast(book.paused ? 'Resumed — it can be picked again.' : 'Paused — it will not be picked for daily targets.');
  } else if (action === 'markEditingDone') {
    const ok = await confirmDialog({
      title: 'Mark as fully edited?',
      body: `"${book.title}" moves to Done and stops appearing in daily targets.`,
      okLabel: 'Mark done',
      danger: false
    });
    if (!ok) return;
    state = await window.api.markEditingDone(id);
    render();
    toast('Finished. That one is done.', 'good');
  } else if (action === 'details') {
    openDetailsModal(id);
  }
}

el('addBookBtn').addEventListener('click', async () => {
  const title = el('newBookTitle').value.trim();
  if (!title) { el('newBookTitle').focus(); return; }
  state = await window.api.addBook(title);
  el('newBookTitle').value = '';
  render();
  toast(`"${title}" added.`, 'good');
});
el('newBookTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('addBookBtn').click(); });

el('bookSearch').addEventListener('input', (e) => { ui.search = e.target.value; renderBooks(); });
el('bookSort').addEventListener('change', (e) => { ui.sort = e.target.value; renderBooks(); });
el('showPaused').addEventListener('change', (e) => { ui.showPaused = e.target.checked; renderBooks(); });

// ---------------- Stats ----------------
function renderStats() {
  const st = state.stats;
  el('statMetrics').innerHTML = [
    metricCard('Total words', fmt(st.totalWords), `${st.writingDays} writing day(s)`, 'accent'),
    metricCard('Avg / writing day', fmt(st.avgPerWritingDay), 'words'),
    metricCard('Best day', fmt(st.bestDay.words), st.bestDay.date ? prettyDate(st.bestDay.date) : 'nothing yet'),
    metricCard('Targets met', st.targetsMet, `${st.targetsMissed} missed`, st.targetsMet ? 'good' : ''),
    metricCard('Books done', st.booksDone, `${state.books.length} total`),
    metricCard('Chapters edited', fmt(st.totalChapters), `${st.totalPlans} chapters planned`)
  ].join('');

  const days = st.history.slice(-30);
  const max = Math.max(1, ...days.map(d => d.words));
  el('chartNote').textContent = `peak ${fmt(max)} words`;
  el('wordsChart').innerHTML = days.map((d, i) => {
    const h = d.words ? Math.max(3, Math.round((d.words / max) * 100)) : 2;
    const showLabel = i % 5 === 0 || i === days.length - 1;
    return `<div class="wc-col" title="${prettyDate(d.date)} — ${fmt(d.words)} words">
      <div class="wc-bar ${d.words ? '' : 'zero'}" style="height:${h}%;animation-delay:${i * 12}ms"></div>
      <div class="wc-label">${showLabel ? d.date.slice(5) : ''}</div>
    </div>`;
  }).join('');

  const ranked = state.books.slice().sort((a, b) => (b.wordsWritten || 0) - (a.wordsWritten || 0)).slice(0, 8);
  const topWords = Math.max(1, ...ranked.map(b => b.wordsWritten || 0));
  el('bookBars').innerHTML = ranked.length && topWords > 1 ? ranked.map(b => `
    <div class="bb-row">
      <div class="bb-head">
        <span class="bb-title">${escapeHtml(b.title)}</span>
        <span class="bb-val">${fmt(b.wordsWritten)}${b.targetWords ? ' / ' + fmt(b.targetWords) : ''}</span>
      </div>
      <div class="bb-track"><div class="bb-fill" style="width:${Math.round(((b.wordsWritten || 0) / topWords) * 100)}%"></div></div>
    </div>`).join('') : emptyState('&#128202;', 'No words logged yet.');

  el('recordsList').innerHTML = [
    ['Longest streak', `${state.streak.longest} day(s)`],
    ['Best single day', st.bestDay.date ? `${fmt(st.bestDay.words)} words` : '—'],
    ['Words in last 30 days', fmt(st.words30)],
    ['Chapters edited', fmt(st.totalChapters)],
    ['Chapters planned', fmt(st.totalPlans)],
    ['Rest days taken', `${st.restDaysTaken} (10 weeks)`],
    ['Log entries', fmt(st.totalLogs)]
  ].map(([k, v]) => `<div class="record-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('');
}

// ---------------- History ----------------
const WEEKDAY_ROWS = ['', 'M', '', 'W', '', 'F', ''];

function renderHeatmap() {
  const days = state.stats.history;
  el('heatWeekdays').innerHTML = WEEKDAY_ROWS.map(d => `<div class="heat-weekday">${d}</div>`).join('');

  const lead = new Date(days[0].date + 'T00:00:00').getDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  days.forEach(d => cells.push(d));
  while (cells.length % 7 !== 0) cells.push(null);

  el('heatmap').innerHTML = cells.map(d => {
    if (!d) return `<div class="heat-cell future"></div>`;
    const bits = [];
    if (d.target) bits.push(`${d.target.type} ${fmt(d.target.amount)}`);
    if (d.words) bits.push(`${fmt(d.words)} words`);
    if (d.chapters) bits.push(`${d.chapters} chapter(s)`);
    const label = `${prettyDate(d.date)} — ${d.status}${bits.length ? ' — ' + bits.join(', ') : ''}`;
    return `<div class="heat-cell ${d.status}${d.date === state.today ? ' today' : ''}" title="${escapeHtml(label)}"></div>`;
  }).join('');

  // Month labels sit above the week columns they start in.
  let lastMonth = '';
  const labels = [];
  for (let c = 0; c < cells.length / 7; c++) {
    const week = cells.slice(c * 7, c * 7 + 7).filter(Boolean);
    const first = week[0];
    if (!first) { labels.push(''); continue; }
    const month = first.date.slice(0, 7);
    if (month !== lastMonth && parseInt(first.date.slice(8), 10) <= 14) {
      lastMonth = month;
      labels.push(new Date(first.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }));
    } else {
      labels.push('');
    }
  }
  el('heatMonths').innerHTML = labels.map(l => `<div class="heat-month">${l}</div>`).join('');

  const st = state.stats;
  el('heatSummary').innerHTML = [
    ['Targets met', st.targetsMet, 'good'],
    ['Missed', st.targetsMissed, st.targetsMissed ? 'bad' : ''],
    ['Rest days', st.restDaysTaken, ''],
    ['Consistency', st.consistency + '%', st.consistency >= 70 ? 'good' : ''],
    ['Current streak', `${state.streak.current}d`, ''],
    ['Words logged', fmt(days.reduce((a, d) => a + d.words, 0)), '']
  ].map(([k, v, cls]) => `<div class="hs-row"><span>${k}</span><b class="${cls}">${v}</b></div>`).join('');
}

function renderLogFilters() {
  const select = el('logFilterBook');
  const previous = select.value;
  select.innerHTML = '<option value="">All books</option>' +
    state.books.map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`).join('');
  if (previous && state.books.some(b => b.id === previous)) select.value = previous;
}

async function refreshLogList() {
  const { logs, total } = await window.api.queryLogs({
    bookId: el('logFilterBook').value || undefined,
    type: el('logFilterType').value || undefined,
    limit: 200
  });
  el('logList').innerHTML = logs.length
    ? logs.map(l => activityItemHtml(l, true)).join('')
    : emptyState('&#128197;', total ? 'No entries match this filter.' : 'Nothing logged yet.');
  el('logList').querySelectorAll('[data-del-log]').forEach(btn => {
    btn.addEventListener('click', () => onDeleteLog(btn.dataset.delLog));
  });
}

async function onDeleteLog(logId) {
  const ok = await confirmDialog({
    title: 'Delete this entry?',
    body: 'Its words or chapters are subtracted from the book. If it was what completed that day’s target, the streak is walked back too.',
    okLabel: 'Delete entry'
  });
  if (!ok) return;
  state = await window.api.deleteLog(logId);
  render();
  refreshLogList();
  toast('Entry removed.');
}

el('logFilterBook').addEventListener('change', refreshLogList);
el('logFilterType').addEventListener('change', refreshLogList);

// ---------------- Chapters modal ----------------
let pendingChaptersBookId = null;
function openChaptersModal(bookId) {
  pendingChaptersBookId = bookId;
  openModal('chaptersModalBackdrop');
  el('totalChaptersInput').focus();
  el('totalChaptersInput').select();
}
el('chaptersSubmitBtn').addEventListener('click', async () => {
  const total = parseInt(el('totalChaptersInput').value, 10) || 1;
  state = await window.api.markCompleted(pendingChaptersBookId, total);
  closeModal('chaptersModalBackdrop');
  render();
  toast(`Drafted at ${total} chapters. Start editing when you're ready.`, 'good');
});

// ---------------- Book details modal ----------------
let pendingDetailsBookId = null;

// The chapter-count field means something different depending on where the
// book is in its life — planning a chapter isn't the same as having edited
// one — so show whichever counter actually applies to its current stage.
function detailsChapterFieldConfig(book) {
  if (book.stage === 'planning') return { label: 'Chapters planned so far', field: 'planned', value: book.chaptersPlanned || 0 };
  if (book.stage === 'writing') return { label: 'Chapters written so far', field: 'written', value: book.chaptersWritten || 0 };
  if (book.stage === 'completed') return { label: 'Total chapters', field: 'total', value: book.totalChapters || 0 };
  if (book.stage === 'editing') return { label: `Chapters edited (of ${book.totalChapters || 0})`, field: 'edited', value: book.chaptersEdited || 0, max: book.totalChapters };
  return null; // 'done' — nothing left to track
}

// Words only mean anything while there's still drafting to do — once a book is
// edited-and-done its total is history, but it's still worth showing.
function detailsTracksWords(book) {
  return book.stage !== 'planning';
}

// Live preview of the word-goal bar so you can see what you're typing do
// something, instead of saving and hunting for the card.
function refreshDetailsProgress() {
  const words = Math.max(0, parseInt(el('detailsWordsInput').value, 10) || 0);
  const goal = Math.max(0, parseInt(el('detailsTargetWordsInput').value, 10) || 0);
  const row = el('detailsProgressRow');
  if (el('detailsWordsRow').classList.contains('hidden') || !goal) {
    row.classList.add('hidden');
    return;
  }
  const pct = Math.min(100, Math.round((words / goal) * 100));
  row.classList.remove('hidden');
  el('detailsProgressLabel').textContent = `${fmt(words)} of ${fmt(goal)} words`;
  el('detailsProgressPct').textContent = `${pct}%`;
  el('detailsProgressFill').style.width = `${pct}%`;
}

function openDetailsModal(bookId) {
  pendingDetailsBookId = bookId;
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  refreshDetailsCoverPreview(book);
  el('detailsTitleInput').value = book.title;
  el('detailsBlurbInput').value = book.blurb || '';
  el('detailsTargetWordsInput').value = book.targetWords || '';

  const cfg = detailsChapterFieldConfig(book);
  if (cfg) {
    el('detailsChaptersRow').classList.remove('hidden');
    el('detailsChaptersLabel').textContent = cfg.label;
    el('detailsChaptersInput').value = cfg.value;
    el('detailsChaptersInput').dataset.field = cfg.field;
    if (cfg.max != null) el('detailsChaptersInput').max = cfg.max;
    else el('detailsChaptersInput').removeAttribute('max');
  } else {
    el('detailsChaptersRow').classList.add('hidden');
  }

  if (detailsTracksWords(book)) {
    el('detailsWordsRow').classList.remove('hidden');
    el('detailsWordsInput').value = book.wordsWritten || 0;
  } else {
    el('detailsWordsRow').classList.add('hidden');
    el('detailsWordsInput').value = '';
  }
  refreshDetailsProgress();
  openModal('detailsModalBackdrop');
}

el('detailsWordsInput').addEventListener('input', refreshDetailsProgress);
el('detailsTargetWordsInput').addEventListener('input', refreshDetailsProgress);

function refreshDetailsCoverPreview(book) {
  if (book.coverPath) {
    el('detailsCoverPreview').src = coverUrl(book);
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
el('detailsClearCoverBtn').addEventListener('click', async () => {
  state = await window.api.clearCover(pendingDetailsBookId);
  const book = state.books.find(b => b.id === pendingDetailsBookId);
  if (book) refreshDetailsCoverPreview(book);
  render();
});

// Drag an image straight onto the cover slot instead of hunting through a file dialog.
const coverRow = document.querySelector('.details-cover-row');
coverRow.addEventListener('dragover', (e) => { e.preventDefault(); coverRow.classList.add('drag-over'); });
coverRow.addEventListener('dragleave', () => coverRow.classList.remove('drag-over'));
coverRow.addEventListener('drop', async (e) => {
  e.preventDefault();
  coverRow.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file || !file.path) return;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.path)) { toast('That is not an image file.', 'bad'); return; }
  state = await window.api.setCoverPath(pendingDetailsBookId, file.path);
  const book = state.books.find(b => b.id === pendingDetailsBookId);
  if (book) refreshDetailsCoverPreview(book);
  render();
  toast('Cover updated.', 'good');
});

const CHAPTER_FIELD_SETTERS = {
  planned: (id, v) => window.api.setChaptersPlanned(id, v),
  written: (id, v) => window.api.setChaptersWritten(id, v),
  total: (id, v) => window.api.setTotalChapters(id, v),
  edited: (id, v) => window.api.setChaptersEdited(id, v)
};

el('detailsSaveBtn').addEventListener('click', async () => {
  const id = pendingDetailsBookId;
  const title = el('detailsTitleInput').value.trim();
  if (title) state = await window.api.renameBook(id, title);
  state = await window.api.setBlurb(id, el('detailsBlurbInput').value.trim());
  state = await window.api.setTargetWords(id, el('detailsTargetWordsInput').value);
  if (!el('detailsWordsRow').classList.contains('hidden')) {
    state = await window.api.setWordsWritten(id, el('detailsWordsInput').value);
  }
  if (!el('detailsChaptersRow').classList.contains('hidden')) {
    const field = el('detailsChaptersInput').dataset.field;
    const setter = CHAPTER_FIELD_SETTERS[field];
    if (setter) state = await setter(id, el('detailsChaptersInput').value);
  }
  closeModal('detailsModalBackdrop');
  render();
  toast('Details saved.', 'good');
});

// ---------------- Settings ----------------
function renderSettings() {
  const s = state.settings;
  el('setTheme').value = s.theme || 'dark';
  document.querySelectorAll('.swatch').forEach(sw => sw.classList.toggle('selected', sw.dataset.accent === (s.accent || 'ember')));
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
  el('setRestDaysPerWeek').value = s.restDaysPerWeek;
  el('setRerollsPerDay').value = s.rerollsPerDay;
  el('setBonusEnabled').checked = s.bonusTasksEnabled;
  el('setAutoLaunch').checked = s.autoLaunch;
}

// Theme and accent preview live — they are only persisted on save, like every
// other setting, but you shouldn't have to save to see what you picked.
el('setTheme').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.value; });
document.querySelectorAll('.swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.documentElement.dataset.accent = sw.dataset.accent;
    document.querySelectorAll('.swatch').forEach(o => o.classList.toggle('selected', o === sw));
  });
});

el('saveSettingsBtn').addEventListener('click', async () => {
  const selected = document.querySelector('.swatch.selected');
  const partial = {
    theme: el('setTheme').value,
    accent: selected ? selected.dataset.accent : 'ember',
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
    restDaysPerWeek: Math.max(0, parseInt(el('setRestDaysPerWeek').value, 10) || 0),
    rerollsPerDay: Math.max(0, parseInt(el('setRerollsPerDay').value, 10) || 0),
    bonusTasksEnabled: el('setBonusEnabled').checked,
    autoLaunch: el('setAutoLaunch').checked
  };
  state = await window.api.updateSettings(partial);
  applyAppearance(state.settings);
  render();
  toast('Settings saved.', 'good');
});

el('exportDataBtn').addEventListener('click', async () => {
  const res = await window.api.exportData();
  if (res.ok) toast('Backup written.', 'good');
});
el('revealDataBtn').addEventListener('click', () => window.api.revealData());

// ---------------- Rest day / reroll ----------------
el('restDayBtn').addEventListener('click', async () => {
  const res = await window.api.toggleRestDay();
  state = res.state;
  render();
  toast(res.message, res.ok ? 'good' : 'bad');
});

el('rerollBtn').addEventListener('click', async () => {
  if (!state.canReroll) return;
  const res = await window.api.rerollTarget();
  state = res.state;
  render();
  toast(res.message, res.ok ? 'good' : 'bad');
});

// ---------------- Log modal ----------------
// `extra` is the "I wrote extra..." entry point from a task card: same form, but
// it says what it's for, since the task it belongs to is already finished.
function openLogModal(presetBookId, presetType, extra = false) {
  const options = state.books.filter(b => b.stage !== 'done');
  if (!options.length) { toast('Add a book first.', 'bad'); switchView('books'); return; }
  el('logBookSelect').innerHTML = options.map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`).join('');

  if (presetBookId && options.some(b => b.id === presetBookId)) {
    el('logBookSelect').value = presetBookId;
    el('logTypeSelect').value = presetType || 'write';
  } else if (state.target && options.some(b => b.id === state.target.bookId)) {
    // Trust today's actual assigned type as-is (a writing book may have randomly
    // gotten a planning day) rather than re-deriving it from the book's stage.
    el('logBookSelect').value = state.target.bookId;
    el('logTypeSelect').value = state.target.type;
  } else {
    syncLogTypeToStage();
  }
  syncLogForm();
  el('logModalTitle').textContent = extra ? 'Log extra work' : 'Log progress';
  el('logAmountInput').value = '';
  el('logNoteInput').value = '';
  el('chapterCompleteInput').checked = false;
  openModal('logModalBackdrop');
  setTimeout(() => el('logAmountInput').focus(), 30);
}

function syncLogTypeToStage() {
  const book = state.books.find(b => b.id === el('logBookSelect').value);
  if (!book) return;
  if (book.stage === 'editing') el('logTypeSelect').value = 'edit';
  else if (book.stage === 'planning') el('logTypeSelect').value = 'plan';
  else el('logTypeSelect').value = 'write';
}

function syncLogForm() {
  const type = el('logTypeSelect').value;
  el('chapterCompleteRow').classList.toggle('hidden', type !== 'write');
  el('logAmountRow').classList.toggle('hidden', type === 'plan');
  el('logAmountLabel').textContent = type === 'edit' ? 'How many chapters?' : 'How many words?';

  const presets = type === 'write' ? [250, 500, 750, 1000] : type === 'edit' ? [1, 2, 3] : [];
  const row = el('logPresetRow');
  row.innerHTML = presets.map(n => `<button class="chip" data-preset="${n}">${fmt(n)}</button>`).join('');
  row.classList.toggle('hidden', presets.length === 0);
  row.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => { el('logAmountInput').value = btn.dataset.preset; el('logAmountInput').focus(); });
  });
}

el('logBookSelect').addEventListener('change', () => { syncLogTypeToStage(); syncLogForm(); });
el('logTypeSelect').addEventListener('change', syncLogForm);
el('logProgressBtnMain').addEventListener('click', () => openLogModal());
el('logProgressBtnSide').addEventListener('click', () => openLogModal());
el('shortcutsBtn').addEventListener('click', () => openModal('shortcutsModalBackdrop'));

el('logSubmitBtn').addEventListener('click', async () => {
  const bookId = el('logBookSelect').value;
  const type = el('logTypeSelect').value;
  const amount = type === 'plan' ? 1 : (parseInt(el('logAmountInput').value, 10) || 0);
  const note = el('logNoteInput').value;
  const chapterComplete = type === 'write' && el('chapterCompleteInput').checked;
  if (!bookId) return;
  if (amount <= 0) { toast('Enter an amount above zero.', 'bad'); el('logAmountInput').focus(); return; }

  const wasMet = !!(state.target && state.target.met);
  state = await window.api.logProgress({ bookId, type, amount, note, chapterComplete });
  closeModal('logModalBackdrop');
  render();
  if (currentView === 'history') refreshLogList();
  if (!wasMet && state.target && state.target.met) toast("Target met. Streak's safe today.", 'good');
  else toast('Progress logged.', 'good');
});

// ---------------- Keyboard ----------------
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  if (e.key === 'Escape') { if (closeTopModal()) e.preventDefault(); return; }

  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const open = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')].pop();
    if (open) { e.preventDefault(); open.querySelector('.btn.primary, .btn.danger')?.click(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); openLogModal(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault(); switchView('books'); el('newBookTitle').focus(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault(); if (state && state.canReroll) el('rerollBtn').click(); return;
  }
  if (typing || anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;

  const views = { '1': 'dashboard', '2': 'books', '3': 'stats', '4': 'history', '5': 'settings' };
  if (views[e.key]) { e.preventDefault(); switchView(views[e.key]); }
});

// ---------------- Wiring ----------------
window.api.onOpenLogModal(() => openLogModal());
window.api.onStateChanged(() => refresh());

refresh();
// Keep the day rollover honest without yanking the UI out from under an open dialog.
setInterval(() => { if (!anyModalOpen()) refresh(); }, 60 * 1000);
