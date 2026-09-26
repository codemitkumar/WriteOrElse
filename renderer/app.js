let state = null;
let currentView = 'dashboard';
const ui = { search: '', sort: 'recent', showPaused: false, ideaSearch: '', editingIdeaId: null, focusTask: null, focusBonus: null };

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
const TOAST_ICON = { good: '✓', bad: '!', '': '•' };

function toast(message, kind = '', duration = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = '<span class="toast-icon"></span><span class="toast-body"></span><i class="toast-timer"></i>';
  node.querySelector('.toast-icon').textContent = TOAST_ICON[kind] || TOAST_ICON[''];
  node.querySelector('.toast-body').textContent = message;
  node.querySelector('.toast-timer').style.animationDuration = duration + 'ms';
  el('toastStack').appendChild(node);

  // The drain bar pauses on hover (CSS), so the removal timer has to pause with
  // it — otherwise the bar freezes while the toast disappears under the cursor.
  let remaining = duration;
  let startedAt = 0;
  let timeoutId = null;
  const leave = () => {
    clearTimeout(timeoutId);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  };
  const arm = () => { startedAt = Date.now(); timeoutId = setTimeout(leave, remaining); };
  const hold = () => { clearTimeout(timeoutId); remaining = Math.max(400, remaining - (Date.now() - startedAt)); };
  node.addEventListener('mouseenter', hold);
  node.addEventListener('mouseleave', arm);
  node.addEventListener('click', leave);
  arm();
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
// The renderer rebuilds its lists with innerHTML, which replays every entrance
// animation on them. That's fine after an action — it's how the UI acknowledges
// what you did — but the once-a-minute rollover poll was replaying the whole
// dashboard for nothing, so charts regrew and cells flickered while you were
// reading them. Every render stamps the state it drew, and the poll compares
// before it commits.
let lastStateKey = null;

async function refresh({ onlyIfChanged = false } = {}) {
  const next = await window.api.getState();
  if (onlyIfChanged && JSON.stringify(next) === lastStateKey) return;
  state = next;
  applyAppearance(state.settings);
  render();
}

function render() {
  lastStateKey = JSON.stringify(state);
  const before = fxSignals.last;
  renderDashboard();
  renderRewards();
  renderBooks();
  renderIdeas();
  renderStats();
  renderHeatmap();
  renderLogFilters();
  // Runs last, so anything it anchors to (the hero card, the bonus card, a book
  // card) is already laid out at its final position.
  runCelebrations(before, fxSignals.capture());
}

function applyAppearance(s) {
  document.documentElement.dataset.theme = s.theme || 'dark';
  document.documentElement.dataset.accent = s.accent || 'ember';
  window.Celebrate.setEnabled(s.celebrations !== false);
}

// ---------------- Celebrations ----------------
// Every win is detected the same way: snapshot the handful of numbers that mean
// something, and compare against the previous render. Nothing has to remember
// to fire a celebration at its call site, so a target met from a quick-add chip,
// the full log dialog, a deleted entry being re-added or the day rolling over
// all light up identically.
const fxSignals = {
  last: null,
  read(s) {
    const books = s.books || [];
    const r = s.rewards || {};
    return {
      targetMet: !!(s.target && s.dayMet),
      tasksMet: (s.tasks || []).filter(t => t.met).length,
      taskCount: (s.tasks || []).length,
      bonusCleared: s.bonusCleared || 0,
      bonusRoundsCleared: s.bonusRoundsCleared || 0,
      rerollCredits: r.rerollCredits || 0,
      projectPicks: r.projectPicks || 0,
      streak: (s.streak && s.streak.current) || 0,
      longest: (s.streak && s.streak.longest) || 0,
      wordLevel: (s.wordTarget && s.wordTarget.current) || 0,
      doneIds: books.filter(b => b.stage === 'done').map(b => b.id)
    };
  },
  capture() {
    const next = this.read(state);
    this.last = next;
    return next;
  }
};

function bookById(id) { return (state.books || []).find(b => b.id === id); }

function runCelebrations(before, after) {
  // No previous snapshot means this is the first paint of the session. Opening
  // the app to a target you finished yesterday evening is not news.
  if (!before) return;

  const events = [];

  // A finished book outranks everything else the app can hand out.
  const newlyDone = after.doneIds.filter(id => !before.doneIds.includes(id));
  for (const id of newlyDone) {
    const book = bookById(id);
    events.push({
      tier: 4, tone: 'gold', icon: '🏆',
      title: 'Book finished',
      subtitle: book ? `"${book.title}" is done — written, edited, closed.` : 'That one is done.',
      duration: 4200,
      anchor: document.querySelector(`.book-card[data-id="${id}"]`),
      seal: true
    });
  }

  if (after.projectPicks > before.projectPicks) {
    events.push({
      tier: 3, tone: 'gold', icon: '🃏',
      title: 'Project pick unlocked',
      subtitle: 'Spend it to choose which book tomorrow is about.',
      duration: 3600,
      anchor: el('rewardPickSlot'),
      earned: true
    });
  }

  if (after.targetMet && !before.targetMet) {
    const book = state.targetBook;
    const list = state.hard && after.taskCount > 1;
    events.push({
      tier: 3, tone: 'green', icon: '✓',
      title: list ? 'List cleared' : 'Target cleared',
      subtitle: list
        ? `All ${after.taskCount} tasks — that's today's, and the streak with it.`
        : (book ? `"${book.title}" — that's today's, and the streak with it.` : "That's today's, and the streak with it."),
      duration: 3200,
      anchor: el('targetCard'),
      stamp: 'Complete',
      win: true,
      ignite: true
    });
  }

  // One task off a hard day's list: worth a nod, not the confetti — that waits
  // for the last one.
  if (!after.targetMet && after.taskCount === before.taskCount && after.tasksMet > before.tasksMet) {
    const left = after.taskCount - after.tasksMet;
    events.push({
      tier: 2, tone: 'green', icon: '✓',
      title: 'Task cleared',
      subtitle: `${left} more to go before the streak counts.`,
      duration: 2800,
      anchor: el('taskListCard'),
      win: true,
      quiet: true
    });
  }

  // A record is worth saying out loud, but it rides along with the target that
  // set it rather than throwing a second lot of confetti.
  if (after.longest > before.longest && after.longest > 1 && after.streak === after.longest) {
    events.push({
      tier: 2, tone: 'gold', icon: '🔥',
      title: `New record — ${after.longest} days`,
      subtitle: 'Longest run yet. Nothing forces you to keep it.',
      duration: 3400,
      anchor: el('streakPill'),
      ignite: true,
      quiet: true
    });
  }

  const roundDone = after.bonusRoundsCleared > before.bonusRoundsCleared;
  if (after.bonusCleared > before.bonusCleared && !roundDone) {
    // One task off a bonus list: a nod, the round banner waits for the last.
    const left = (state.bonusTasks || []).filter(b => !b.met).length;
    events.push({
      tier: 1, tone: 'violet', icon: '✨',
      title: 'Bonus task cleared',
      subtitle: after.rerollCredits > before.rerollCredits
        ? 'That one banked you a reroll.'
        : `${left} more in this round. Still optional.`,
      duration: 2600,
      anchor: el('bonusCard'),
      win: true,
      quiet: true
    });
  }
  if (roundDone) {
    const n = after.bonusRoundsCleared;
    const more = state.bonus && !state.bonus.met;
    const credit = after.rerollCredits > before.rerollCredits;
    events.push({
      tier: 2, tone: 'violet', icon: '✨',
      title: n > 1 ? `Bonus round ${n} cleared` : 'Bonus round cleared',
      subtitle: credit
        ? 'That one banked you a reroll.'
        : (more ? 'Another one is already waiting. Still optional.' : 'Nothing more is asked of you today.'),
      duration: 3000,
      anchor: el('bonusCard'),
      win: true
    });
  }

  // A banked reroll is a quiet flourish on the slot that earned it — the round
  // that produced it already got the banner.
  if (after.rerollCredits > before.rerollCredits) {
    const slot = el('rewardRerollSlot');
    window.Celebrate.pulse(slot, 'fx-earned');
    window.Celebrate.sparkle(el('rewardRerollCount'), 12, 'gold');
  }

  if (after.wordLevel > before.wordLevel) {
    const cap = state.wordTarget.cap;
    toast(after.wordLevel >= cap
      ? `Word level at the ${fmt(cap)} cap. It stops climbing here.`
      : `Word level up — tomorrow asks for ${fmt(after.wordLevel)}.`, 'good', 4200);
  }

  if (!events.length) return;

  // Biggest first: it takes the screen-wide effects and the front of the banner
  // queue, and everything else lands as a local flourish behind it.
  events.sort((a, b) => b.tier - a.tier);
  events.forEach((e, i) => {
    if (e.ignite) window.Celebrate.pulse(el('streakPill'), 'fx-ignite');
    if (e.seal && e.anchor) window.Celebrate.pulse(e.anchor, 'fx-sealed');
    if (i === 0 && !e.quiet) {
      window.Celebrate.party(e);
      return;
    }
    window.Celebrate.banner({ icon: e.icon, title: e.title, subtitle: e.subtitle, tone: e.tone, duration: e.duration });
    if (e.anchor) {
      window.Celebrate.shockwave(e.anchor, e.tone);
      if (e.win) window.Celebrate.pulse(e.anchor, 'fx-win');
      if (e.stamp) window.Celebrate.stamp(e.anchor, e.stamp, e.tone);
    }
  });
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

// Progress bars survive a render (they're addressed by id, not rebuilt), so the
// width they had last time is readable off the element itself. A bar that grew
// gets a shine along its length — an extra 200 words on a 5,000 target is only
// a few pixels of width, and a few pixels is not an acknowledgement.
function setProgress(fill, pct, complete) {
  const had = fill.dataset.fxPct;
  const prev = had === undefined ? null : parseFloat(had);
  fill.dataset.fxPct = String(pct);
  fill.style.width = pct + '%';
  const wasComplete = fill.classList.contains('complete');
  fill.classList.toggle('complete', !!complete);
  if (prev === null) return;
  if (complete && !wasComplete) window.Celebrate.pulse(fill, 'fx-done');
  else if (pct > prev) window.Celebrate.pulse(fill, 'fx-grew');
}

// The ring is rebuilt each render, so a fresh circle starts life already at its
// final offset and the CSS transition has nothing to animate. Rewinding it to
// the previous reading for one frame gives the transition something to do —
// and it sweeps from where it actually was, not from zero.
const ringFrom = new Map();

function drawRing(host, pct, big, small, met) {
  const prev = ringFrom.get(host.id);
  ringFrom.set(host.id, pct);
  host.innerHTML = ringHtml(pct, big, small, met);
  if (prev === undefined || prev === pct || window.Celebrate.reduced() || !window.Celebrate.isEnabled()) return;
  const fill = host.querySelector('.ring-fill');
  if (!fill) return;
  const circumference = parseFloat(fill.getAttribute('stroke-dasharray'));
  const to = fill.getAttribute('stroke-dashoffset');
  fill.setAttribute('stroke-dashoffset', (circumference * (1 - Math.max(0, Math.min(100, prev)) / 100)).toFixed(1));
  // Two frames: one for the browser to accept the rewound value as the start of
  // the transition, one to change it.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.setAttribute('stroke-dashoffset', to);
  }));
}

// Which of today's tasks the hero card is showing. On a hard day any open task
// on the list can be picked; otherwise it's whichever one the day is waiting on.
function heroIndex() {
  const tasks = state.tasks || [];
  const i = ui.focusTask;
  if (Number.isInteger(i) && tasks[i] && !tasks[i].met) return i;
  return state.focusIndex || 0;
}

function heroTask() {
  return (state.tasks || [])[heroIndex()] || null;
}

function targetProgressToday() {
  const t = heroTask();
  return t ? t.done || 0 : 0;
}

function renderDashboard() {
  const st = state.stats;
  el('streakNum').textContent = state.streak.current;
  el('streakPill').classList.toggle('lit', state.streak.current > 0);
  el('streakBest').innerHTML = state.streak.longest ? `best<br>${state.streak.longest}` : '';

  el('targetDate').textContent = prettyDate(state.today);

  const target = heroTask();
  const book = target ? bookById(target.bookId) : null;
  const tasks = state.tasks || [];
  const listDay = state.hard && tasks.length > 1;
  const card = el('targetCard');
  card.classList.toggle('is-met', !!(target && target.met));
  card.classList.toggle('is-rest', state.isRestDay);

  const done = targetProgressToday();
  const pct = target ? Math.min(100, Math.round((done / target.amount) * 100)) : 0;

  setProgress(el('targetProgressFill'), pct, !!(target && target.met));

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
    el('targetTag').textContent = listDay
      ? (target.met ? 'List complete' : `Task ${heroIndex() + 1} of ${tasks.length}`)
      : (target.met ? 'Mission complete' : "Today's Mission");
    el('targetTag').className = 'hero-tag' + (target.met ? ' met' : '');
    if (target.type === 'plan') {
      el('targetTitle').textContent = `Plan your next chapter of "${book.title}"`;
    } else {
      const verb = target.type === 'write' ? 'Write' : 'Edit';
      const unit = target.type === 'write' ? 'words' : (target.amount === 1 ? 'chapter' : 'chapters');
      el('targetTitle').textContent = `${verb} ${fmt(target.amount)} ${unit} of "${book.title}"`;
    }
    if (target.met) {
      el('targetSub').textContent = listDay ? `All ${tasks.length} done. Streak's safe today.` : "Done. Streak's safe today.";
    } else if (target.type === 'plan') {
      el('targetSub').textContent = 'No word count today — figure out what happens next. Say whether a whole chapter came out of it; if not, the book stays in planning.';
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
    drawRing(el('heroRing'), target.met ? 100 : pct, big, target.type === 'plan' ? 'plan' : 'of target', target.met);
  } else {
    drawRing(el('heroRing'), state.isRestDay ? 100 : 0, state.isRestDay ? '☁' : '—', state.isRestDay ? 'resting' : 'idle', false);
  }

  renderQuickAdd(target, done);
  renderTaskList();
  renderModeSwitch();
  renderBonus();

  // Reroll / rest controls
  const reroll = el('rerollBtn');
  const canReroll = !!(target && target.canReroll);
  reroll.disabled = !canReroll;
  el('rerollLabel').textContent = state.rerollsLeft > 0 ? `Reroll (${state.rerollsLeft})` : 'Reroll';
  reroll.title = canReroll
    ? (listDay ? 'Swap this task for a different one' : "Swap today's target for a different one")
    : 'Rerolls are only available before you log anything, and while you have one left';
  const rest = el('restDayBtn');
  rest.textContent = state.isRestDay ? 'Cancel rest day' : `Rest day (${state.restDaysLeft})`;
  rest.disabled = !state.isRestDay && state.restDaysLeft <= 0;

  // Metrics
  const wordGoal = tasks.filter(t => t.type === 'write').reduce((a, t) => a + t.amount, 0);
  const delta = st.words7 - st.wordsPrev7;
  el('weekDelta').textContent = st.wordsPrev7
    ? `${delta >= 0 ? '+' : ''}${fmt(delta)} vs previous week`
    : `${fmt(st.words7)} words this week`;
  el('weekDelta').className = 'card-note ' + (st.wordsPrev7 ? (delta >= 0 ? 'up' : 'down') : '');

  el('metricRow').innerHTML = [
    metricCard('Current streak', state.streak.current, `longest ${state.streak.longest}`, state.streak.current > 0 ? 'accent' : ''),
    metricCard('Words today', fmt(st.wordsToday), wordGoal ? `target ${fmt(wordGoal)}` : 'no word target today'),
    metricCard('This week', fmt(st.words7), 'last 7 days'),
    metricCard('Word level', fmt(state.wordTarget.current), `cap ${fmt(state.wordTarget.cap)}`),
    metricCard('Consistency', st.consistency + '%', 'targets met, 10 weeks', st.consistency >= 70 ? 'good' : '')
  ].join('');
  animateMetrics(el('metricRow'));

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

// ---------------- Hard mode ----------------
// Hard days are a list. The hero card still shows one task at a time — the
// list underneath is where you see the rest and pick which one to work on.
function taskCaption(t) {
  if (t.type === 'plan') return t.met ? 'Planned' : 'One outline';
  return `${fmt(Math.min(t.done || 0, t.amount))} / ${fmt(t.amount)}`;
}

function taskLine(t) {
  const title = (bookById(t.bookId) || {}).title || 'your book';
  if (t.type === 'plan') return `Plan your next chapter of "${title}"`;
  const verb = t.type === 'write' ? 'Write' : 'Edit';
  const unit = t.type === 'write' ? 'words' : (t.amount === 1 ? 'chapter' : 'chapters');
  return `${verb} ${fmt(t.amount)} ${unit} of "${title}"`;
}

function renderTaskList() {
  const card = el('taskListCard');
  const tasks = state.tasks || [];
  if (!state.hard || tasks.length < 2 || state.isRestDay) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  card.classList.toggle('is-met', !!state.dayMet);
  const met = tasks.filter(t => t.met).length;
  el('taskListCount').textContent = state.dayMet
    ? `All ${tasks.length} done`
    : `${met} of ${tasks.length} done · the streak needs all of them`;

  const active = heroIndex();
  el('taskList').innerHTML = tasks.map((t, i) => {
    const pct = t.met ? 100 : Math.min(100, Math.round(((t.done || 0) / t.amount) * 100));
    const cls = ['task-row', t.met ? 'met' : '', !t.met && i === active ? 'active' : ''].join(' ');
    return `<button type="button" class="${cls}" data-task="${i}" ${t.met ? 'disabled' : ''}
        title="${t.met ? 'Done' : 'Show this task above'}">
      <span class="task-check">${t.met ? '✓' : i + 1}</span>
      <span class="task-main">
        <span class="task-desc">${escapeHtml(taskLine(t))}</span>
        <span class="task-bar"><i style="width:${pct}%"></i></span>
      </span>
      <span class="task-caption">${escapeHtml(taskCaption(t))}</span>
    </button>`;
  }).join('');

  el('taskList').querySelectorAll('[data-task]').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.focusTask = parseInt(btn.dataset.task, 10);
      renderDashboard();
    });
  });
}

// Leaving hard mode is locked while today's list is open. The button still
// takes a click so it can say why, rather than just sitting there greyed out.
function easyLocked() {
  return !!(state.hard && !state.dayMet && (state.tasks || []).length);
}

function renderModeSwitch() {
  const mode = state.difficulty || 'easy';
  const locked = mode === 'hard' && easyLocked();
  el('modeSwitch').querySelectorAll('[data-mode]').forEach(btn => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
    btn.classList.toggle('locked', btn.dataset.mode === 'easy' && locked);
  });
  el('modeSwitch').title = mode === 'hard'
    ? (locked ? "Hard mode. Finish today's list to switch back to easy." : 'Hard mode. A list of tasks a day.')
    : 'Easy mode. One task a day.';
}

el('modeSwitch').querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    if (mode === (state.difficulty || 'easy')) return;
    if (mode === 'hard') {
      const n = state.settings.hardModeTasks || 3;
      const startsNow = !!(state.target && !state.dayMet && !state.isRestDay);
      const ok = await confirmDialog({
        title: 'Switch to hard mode?',
        body: `Each day becomes a list of up to ${n} tasks, one per book, and the streak only counts once every one is done. ` +
          (startsNow ? "Today's list starts now. " : 'It starts tomorrow, since today is already settled. ') +
          "You can go back to easy, but only after finishing a day's whole list.",
        okLabel: 'Go hard',
        danger: true
      });
      if (!ok) return;
    }
    const res = await window.api.setDifficulty(mode);
    state = res.state;
    ui.focusTask = null;
    render();
    toast(res.message, res.ok ? 'good' : 'bad', res.ok ? 3600 : 4200);
  });
});

// What the day looked like before a log, so the toast afterwards can say what
// that log actually did: finished the day, finished one task on the list, or
// neither.
function snapshotDay() {
  return {
    dayMet: !!state.dayMet,
    tasksMet: (state.tasks || []).filter(t => t.met).length,
    taskCount: (state.tasks || []).length
  };
}

function dayToast(before) {
  const tasks = state.tasks || [];
  if (!before.dayMet && state.dayMet) {
    toast(state.hard && tasks.length > 1 ? "Whole list done. Streak's safe today." : "Target met. Streak's safe today.", 'good');
    return true;
  }
  const met = tasks.filter(t => t.met).length;
  if (!state.dayMet && tasks.length === before.taskCount && met > before.tasksMet) {
    const left = tasks.length - met;
    toast(`Task done. ${left} to go.`, 'good');
    return true;
  }
  return false;
}

// Metric rows are rebuilt with innerHTML, so a card can't hold its own previous
// value across a render. The figure is parsed back out of whatever the caller
// formatted — "12,480" or "87%" — and animateMetrics() supplies the value it
// had last time from a map that does survive. Anything unparseable ("—") is
// written straight in.
function metricCard(label, value, sub, valueClass = '') {
  const text = String(value);
  const m = /^(-?[\d,]+)(\D*)$/.exec(text);
  const attrs = m
    ? ` data-metric="${escapeHtml(label)}" data-num="${m[1].replace(/,/g, '')}" data-suffix="${escapeHtml(m[2])}"`
    : '';
  return `<div class="metric-card">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value ${valueClass}"${attrs}>${text}</div>
    <div class="metric-sub">${escapeHtml(sub)}</div>
  </div>`;
}

const metricPrev = new Map();

function animateMetrics(container) {
  container.querySelectorAll('.metric-value[data-metric]').forEach(node => {
    // Namespaced by row: "Best day" means different things in two of them, and
    // an unqualified key would have them animating from each other's numbers.
    const key = container.id + ':' + node.dataset.metric;
    const to = parseFloat(node.dataset.num);
    const suffix = node.dataset.suffix || '';
    const prev = metricPrev.get(key);
    metricPrev.set(key, to);
    if (prev === undefined || !Number.isFinite(to)) return;
    node.dataset.fxVal = String(prev);
    window.Celebrate.countUp(node, to, { format: (n) => Math.round(n).toLocaleString() + suffix });
    if (prev !== to) window.Celebrate.pulse(node);
  });
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
  // Both outcomes of a planning day, one click each. Only the first sends the
  // book back to writing.
  return [
    { label: 'Chapter planned', amount: 1 },
    { label: 'Planned, no chapter yet', amount: 1, planned: false }
  ];
}

function renderQuickAdd(target, done) {
  const row = el('quickAddRow');
  if (!target || state.isRestDay) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  const chips = quickAddChips(target, done)
    .map(c => `<button class="chip" data-amount="${c.amount}" data-planned="${c.planned === false ? '0' : '1'}">${escapeHtml(c.label)}</button>`);
  chips.push(`<button class="chip extra" data-extra="1">${escapeHtml(extraChipLabel(target.type))}</button>`);
  row.innerHTML = chips.join('');
  row.classList.remove('hidden');
  row.querySelectorAll('[data-amount]').forEach(btn => {
    btn.addEventListener('click', () => quickLog(parseInt(btn.dataset.amount, 10), btn.dataset.planned !== '0'));
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

// Which bonus task the card is showing. A hard day's round is a list, and any
// open task on it can be picked, same as the day's own list.
function bonusTask() {
  const tasks = state.bonusTasks || [];
  const picked = tasks.find(b => b.index === ui.focusBonus && !b.met);
  if (picked) return picked;
  const current = tasks.find(b => b.index === state.bonusIndex);
  if (current) return current;
  return state.bonus ? Object.assign({ done: state.bonusDone || 0, canReroll: state.canRerollBonus }, state.bonus) : null;
}

function renderBonusList() {
  const list = el('bonusTaskList');
  const tasks = state.bonusTasks || [];
  if (tasks.length < 2) {
    list.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  const active = bonusTask();
  list.classList.remove('hidden');
  list.innerHTML = tasks.map((t, n) => {
    const pct = t.met ? 100 : Math.min(100, Math.round(((t.done || 0) / t.amount) * 100));
    const cls = ['task-row', t.met ? 'met' : '', !t.met && active && t.index === active.index ? 'active' : ''].join(' ');
    return `<button type="button" class="${cls}" data-bonus-task="${t.index}" ${t.met ? 'disabled' : ''}
        title="${t.met ? 'Done' : 'Show this bonus task above'}">
      <span class="task-check">${t.met ? '✓' : n + 1}</span>
      <span class="task-main">
        <span class="task-desc">${escapeHtml(describeTask(t, bookById(t.bookId), t.done || 0))}</span>
        <span class="task-bar"><i style="width:${pct}%"></i></span>
      </span>
      <span class="task-caption">${escapeHtml(taskCaption(t))}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('[data-bonus-task]').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.focusBonus = parseInt(btn.dataset.bonusTask, 10);
      renderBonus();
    });
  });
}

function renderBonus() {
  const card = el('bonusCard');
  const bonus = bonusTask();
  if (!bonus) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  card.classList.toggle('is-met', !!bonus.met);

  const tasks = state.bonusTasks || [];
  const listRound = tasks.length > 1;
  const done = bonus.done || 0;
  const cleared = state.bonusCleared || 0;
  const round = state.bonusRound || 1;
  const pct = bonus.met ? 100 : Math.min(100, Math.round((done / bonus.amount) * 100));
  const roundName = round > 1 ? `Bonus round ${round}` : 'Bonus round';
  el('bonusTag').textContent = bonus.met
    ? 'Bonus complete'
    : (listRound ? `${roundName} · task ${tasks.indexOf(bonus) + 1} of ${tasks.length}` : roundName);
  // A cleared round normally hands out the next one straight away, so this only
  // reads "met" when nothing was left to offer (no eligible books, or the day
  // has run out).
  el('bonusTitle').textContent = bonus.met
    ? 'Bonus done. Nothing more is asked of you today.'
    : describeTask(bonus, bookById(bonus.bookId), done);
  el('bonusFree').textContent = cleared
    ? `${cleared} bonus task${cleared === 1 ? '' : 's'} cleared today · the next is still optional`
    : 'Optional — skipping it costs you nothing';
  setProgress(el('bonusProgressFill'), pct, !!bonus.met);
  el('bonusProgressCaption').textContent = bonus.type === 'plan'
    ? (bonus.met ? 'Planned' : 'One chapter outline')
    : `${fmt(done)} / ${fmt(bonus.amount)}`;

  const row = el('bonusQuickAdd');
  const chips = quickAddChips(bonus, done)
    .map(c => `<button class="chip" data-bonus-amount="${c.amount}" data-planned="${c.planned === false ? '0' : '1'}">${escapeHtml(c.label)}</button>`);
  chips.push(`<button class="chip extra" data-extra="1">${escapeHtml(extraChipLabel(bonus.type))}</button>`);
  row.innerHTML = chips.join('');
  row.classList.remove('hidden');
  row.querySelectorAll('[data-bonus-amount]').forEach(btn => {
    btn.addEventListener('click', () => quickLogBonus(parseInt(btn.dataset.bonusAmount, 10), btn.dataset.planned !== '0'));
  });
  const extra = row.querySelector('[data-extra]');
  if (extra) extra.addEventListener('click', () => openLogModal(bonus.bookId, bonus.type, true));
  renderBonusList();

  const reroll = el('bonusRerollBtn');
  reroll.disabled = !bonus.canReroll;
  el('bonusRerollLabel').textContent = state.rerollsLeft > 0 ? `Reroll (${state.rerollsLeft})` : 'Reroll';
  reroll.title = bonus.canReroll
    ? (listRound ? 'Swap this bonus task for a different one — spends a reroll' : 'Swap this bonus round for a different one — spends a reroll')
    : 'Rerolls are only available before you log anything on this round, and while you have one left';
}

async function quickLogBonus(amount, chapterPlanned = true) {
  const bonus = bonusTask();
  if (!bonus) return;
  const before = snapshotBonus();
  state = await window.api.logProgress({ bookId: bonus.bookId, type: bonus.type, amount, note: '', chapterComplete: false, chapterPlanned });
  render();
  if (!bonusToast(before)) toast('Bonus progress logged.', 'good');
}

function snapshotBonus() {
  return { cleared: state.bonusCleared || 0, rounds: state.bonusRoundsCleared || 0 };
}

// Says what a log did to the bonus rounds, if anything. False when nothing
// was cleared, so the caller can fall back to its own message.
function bonusToast(before) {
  if ((state.bonusRoundsCleared || 0) > before.rounds) {
    toast(state.bonus && !state.bonus.met
      ? 'Bonus round cleared. Here comes another.'
      : 'Bonus round cleared. Show-off.', 'good');
    return true;
  }
  if ((state.bonusCleared || 0) > before.cleared) {
    const left = (state.bonusTasks || []).filter(b => !b.met).length;
    toast(`Bonus task cleared. ${left} left in this round.`, 'good');
    return true;
  }
  return false;
}

async function quickLog(amount, chapterPlanned = true) {
  const target = heroTask();
  if (!target) return;
  const before = snapshotDay();
  state = await window.api.logProgress({ bookId: target.bookId, type: target.type, amount, note: '', chapterComplete: false, chapterPlanned });
  render();
  if (dayToast(before)) return;
  if (target.type === 'plan') toast('Planning logged.', 'good');
  else toast(`Logged ${target.type === 'write' ? fmt(amount) + ' words' : amount + ' chapter(s)'}.`, 'good');
}

function logVerb(l) {
  if (l.type === 'write') return `+${fmt(l.amount)} words`;
  if (l.type === 'plan') return l.chapterPlanned === false ? 'Planning notes' : 'Chapter planned';
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
    let meta = b.autoPlanning
      ? `Every planned chapter is written &middot; plan the next one`
      : `Waiting to be planned &middot; no word count while it's here`;
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
  const isTarget = (state.tasks || []).some(t => t.bookId === b.id);
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
    <div class="book-card ${isTarget ? 'is-target' : ''} ${b.paused ? 'is-paused' : ''}" data-id="${b.id}">
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
    if (!(await confirmNeedsPlanning(book))) return;
    const res = await window.api.needsPlanning(id);
    state = res.state;
    render();
    // A reroll was spent, so show what it bought — same reel as rerolling by hand.
    const replaced = Number.isInteger(res.index) ? (state.tasks || [])[res.index] : null;
    if (res.targetChanged && replaced) {
      el('spinnerTitle').textContent = res.banked ? 'Spending a banked reroll' : "Spending today's reroll";
      el('spinnerHint').textContent = '"' + book.title + '" is off to planning. Here is the day instead.';
      const done = el('spinnerDoneBtn');
      done.disabled = true;
      done.textContent = 'Rolling...';
      openModal('spinnerModalBackdrop');
      runReel(replaced, () => { done.disabled = false; done.textContent = 'Take it'; });
    } else {
      toast(res.message, res.ok ? 'good' : 'bad');
    }
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
// ---------------- Ideas ----------------
// A parking lot, not a queue: nothing here is ever handed out as a target.
// Promoting an idea is the only way out, and it lands the book in Planning.
function renderIdeas() {
  const ideas = state.ideas || [];
  const needle = ui.ideaSearch.trim().toLowerCase();
  const visible = ideas
    .filter(i => !needle || i.title.toLowerCase().includes(needle) || (i.notes || '').toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const list = el('ideaList');
  if (!visible.length) {
    list.innerHTML = emptyState('&#128161;', ideas.length ? 'No ideas match that search.' : 'No ideas yet. Jot one down above.');
    return;
  }
  list.innerHTML = visible.map(i => i.id === ui.editingIdeaId ? ideaEditHtml(i) : ideaCardHtml(i)).join('');

  list.querySelectorAll('[data-idea-action]').forEach(btn => {
    btn.addEventListener('click', () => onIdeaAction(btn.dataset.ideaAction, btn.dataset.id));
  });
  const editing = list.querySelector('.idea-card.editing');
  if (editing) {
    editing.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onIdeaAction('cancelEdit', ui.editingIdeaId); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); onIdeaAction('save', ui.editingIdeaId); }
    });
  }
}

function ideaCardHtml(i) {
  const added = i.createdAt ? new Date(i.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `
    <div class="idea-card" data-id="${i.id}">
      <div class="title">${escapeHtml(i.title)}</div>
      ${i.notes ? `<div class="idea-notes">${escapeHtml(i.notes)}</div>` : ''}
      <div class="idea-foot">
        <span class="idea-date">${added ? 'Added ' + escapeHtml(added) : ''}</span>
        <div class="actions">
          <button class="btn ghost" data-idea-action="edit" data-id="${i.id}">Edit</button>
          <button class="btn ghost danger-text" data-idea-action="delete" data-id="${i.id}">Delete</button>
          <button class="btn primary" data-idea-action="promote" data-id="${i.id}">Promote to book</button>
        </div>
      </div>
    </div>
  `;
}

function ideaEditHtml(i) {
  return `
    <div class="idea-card editing" data-id="${i.id}">
      <input class="idea-edit-title" type="text" maxlength="160" value="${escapeHtml(i.title)}" />
      <textarea class="idea-edit-notes" rows="4" maxlength="2000" placeholder="Notes">${escapeHtml(i.notes || '')}</textarea>
      <div class="idea-foot">
        <span></span>
        <div class="actions">
          <button class="btn ghost" data-idea-action="cancelEdit" data-id="${i.id}">Cancel</button>
          <button class="btn primary" data-idea-action="save" data-id="${i.id}">Save</button>
        </div>
      </div>
    </div>
  `;
}

async function onIdeaAction(action, id) {
  const idea = (state.ideas || []).find(i => i.id === id);
  if (!idea) return;

  if (action === 'edit') {
    ui.editingIdeaId = id;
    renderIdeas();
    el('ideaList').querySelector('.idea-edit-title')?.focus();
  } else if (action === 'cancelEdit') {
    ui.editingIdeaId = null;
    renderIdeas();
  } else if (action === 'save') {
    const card = el('ideaList').querySelector('.idea-card.editing');
    const title = card.querySelector('.idea-edit-title').value.trim();
    if (!title) { card.querySelector('.idea-edit-title').focus(); return; }
    state = await window.api.updateIdea(id, title, card.querySelector('.idea-edit-notes').value);
    ui.editingIdeaId = null;
    render();
    toast('Idea saved.', 'good');
  } else if (action === 'delete') {
    const ok = await confirmDialog({
      title: `Delete "${idea.title}"?`,
      body: 'The idea and its notes are gone for good. This cannot be undone.',
      okLabel: 'Delete idea'
    });
    if (!ok) return;
    state = await window.api.deleteIdea(id);
    if (ui.editingIdeaId === id) ui.editingIdeaId = null;
    render();
    toast('Idea deleted.');
  } else if (action === 'promote') {
    const ok = await confirmDialog({
      title: `Promote "${idea.title}" to a book?`,
      body: 'It moves to Books under Planning, and its notes become the blurb. From then on it can be picked for daily targets, starting with planning the first chapter.',
      okLabel: 'Promote to book',
      danger: false
    });
    if (!ok) return;
    const res = await window.api.promoteIdea(id);
    state = res.state;
    if (ui.editingIdeaId === id) ui.editingIdeaId = null;
    render();
    toast(res.ok ? `"${idea.title}" is a book now. It's in Planning.` : 'That idea no longer exists.', res.ok ? 'good' : 'bad');
  }
}

el('addIdeaBtn').addEventListener('click', async () => {
  const title = el('newIdeaTitle').value.trim();
  if (!title) { el('newIdeaTitle').focus(); return; }
  state = await window.api.addIdea(title, el('newIdeaNotes').value);
  el('newIdeaTitle').value = '';
  el('newIdeaNotes').value = '';
  render();
  toast('Idea saved.', 'good');
  el('newIdeaTitle').focus();
});
el('newIdeaTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('addIdeaBtn').click(); });
el('ideaSearch').addEventListener('input', (e) => { ui.ideaSearch = e.target.value; renderIdeas(); });

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
  animateMetrics(el('statMetrics'));

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
  el('bookBars').innerHTML = ranked.length && topWords > 1 ? ranked.map(b => {
    const words = b.wordsWritten || 0;
    // A book with a target measures itself against that target; the label says
    // "35,000 / 300,000", so the bar has to agree. Only books with no target
    // fall back to a share-of-the-biggest-book comparison.
    const pct = b.targetWords
      ? Math.min(100, Math.round((words / b.targetWords) * 100))
      : Math.round((words / topWords) * 100);
    const tip = b.targetWords ? `${pct}% of ${fmt(b.targetWords)} words` : `${fmt(words)} words`;
    return `
    <div class="bb-row">
      <div class="bb-head">
        <span class="bb-title">${escapeHtml(b.title)}</span>
        <span class="bb-val">${fmt(words)}${b.targetWords ? ' / ' + fmt(b.targetWords) : ''}</span>
      </div>
      <div class="bb-track" title="${tip}"><div class="bb-fill${b.targetWords ? '' : ' relative'}" style="width:${pct}%"></div></div>
    </div>`;
  }).join('') : emptyState('&#128202;', 'No words logged yet.');

  el('recordsList').innerHTML = [
    ['Longest streak', `${state.streak.longest} day(s)`],
    ['Best single day', st.bestDay.date ? `${fmt(st.bestDay.words)} words` : '—'],
    ['Words in last 30 days', fmt(st.words30)],
    ['Chapters edited', fmt(st.totalChapters)],
    ['Chapters planned', fmt(st.totalPlans)],
    ['Rest days taken', `${st.restDaysTaken} (10 weeks)`],
    ['Log entries', fmt(st.totalLogs)]
  ].map(([k, v]) => `<div class="record-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('');

  renderBonusStats();
}

// Bonus rounds were the one part of the app that kept no visible score. They're
// the only work here nothing is making you do, which makes them the most worth
// counting — and the credits they pay were impossible to reconcile against them
// from the dashboard's two little progress tracks alone.
function renderBonusStats() {
  const b = state.stats.bonus;
  const enabled = state.settings.bonusTasksEnabled;

  el('bonusStatNote').textContent = !enabled
    ? 'Switched off in Settings'
    : (b.offeredToday ? `${b.clearedToday} of ${b.offeredToday} cleared today` : 'none offered yet today');

  el('bonusMetrics').innerHTML = [
    metricCard('Rounds cleared', fmt(b.cleared), b.offered ? `of ${fmt(b.offered)} offered` : 'none offered yet', 'accent'),
    metricCard('Clear rate', b.clearRate + '%', 'of rounds finished', b.clearRate >= 50 ? 'good' : ''),
    metricCard('Cleared this month', fmt(b.clearedThisMonth), `${b.toNextPick} more for a pick`),
    metricCard('Best day', fmt(b.bestDay.count), b.bestDay.date ? `rounds · ${prettyDate(b.bestDay.date)}` : 'nothing yet')
  ].join('');
  animateMetrics(el('bonusMetrics'));

  const months = b.monthly;
  const peak = Math.max(1, ...months.map(m => m.cleared));
  const thisMonth = state.today.slice(0, 7);
  el('bonusMonthChart').innerHTML = months.map((m, i) => {
    const h = m.cleared ? Math.max(6, Math.round((m.cleared / peak) * 100)) : 0;
    const current = m.month === thisMonth;
    return `<div class="mc-col ${current ? 'current' : ''}" title="${escapeHtml(m.month)} — ${m.cleared} cleared">
      <span class="mc-val ${m.cleared ? '' : 'zero'}">${m.cleared}</span>
      <div class="mc-bar-wrap">
        <div class="mc-bar ${m.cleared ? '' : 'zero'} ${current ? 'current' : ''}"
             style="height:${m.cleared ? h : 3}%;animation-delay:${i * 45}ms"></div>
      </div>
      <span class="mc-label">${escapeHtml(m.label)}</span>
    </div>`;
  }).join('');

  const ledger = (earned, spent, left) =>
    `${fmt(left)} left <span class="rv-dim">· ${fmt(earned)} earned, ${fmt(spent)} spent</span>`;

  el('bonusLedger').innerHTML = [
    ['Rerolls banked', ledger(b.rerollsEarned, b.rerollsSpent, b.rerollsLeft)],
    ['Next reroll in', `${b.toNextReroll} bonus task${b.toNextReroll === 1 ? '' : 's'}`],
    ['Project picks', ledger(b.picksEarned, b.picksSpent, b.picksLeft)],
    ['Next pick in', `${b.toNextPick} bonus task${b.toNextPick === 1 ? '' : 's'} this month`],
    ['Days with a round cleared', fmt(b.daysCleared)],
    ['Average on those days', b.avgPerActiveDay ? `${b.avgPerActiveDay} rounds` : '—'],
    ['Earning rate', `1 reroll / ${b.perReroll} rounds · 1 pick / ${b.perPick} a month`]
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

  el('heatmap').innerHTML = cells.map((d, i) => {
    // Column-by-column rather than cell-by-cell: 70 individually delayed cells
    // reads as noise, ten weeks sweeping left to right reads as a calendar.
    const delay = `animation-delay:${Math.floor(i / 7) * 26}ms`;
    if (!d) return `<div class="heat-cell future" style="${delay}"></div>`;
    const bits = [];
    if (d.hard && d.tasks > 1) bits.push(`hard: ${d.tasksMet}/${d.tasks} tasks`);
    else if (d.target) bits.push(`${d.target.type} ${fmt(d.target.amount)}`);
    if (d.words) bits.push(`${fmt(d.words)} words`);
    if (d.chapters) bits.push(`${d.chapters} chapter(s)`);
    const label = `${prettyDate(d.date)} — ${d.status}${bits.length ? ' — ' + bits.join(', ') : ''}`;
    return `<div class="heat-cell ${d.status}${d.date === state.today ? ' today' : ''}" title="${escapeHtml(label)}" style="${delay}"></div>`;
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
  // A book auto-moved into planning still has today's word target live against
  // it, so its word count is very much still in play.
  return book.stage !== 'planning' || !!book.autoPlanning;
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

// Moving today's own book to planning invalidates the day's word target, and the
// app would hand out a replacement for free — which makes it a way to dodge any
// target you don't fancy. It costs a reroll instead, and that has to be said out
// loud before it's spent, not after.
async function confirmNeedsPlanning(book) {
  const t = (state.tasks || []).find(x => !x.met && x.type === 'write' && x.bookId === book.id);
  if (!t) return true;
  const done = t.done || 0;

  if (state.rerollsLeft > 0) {
    const banked = state.rewards && state.rewards.freeRerollsLeft <= 0;
    let body = 'Today\u2019s mission is this book, so moving it to planning rolls a new one — and that costs ' +
      (banked ? 'a banked reroll' : 'today\u2019s reroll') + '. You\u2019d have ' + (state.rerollsLeft - 1) + ' left.';
    if (done > 0) body += ' The ' + fmt(done) + ' words you already logged stay on the book, but stop counting toward today.';
    return confirmDialog({
      title: 'Spend a reroll to move this book?',
      body,
      okLabel: 'Spend it',
      danger: false
    });
  }

  return confirmDialog({
    title: 'Move it anyway, without a new mission?',
    body: 'Today\u2019s mission is this book and you have no rerolls left, so it stays as it is. ' +
      'The book moves to planning either way — today just still wants its words.',
    okLabel: 'Move it anyway',
    danger: false
  });
}

// ---------------- Bonus rewards ----------------
// Bonus rounds used to pay nothing at all. They now buy two things, and both are
// spent on the same axis they were earned on: control over what the app asks of
// you. Neither can ever become an obligation — skip every round and you lose
// only what you never had.

function eligibleBooks() {
  return state.books.filter(b => !b.paused && (
    b.stage === 'writing' || b.stage === 'planning' ||
    (b.stage === 'editing' && b.id === state.activeEditingBookId)
  ));
}

function renderRewards() {
  const r = state.rewards;
  const strip = el('rewardStrip');
  if (!r || !state.settings.bonusTasksEnabled) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');

  window.Celebrate.countUp(el('rewardRerollCount'), r.rerollCredits, { format: (n) => String(Math.round(n)) });
  el('rewardRerollFill').style.width =
    Math.round(((r.perReroll - r.toNextReroll) / r.perReroll) * 100) + '%';
  // A track one round away from paying out breathes, so you can see it coming.
  el('rewardRerollFill').classList.toggle('fx-charging', r.toNextReroll === 1);
  el('rewardRerollSub').textContent = r.toNextReroll === 1
    ? 'One more bonus task earns another'
    : r.toNextReroll + ' more bonus tasks earn another';
  el('rewardRerollSlot').classList.toggle('has-credit', r.rerollCredits > 0);

  window.Celebrate.countUp(el('rewardPickCount'), r.projectPicks, { format: (n) => String(Math.round(n)) });
  el('rewardPickFill').style.width =
    Math.round(((r.clearedThisMonth % r.perPick) / r.perPick) * 100) + '%';
  el('rewardPickFill').classList.toggle('fx-charging', r.toNextPick <= 2);
  el('rewardPickSlot').classList.toggle('has-credit', r.projectPicks > 0);
  el('pickProjectBtn').classList.toggle('hidden', r.projectPicks <= 0);

  el('rewardPickSub').textContent = r.nextPick
    ? 'Tomorrow is locked to "' + r.nextPick.title + '"'
    : (r.clearedThisMonth % r.perPick) + ' of ' + r.perPick + ' bonus tasks this month · ' + r.toNextPick + ' to go';
}

// ---- the reroll spinner ----
// The result is already decided by the time the reel starts moving — the store
// rolled it the moment you clicked. The spin isn't deciding anything, it's just
// refusing to hand you the answer instantly, which is the whole point of it.
const REEL_ROW_H = 54;
const REEL_LENGTH = 30;
const REEL_LAND = 26;

function reelRowHtml(label, stage) {
  return '<div class="reel-row"><span class="reel-spine ' + stage + '"></span>' +
    '<span class="reel-label">' + escapeHtml(label) + '</span></div>';
}

// Plausible-looking filler: real books, real-shaped tasks, none of it binding.
function fakeReelRow() {
  const books = eligibleBooks();
  const book = books[Math.floor(Math.random() * books.length)];
  if (!book) return reelRowHtml('...', 'writing');
  if (book.stage === 'editing') {
    return reelRowHtml('Edit ' + (1 + Math.floor(Math.random() * 2)) + ' chapter(s) of "' + book.title + '"', book.stage);
  }
  if (book.stage === 'planning' || Math.random() < 0.2) {
    return reelRowHtml('Plan your next chapter of "' + book.title + '"', book.stage);
  }
  const base = state.wordTarget ? state.wordTarget.current : 500;
  const jitter = Math.round((base * (0.7 + Math.random() * 0.6)) / 50) * 50;
  return reelRowHtml('Write ' + fmt(jitter) + ' words of "' + book.title + '"', book.stage);
}

function realTargetRow(target) {
  const book = state.books.find(b => b.id === target.bookId);
  const title = book ? book.title : 'your book';
  const stage = book ? book.stage : 'writing';
  if (target.type === 'plan') return reelRowHtml('Plan your next chapter of "' + title + '"', stage);
  const verb = target.type === 'write' ? 'Write' : 'Edit';
  const unit = target.type === 'write' ? 'words' : (target.amount === 1 ? 'chapter' : 'chapters');
  return reelRowHtml(verb + ' ' + fmt(target.amount) + ' ' + unit + ' of "' + title + '"', stage);
}

function runReel(target, onDone) {
  const strip = el('reelStrip');
  const rows = [];
  for (let i = 0; i < REEL_LENGTH; i++) {
    rows.push(i === REEL_LAND ? realTargetRow(target) : fakeReelRow());
  }
  strip.innerHTML = rows.join('');
  strip.classList.add('spinning');
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  // Force the reset to take effect before the transition is attached, or the
  // browser collapses both writes into one and nothing moves.
  void strip.offsetHeight;
  strip.style.transition = 'transform 3.1s cubic-bezier(.08,.62,.16,1)';
  strip.style.transform = 'translateY(' + (-(REEL_LAND - 1) * REEL_ROW_H) + 'px)';

  const settle = () => {
    strip.removeEventListener('transitionend', settle);
    strip.classList.remove('spinning');
    strip.children[REEL_LAND].classList.add('landed');
    // Sparks off the winning row rather than confetti: the reel is the payoff
    // for a reroll you spent, not a win to be congratulated on.
    window.Celebrate.sparkle(strip.children[REEL_LAND], 16);
    window.Celebrate.shockwave(el('reelStrip').parentElement);
    onDone();
  };
  strip.addEventListener('transitionend', settle);
}

let spinnerBusy = false;

let spinnerToast = 'New target locked in. No takebacks.';

async function rerollWithSpinner() {
  const task = heroTask();
  if (spinnerBusy || !task || !task.canReroll) return;
  spinnerBusy = true;
  const res = await window.api.rerollTarget(task.index);
  spinReroll(res, false);
}

async function rerollBonusWithSpinner() {
  const bonus = bonusTask();
  if (spinnerBusy || !bonus || !bonus.canReroll) return;
  spinnerBusy = true;
  const res = await window.api.rerollBonus(bonus.index);
  spinReroll(res, true);
}

function spinReroll(res, isBonus) {
  if (!res.ok) {
    spinnerBusy = false;
    toast(res.message, 'bad');
    return;
  }
  state = res.state;
  render();

  el('spinnerTitle').textContent = res.banked
    ? 'Spending a banked reroll'
    : (isBonus ? 'Rolling a new bonus round' : 'Rolling a new mission');
  el('spinnerHint').textContent = isBonus
    ? 'Still optional. Wherever it lands, that is the round.'
    : res.banked
      ? 'Bought with bonus rounds. Wherever it lands, that is the day.'
      : 'Wherever it lands, that is the day.';
  spinnerToast = isBonus ? 'New bonus round locked in.' : 'New target locked in. No takebacks.';
  const done = el('spinnerDoneBtn');
  done.disabled = true;
  done.textContent = 'Rolling...';
  openModal('spinnerModalBackdrop');

  const rolled = isBonus
    ? ((state.bonusTasks || []).find(b => b.index === res.index) || state.bonus)
    : ((state.tasks || [])[res.index] || state.target);
  runReel(rolled, () => {
    done.disabled = false;
    done.textContent = 'Take it';
    spinnerBusy = false;
  });
}

el('spinnerDoneBtn').addEventListener('click', () => {
  if (spinnerBusy) return;
  closeModal('spinnerModalBackdrop');
  toast(spinnerToast, 'good');
});

// ---- the project pick ----
function pickCardHtml(b) {
  const cover = b.coverPath
    ? '<img class="pick-cover" src="' + coverUrl(b) + '" alt="" />'
    : '<div class="pick-cover blank ' + b.stage + '"><span>' + escapeHtml(b.title.charAt(0).toUpperCase()) + '</span></div>';
  return '<button class="pick-card" data-pick="' + b.id + '">' +
    cover +
    '<span class="pick-stage ' + b.stage + '">' + STAGE_LABEL[b.stage] + '</span>' +
    '<span class="pick-name">' + escapeHtml(b.title) + '</span>' +
    '</button>';
}

let pickBusy = false;

function openPickModal() {
  const books = eligibleBooks();
  if (!books.length) { toast('No books in the rotation to choose from.', 'bad'); return; }
  pickBusy = false;
  el('pickHint').textContent = state.rewards.clearedThisMonth +
    " bonus tasks cleared this month. Tomorrow's mission is yours to name.";
  const deck = el('pickDeck');
  deck.classList.remove('resolved');
  deck.innerHTML = books.map(pickCardHtml).join('');
  // Staggered so the cards land one after another instead of all at once.
  [...deck.children].forEach((card, i) => { card.style.animationDelay = (i * 80) + 'ms'; });
  openModal('pickModalBackdrop');
}

el('pickDeck').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-pick]');
  if (!card || pickBusy) return;
  pickBusy = true;
  const deck = el('pickDeck');
  deck.classList.add('resolved');
  card.classList.add('chosen');
  window.Celebrate.fromElement(card, { count: 34, spread: 170, power: 620, tone: 'gold' });

  const res = await window.api.pickTomorrow(card.dataset.pick);
  // Let the chosen card finish its flourish before the modal goes.
  setTimeout(() => {
    state = res.state;
    closeModal('pickModalBackdrop');
    deck.classList.remove('resolved');
    render();
    toast(res.message, res.ok ? 'good' : 'bad');
    pickBusy = false;
  }, 620);
});

el('pickProjectBtn').addEventListener('click', openPickModal);

// ---------------- Distraction app picker ----------------
// Nobody should have to know that Brave's process is brave.exe, or go hunting
// through Task Manager for it. The list is scanned off the machine; the writer
// just ticks what distracts them. The manual field stays for the odd game whose
// executable is buried and has no Start Menu entry (VALORANT, for one).

let appCatalog = null;          // null while the scan is still running
let appScanError = null;
const selectedApps = new Map(); // lowercase exe -> exe exactly as it will be saved
const extraApps = new Map();    // lowercase exe -> apps not found by the scan, kept visible anyway

function loadAppPicker(saved) {
  selectedApps.clear();
  extraApps.clear();
  (saved || []).forEach(exe => selectedApps.set(exe.toLowerCase(), exe));
  syncExtraApps();
  renderAppList();
  if (appCatalog === null && !appScanError) scanApps();
}

// Anything selected that the scan didn't turn up — a hand-typed entry, or an app
// uninstalled since — still needs a row, or unticking it would be impossible.
function syncExtraApps() {
  if (appCatalog === null) return; // mid-scan: everything would look unknown
  const known = new Set(appCatalog.map(a => a.exe.toLowerCase()));
  selectedApps.forEach((exe, key) => {
    if (!known.has(key) && !extraApps.has(key)) extraApps.set(key, { exe, name: exe, custom: true });
  });
  // A rescan can turn a hand-typed entry into a properly named one — drop the
  // bare-exe row rather than showing the same app twice.
  extraApps.forEach((_, key) => { if (known.has(key)) extraApps.delete(key); });
}

async function scanApps() {
  appCatalog = null;
  appScanError = null;
  renderAppList();
  const res = await window.api.listApps();
  appCatalog = res.apps || [];
  appScanError = res.ok ? null : (res.error || 'Could not read the list of installed apps.');
  syncExtraApps();
  renderAppList();
}

function appPickerRows() {
  const rows = [...extraApps.values(), ...(appCatalog || [])];
  const q = el('appSearch').value.trim().toLowerCase();
  const filtered = q
    ? rows.filter(a => a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q))
    : rows;
  // Custom entries first (they're the ones you had to work for), then by name.
  return filtered.sort((a, b) => (b.custom ? 1 : 0) - (a.custom ? 1 : 0) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function renderAppList() {
  const list = el('appList');
  el('appPickerCount').textContent = selectedApps.size ? `${selectedApps.size} selected` : 'none selected';

  if (appCatalog === null) {
    list.innerHTML = `<div class="app-empty">Looking through your installed apps…</div>`;
    return;
  }

  const rows = appPickerRows();
  const notice = appScanError ? `<div class="app-empty warn">${escapeHtml(appScanError)} You can still add apps by hand below.</div>` : '';
  if (!rows.length) {
    list.innerHTML = notice || `<div class="app-empty">Nothing matches that search.</div>`;
    return;
  }

  list.innerHTML = notice + rows.map(a => {
    const key = a.exe.toLowerCase();
    // No icon for hand-typed entries and the odd exe Windows has none for —
    // a monogram keeps the row from collapsing a column narrower than the rest.
    const icon = a.icon
      ? `<img class="app-icon" src="${a.icon}" alt="" />`
      : `<span class="app-icon blank">${escapeHtml(a.name.charAt(0).toUpperCase())}</span>`;
    return `<label class="app-row${selectedApps.has(key) ? ' picked' : ''}" data-exe="${escapeHtml(a.exe)}">
      <input type="checkbox" ${selectedApps.has(key) ? 'checked' : ''} />
      ${icon}
      <span class="app-name">${escapeHtml(a.name)}</span>
      ${a.custom ? '' : `<span class="app-exe">${escapeHtml(a.exe)}</span>`}
      ${a.custom ? '<span class="app-flag custom">added by hand</span>' : a.running ? '<span class="app-flag">running</span>' : ''}
    </label>`;
  }).join('');
}

// Delegated so ticking a box never re-renders the list — rows jumping around
// under the cursor while you work down a list of sixty apps is miserable.
el('appList').addEventListener('change', (e) => {
  const row = e.target.closest('.app-row');
  if (!row) return;
  const exe = row.dataset.exe;
  const key = exe.toLowerCase();
  if (e.target.checked) selectedApps.set(key, exe);
  else selectedApps.delete(key);
  row.classList.toggle('picked', e.target.checked);
  el('appPickerCount').textContent = selectedApps.size ? `${selectedApps.size} selected` : 'none selected';
});

el('appSearch').addEventListener('input', renderAppList);
el('rescanAppsBtn').addEventListener('click', () => scanApps());

function addAppByHand() {
  const input = el('appManualInput');
  let exe = input.value.trim();
  if (!exe) return;
  if (!/\.exe$/i.test(exe)) exe += '.exe';
  const key = exe.toLowerCase();
  selectedApps.set(key, exe);
  if (!(appCatalog || []).some(a => a.exe.toLowerCase() === key)) {
    extraApps.set(key, { exe, name: exe, custom: true });
  }
  input.value = '';
  el('appSearch').value = '';
  renderAppList();
}

el('appManualAddBtn').addEventListener('click', addAppByHand);
el('appManualInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addAppByHand(); }
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
  loadAppPicker(s.distractionProcesses);
  el('setStartWords').value = s.startWords;
  el('setWordIncrement').value = s.wordIncrement;
  el('setWordCap').value = s.wordCap;
  el('setMinChapters').value = s.minChapters;
  el('setMaxChapters').value = s.maxChapters;
  el('setPlanningProbability').value = Math.round(s.planningProbability * 100);
  el('setRestDaysPerWeek').value = s.restDaysPerWeek;
  el('setRerollsPerDay').value = s.rerollsPerDay;
  el('setHardModeTasks').value = s.hardModeTasks || 3;
  el('setBonusEnabled').checked = s.bonusTasksEnabled;
  el('setBonusEscalation').checked = s.bonusEscalation !== false;
  el('setCelebrations').checked = s.celebrations !== false;
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
    distractionProcesses: Array.from(selectedApps.values()),
    startWords: parseInt(el('setStartWords').value, 10),
    wordIncrement: parseInt(el('setWordIncrement').value, 10),
    wordCap: parseInt(el('setWordCap').value, 10),
    minChapters: parseInt(el('setMinChapters').value, 10),
    maxChapters: parseInt(el('setMaxChapters').value, 10),
    planningProbability: Math.max(0, Math.min(100, parseInt(el('setPlanningProbability').value, 10) || 0)) / 100,
    restDaysPerWeek: Math.max(0, parseInt(el('setRestDaysPerWeek').value, 10) || 0),
    rerollsPerDay: Math.max(0, parseInt(el('setRerollsPerDay').value, 10) || 0),
    hardModeTasks: Math.max(2, Math.min(5, parseInt(el('setHardModeTasks').value, 10) || 3)),
    bonusTasksEnabled: el('setBonusEnabled').checked,
    bonusEscalation: el('setBonusEscalation').checked,
    celebrations: el('setCelebrations').checked,
    autoLaunch: el('setAutoLaunch').checked
  };
  state = await window.api.updateSettings(partial);
  applyAppearance(state.settings);
  render();
  toast('Settings saved.', 'good');
});

// The toggle previews live off the checkbox rather than waiting for a save —
// deciding whether you want confetti is easier with confetti in front of you.
el('setCelebrations').addEventListener('change', (e) => {
  window.Celebrate.setEnabled(e.target.checked);
  if (e.target.checked) window.Celebrate.confetti({ count: 34, y: window.innerHeight * 0.6 });
});

el('previewCelebrationBtn').addEventListener('click', () => {
  if (!el('setCelebrations').checked) {
    toast('Celebrations are switched off — tick the box to see one.', 'bad');
    return;
  }
  window.Celebrate.setEnabled(true);
  if (window.Celebrate.reduced()) {
    toast("Windows is set to minimise animations, so this stays still. The banner is all you'll get.", '', 5000);
  }
  window.Celebrate.party({
    tier: 3, tone: 'green', icon: '✓',
    title: 'Target cleared',
    subtitle: 'This is what a finished day looks like.',
    duration: 3000
  });
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

el('rerollBtn').addEventListener('click', rerollWithSpinner);
el('bonusRerollBtn').addEventListener('click', rerollBonusWithSpinner);

// ---------------- Log modal ----------------
// `extra` is the "I wrote extra..." entry point from a task card: same form, but
// it says what it's for, since the task it belongs to is already finished.
// What the app is actually waiting on right now. Once the day's target is met
// the mission is over and a bonus round has taken its place, so a bare "log
// progress" — the dashboard button, Ctrl+L, the tray item, or Ctrl+Alt+W from
// anywhere — should land on the round that's still open rather than on the task
// you already finished. Falls back to the finished target so an over-target
// session still opens on the book you were working in.
function openTaskNow() {
  if (state.isRestDay) return null;
  const target = state.target;
  if (target && !target.met) return { task: target, kind: 'target' };
  const bonus = state.bonus;
  if (bonus && !bonus.met) return { task: bonus, kind: 'bonus' };
  if (target) return { task: target, kind: 'done' };
  return null;
}

function openLogModal(presetBookId, presetType, extra = false) {
  const options = state.books.filter(b => b.stage !== 'done');
  if (!options.length) { toast('Add a book first.', 'bad'); switchView('books'); return; }
  el('logBookSelect').innerHTML = options.map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`).join('');

  let kind = null;
  if (presetBookId && options.some(b => b.id === presetBookId)) {
    el('logBookSelect').value = presetBookId;
    el('logTypeSelect').value = presetType || 'write';
  } else {
    const open = openTaskNow();
    // Trust the task's actual assigned type as-is (a writing book may have
    // randomly gotten a planning day) rather than re-deriving it from the
    // book's stage.
    if (open && options.some(b => b.id === open.task.bookId)) {
      el('logBookSelect').value = open.task.bookId;
      el('logTypeSelect').value = open.task.type;
      kind = open.kind;
    } else {
      syncLogTypeToStage();
    }
  }
  syncLogForm();

  el('logModalTitle').textContent = extra
    ? 'Log extra work'
    : (kind === 'bonus' ? 'Log bonus round' : 'Log progress');

  // Say which task the form arrived pointed at, so a modal that opened on a
  // different book than you expected explains itself instead of quietly
  // filing the words in the wrong place.
  const hint = el('logModalHint');
  if (!extra && kind === 'bonus') {
    const round = state.bonusRound || 1;
    hint.textContent = `Today's target is done. This is bonus round ${round}: ` +
      `${describeTask(state.bonus, state.bonusBook, state.bonusDone || 0)}. ` +
      'Optional as ever — leaving it costs you nothing.';
    hint.classList.remove('hidden');
  } else if (!extra && kind === 'done') {
    hint.textContent = "Today's target is already met, so anything you log here is extra.";
    hint.classList.remove('hidden');
  } else {
    hint.textContent = '';
    hint.classList.add('hidden');
  }
  el('logAmountInput').value = '';
  el('logNoteInput').value = '';
  el('chapterCompleteInput').checked = false;
  // Ticked by default: a planning day usually does end with a chapter in it, and
  // a book left in planning by an unnoticed checkbox stops asking for words.
  el('chapterPlannedInput').checked = true;
  openModal('logModalBackdrop');
  // A plan entry has no amount to type, so send the cursor to the one field it
  // does have.
  const first = el('logTypeSelect').value === 'plan' ? el('logNoteInput') : el('logAmountInput');
  setTimeout(() => first.focus(), 30);
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
  el('chapterPlannedRow').classList.toggle('hidden', type !== 'plan');
  el('logAmountRow').classList.toggle('hidden', type === 'plan');
  el('logAmountLabel').textContent = type === 'edit' ? 'How many chapters?' : 'How many words?';
  el('logNoteInput').placeholder = type === 'plan' ? 'What did you plan?' : 'What happened in it?';

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
  const chapterPlanned = type !== 'plan' || el('chapterPlannedInput').checked;
  if (!bookId) return;
  if (amount <= 0) { toast('Enter an amount above zero.', 'bad'); el('logAmountInput').focus(); return; }

  const before = snapshotDay();
  const bonusBefore = snapshotBonus();
  state = await window.api.logProgress({ bookId, type, amount, note, chapterComplete, chapterPlanned });
  closeModal('logModalBackdrop');
  render();
  if (currentView === 'history') refreshLogList();
  if (dayToast(before)) return;
  // The dialog can be pointed at a bonus round now, so it has to be able to
  // report clearing one — the quick-add chips aren't the only route any more.
  if (!bonusToast(bonusBefore)) toast('Progress logged.', 'good');
});

// ---------------- Press feedback ----------------
// Delegated, because every chip in the app is thrown away and rebuilt on each
// render — there's nothing stable to bind to.
document.addEventListener('pointerdown', (e) => {
  const chip = e.target.closest && e.target.closest('.chip');
  if (!chip || chip.disabled) return;
  if (window.Celebrate.reduced() || !window.Celebrate.isEnabled()) return;
  const r = chip.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.4;
  const ripple = document.createElement('span');
  ripple.className = 'fx-ripple';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - r.left) + 'px';
  ripple.style.top = (e.clientY - r.top) + 'px';
  chip.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
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
    e.preventDefault(); if (state && heroTask() && heroTask().canReroll) el('rerollBtn').click(); return;
  }
  if (typing || anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;

  const views = { '1': 'dashboard', '2': 'books', '3': 'ideas', '4': 'stats', '5': 'history', '6': 'settings' };
  if (views[e.key]) { e.preventDefault(); switchView(views[e.key]); }
});

// ---------------- Wiring ----------------
// Ctrl+Alt+W can fire from anywhere, long after the last poll — and on a cold
// start it arrives before the renderer's own first getState() has come back.
// Refresh first, so the form is pointed at the task that's open right now
// rather than a minute ago's (or nothing at all).
window.api.onOpenLogModal(async () => {
  try { await refresh(); } catch (e) { /* fall back to whatever state we have */ }
  if (state) openLogModal();
});
window.api.onStateChanged(() => refresh());

refresh();
// Keep the day rollover honest without yanking the UI out from under an open
// dialog — and without redrawing a dashboard nothing has changed on, which used
// to replay every chart and card animation once a minute.
setInterval(() => { if (!anyModalOpen()) refresh({ onlyIfChanged: true }); }, 60 * 1000);
