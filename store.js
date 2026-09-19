// Local JSON-backed data store. No network, no native deps — just a file on disk.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  punishmentEnabled: true,
  punishmentStartHour: 20, // 24h, local time
  punishmentEndHour: 24,   // stop nagging after this hour
  checkIntervalMinutes: 20,
  snoozeThreshold: 5,
  distractionProcesses: ['VALORANT-Win64-Shipping.exe', 'RiotClientServices.exe'],
  startWords: 500,     // where the daily word target starts out
  wordIncrement: 50,   // added to the target each day a write target is met
  wordCap: 5000,       // the target stops growing once it hits this
  minChapters: 1,
  maxChapters: 2,
  planningProbability: 0.15, // chance a writing-stage book gets a "plan this chapter" day instead of a word count
  autoLaunch: true,
  nagProbability: 0.7, // chance a nag actually fires each check, before escalation
  restDaysPerWeek: 1,  // guilt-free days off that don't break the streak
  rerollsPerDay: 1,    // how many times you can reroll an untouched daily target
  bonusTasksEnabled: true, // clear the day's target and consequence-free extra tasks keep coming
  theme: 'dark',
  accent: 'ember'
};

const HISTORY_DAYS = 70; // 10 weeks of heatmap

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return todayStr(dt);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this._lastSerialized = null;
    this.data = this._load();
    this._ensureToday();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const merged = Object.assign(this._blank(), parsed, {
        settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {})
      });
      merged.books = (merged.books || []).map(b => Object.assign({
        paused: false, targetWords: null, chaptersPlanned: 0, chaptersWritten: 0, blurb: ''
      }, b));
      if (!Array.isArray(merged.restDays)) merged.restDays = [];
      if (!merged.rerolls) merged.rerolls = { date: null, count: 0 };
      if (!merged.bonusTargets) merged.bonusTargets = {};
      // v2 files stored one bonus object per day; the chain is a list now.
      for (const [date, v] of Object.entries(merged.bonusTargets)) {
        if (!v) delete merged.bonusTargets[date];
        else if (!Array.isArray(v)) merged.bonusTargets[date] = [v];
      }
      // parsed.version overwrites the blank's, so stamp it back after the merge —
      // otherwise a migrated file keeps claiming the schema it arrived with.
      merged.version = 2;
      return merged;
    } catch (e) {
      return this._blank();
    }
  }

  _blank() {
    return {
      version: 2,
      books: [],
      logs: [],
      dailyTargets: {},
      bonusTargets: {},
      activeDates: [],
      restDays: [],
      rerolls: { date: null, count: 0 },
      activeEditingBookId: null,
      currentWordTarget: null,
      windowBounds: null,
      punishState: { date: null, snoozeCount: 0, escalated: false, lastNagAt: null },
      streak: { current: 0, longest: 0, lastUpdatedDate: null },
      settings: Object.assign({}, DEFAULT_SETTINGS)
    };
  }

  // getState() runs on a timer from the renderer, and it calls _ensureToday() →
  // save() every time. Skipping the write when nothing actually changed keeps us
  // from rewriting the whole file once a minute for no reason.
  save() {
    const serialized = JSON.stringify(this.data, null, 2);
    if (serialized === this._lastSerialized) return;
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, serialized, 'utf-8');
    fs.renameSync(tmp, this.filePath);
    this._lastSerialized = serialized;
  }

  _ensureToday() {
    const today = todayStr();
    if (!this.data.activeDates.includes(today)) {
      this.data.activeDates.push(today);
    }
    this._rollStreakIfNeeded(today);
    this._ensureActiveEditingBook();
    if (!this.data.punishState || this.data.punishState.date !== today) {
      this.data.punishState = { date: today, snoozeCount: 0, escalated: false, lastNagAt: null };
    }
    if (!this.data.dailyTargets[today]) {
      this._generateTarget(today);
    } else {
      this._reconcileTodayTarget(today);
    }
    this._reconcileBonus(today);
    this._recomputeBonusMet(today);
    this._maybeGenerateBonus(today);
    this.save();
  }

  // Drop a bonus whose book has since been deleted, paused or moved on — but
  // only while it's still untouched, so we never discard work already done.
  // Earlier rounds in the chain are finished history and stay put.
  _reconcileBonus(date) {
    const chain = this._bonusChain(date);
    const bonus = chain.length ? chain[chain.length - 1] : null;
    if (!bonus || bonus.met) return;
    if (this._isTargetStillValid(bonus)) return;
    if (this._bonusLogged(date, bonus) > 0) return;
    chain.pop();
    if (chain.length === 0) delete this.data.bonusTargets[date];
  }

  // If the book behind today's target left the pool it was picked from (marked
  // drafted, moved on from editing, paused, deleted, ...) the target is now nonsense —
  // regenerate it, but only if you haven't logged any progress against it yet.
  _isTargetStillValid(target) {
    const book = this.data.books.find(b => b.id === target.bookId);
    if (!book || book.paused) return false;
    if (target.type === 'write') return book.stage === 'writing';
    if (target.type === 'plan') return book.stage === 'planning' || book.stage === 'writing';
    if (target.type === 'edit') return book.stage === 'editing' && book.id === this.data.activeEditingBookId;
    return false;
  }

  _reconcileTodayTarget(date) {
    const target = this.data.dailyTargets[date];
    if (!target || target.met || this._isTargetStillValid(target)) return;
    // The book behind it no longer matches — nothing logged against it going
    // forward could ever complete it, so replace it outright, progress or not.
    this._generateTarget(date);
  }

  _rollStreakIfNeeded(today) {
    const s = this.data.streak;
    if (s.lastUpdatedDate === today) return;
    // Find the most recent active date strictly before today that hasn't been scored yet.
    const pastActive = this.data.activeDates
      .filter(d => d < today)
      .sort();
    for (const d of pastActive) {
      if (s.lastUpdatedDate && d <= s.lastUpdatedDate) continue;
      const target = this.data.dailyTargets[d];
      if (this.data.restDays.includes(d)) {
        // A declared rest day neither builds nor breaks the streak.
      } else if (target && target.met) {
        s.current += 1;
        s.longest = Math.max(s.longest, s.current);
        if (target.type === 'write') this._growWordTarget();
      } else if (target) {
        s.current = 0;
      }
      // if no target existed that day (e.g. no books yet), skip without penalty
      s.lastUpdatedDate = d;
    }
  }

  // The daily word target ramps up on its own — no random min/max range, no cap the
  // user has to babysit day to day. It starts at settings.startWords and climbs by
  // settings.wordIncrement each day a write target is met, until it plateaus at
  // settings.wordCap (default 5000/day).
  _getCurrentWordTarget() {
    if (this.data.currentWordTarget == null) {
      this.data.currentWordTarget = this.data.settings.startWords;
    }
    return Math.min(this.data.currentWordTarget, this.data.settings.wordCap);
  }

  _growWordTarget() {
    const s = this.data.settings;
    const current = this._getCurrentWordTarget();
    this.data.currentWordTarget = Math.min(s.wordCap, current + s.wordIncrement);
  }

  _shrinkWordTarget() {
    const s = this.data.settings;
    const current = this._getCurrentWordTarget();
    this.data.currentWordTarget = Math.max(s.startWords, current - s.wordIncrement);
  }

  _weightedPick(pool) {
    const today = todayStr();
    const weights = pool.map(b => {
      if (!b.lastWorkedAt) return 5;
      const days = Math.max(0, (new Date(today) - new Date(b.lastWorkedAt)) / 86400000);
      return 1 + Math.min(days, 10);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // Editing books are worked one at a time, in the order you started editing them —
  // never randomly jumping between half-edited books. Only once the active one hits
  // "done" does the next one in line become eligible.
  _ensureActiveEditingBook() {
    const editingBooks = this.data.books.filter(b => b.stage === 'editing' && !b.paused);
    if (editingBooks.length === 0) {
      this.data.activeEditingBookId = null;
      return null;
    }
    const stillValid = editingBooks.find(b => b.id === this.data.activeEditingBookId);
    if (stillValid) return stillValid;

    editingBooks.sort((a, b) =>
      new Date(a.editingStartedAt || a.createdAt) - new Date(b.editingStartedAt || b.createdAt));
    this.data.activeEditingBookId = editingBooks[0].id;
    return editingBooks[0];
  }

  _eligiblePool() {
    const activeEditingBook = this._ensureActiveEditingBook();
    const pool = this.data.books.filter(b => !b.paused && (b.stage === 'writing' || b.stage === 'planning'));
    if (activeEditingBook) pool.push(activeEditingBook);
    return pool;
  }

  _buildTargetFor(book) {
    const s = this.data.settings;
    const wantsPlanning = book.stage === 'planning' ||
      (book.stage === 'writing' && Math.random() < s.planningProbability);

    if (wantsPlanning) {
      // No word count — just figure out what happens in the next chapter.
      return { bookId: book.id, type: 'plan', amount: 1, met: false, metAt: null };
    }
    if (book.stage === 'writing') {
      return { bookId: book.id, type: 'write', amount: this._getCurrentWordTarget(), met: false, metAt: null };
    }
    const remaining = Math.max(1, (book.totalChapters || 1) - (book.chaptersEdited || 0));
    const maxC = Math.max(s.minChapters, Math.min(s.maxChapters, remaining));
    const amount = s.minChapters + Math.floor(Math.random() * (maxC - s.minChapters + 1));
    return { bookId: book.id, type: 'edit', amount, met: false, metAt: null };
  }

  _generateTarget(date) {
    const pool = this._eligiblePool();
    if (pool.length === 0) {
      this.data.dailyTargets[date] = null;
      return;
    }
    this.data.dailyTargets[date] = this._buildTargetFor(this._weightedPick(pool));
  }

  // ---- bonus rounds ----
  // Clear the day's real target, whenever that happens, and a bonus task appears.
  // Clear that one and the next is handed out immediately — they keep coming
  // until the day rolls over. They are deliberately inert: they never feed the
  // streak, never grow the word level, and isTargetMetToday() ignores them, so
  // the punisher stays quiet whether you do them or not.
  //
  // bonusTargets[date] is the day's chain, oldest first. Everything before the
  // last entry has been cleared; the last entry is the one currently on offer.
  _bonusChain(date) {
    const chain = this.data.bonusTargets[date];
    if (!chain) return [];
    if (!Array.isArray(chain)) {
      this.data.bonusTargets[date] = [chain];
      return this.data.bonusTargets[date];
    }
    return chain;
  }

  _activeBonus(date) {
    const chain = this._bonusChain(date);
    return chain.length ? chain[chain.length - 1] : null;
  }

  // Work logged against one round, ignoring whatever the main target (or an
  // earlier round on the same book) had already banked before it was handed out.
  _bonusLogged(date, bonus) {
    return this.data.logs
      .filter(l => l.date === date && l.bookId === bonus.bookId && l.type === bonus.type)
      .reduce((a, l) => a + l.amount, 0) - (bonus.baseline || 0);
  }

  _maybeGenerateBonus(date) {
    const s = this.data.settings;
    if (!s.bonusTasksEnabled) return;
    if (date !== todayStr()) return;
    if (this.isRestDay(date)) return;

    const chain = this._bonusChain(date);
    const active = chain.length ? chain[chain.length - 1] : null;
    // Only ever one open round at a time — the next is minted on completion.
    if (active && !active.met) return;

    const target = this.data.dailyTargets[date];
    if (!target || !target.met) return;

    const pool = this._eligiblePool();
    if (pool.length === 0) return;
    // Prefer a different book than the one the last task used.
    const lastBookId = active ? active.bookId : target.bookId;
    const others = pool.filter(b => b.id !== lastBookId);
    const bonus = this._buildTargetFor(this._weightedPick(others.length ? others : pool));

    // Anything already logged against this book+type today belongs to the main
    // target or an earlier round — bank it so this one doesn't start pre-cleared.
    bonus.baseline = this.data.logs
      .filter(l => l.date === date && l.bookId === bonus.bookId && l.type === bonus.type)
      .reduce((a, l) => a + l.amount, 0);
    bonus.round = chain.length + 1;
    chain.push(bonus);
    this.data.bonusTargets[date] = chain;
  }

  _recomputeBonusMet(date) {
    for (const bonus of this._bonusChain(date)) {
      if (bonus.met) continue;
      if (this._bonusLogged(date, bonus) >= bonus.amount) {
        bonus.met = true;
        bonus.metAt = new Date().toISOString();
      }
    }
  }

  // A deleted entry can pull a round back under its amount — un-clear it, and
  // take back any later round it had unlocked, as long as that one is untouched.
  _rollbackBonusChain(date) {
    const chain = this._bonusChain(date);
    for (const bonus of chain) {
      if (bonus.met && this._bonusLogged(date, bonus) < bonus.amount) {
        bonus.met = false;
        bonus.metAt = null;
      }
    }
    while (chain.length > 1) {
      const last = chain[chain.length - 1];
      const prev = chain[chain.length - 2];
      if (prev.met || last.met || this._bonusLogged(date, last) > 0) break;
      chain.pop();
    }
    if (chain.length === 0) delete this.data.bonusTargets[date];
  }

  // Progress on the round currently on offer.
  bonusProgress(date = todayStr()) {
    const bonus = this._activeBonus(date);
    if (!bonus) return 0;
    return Math.max(0, this._bonusLogged(date, bonus));
  }

  bonusesCleared(date = todayStr()) {
    return this._bonusChain(date).filter(b => b.met).length;
  }

  // Has any of the day's bonus work actually happened? Decides whether the whole
  // chain can be quietly taken back.
  _anyBonusProgress(date) {
    return this._bonusChain(date).some(b => b.met || this._bonusLogged(date, b) > 0);
  }

  // ---- rest days & rerolls ----

  isRestDay(date = todayStr()) {
    return this.data.restDays.includes(date);
  }

  restDaysLeft() {
    const today = todayStr();
    const windowStart = shiftDate(today, -6);
    const used = this.data.restDays.filter(d => d >= windowStart && d <= today).length;
    return Math.max(0, (this.data.settings.restDaysPerWeek || 0) - used);
  }

  toggleRestDay() {
    const today = todayStr();
    const idx = this.data.restDays.indexOf(today);
    if (idx >= 0) {
      this.data.restDays.splice(idx, 1);
      this.save();
      return { ok: true, message: 'Rest day cancelled — the target is live again.', state: this.getState() };
    }
    if (this.restDaysLeft() <= 0) {
      return { ok: false, message: 'No rest days left in the last 7 days.', state: this.getState() };
    }
    this.data.restDays.push(today);
    this.save();
    return { ok: true, message: "Rest day taken. Your streak is safe — don't make a habit of it.", state: this.getState() };
  }

  rerollsLeft() {
    const today = todayStr();
    const used = this.data.rerolls.date === today ? this.data.rerolls.count : 0;
    return Math.max(0, (this.data.settings.rerollsPerDay || 0) - used);
  }

  _hasProgressOnTarget(date) {
    const target = this.data.dailyTargets[date];
    if (!target) return false;
    return this.data.logs.some(l => l.date === date && l.bookId === target.bookId && l.type === target.type);
  }

  canReroll() {
    const today = todayStr();
    const target = this.data.dailyTargets[today];
    if (!target || target.met) return false;
    if (this.rerollsLeft() <= 0) return false;
    return !this._hasProgressOnTarget(today);
  }

  rerollTarget() {
    const today = todayStr();
    this._ensureToday();
    if (!this.canReroll()) {
      return { ok: false, message: 'Nothing to reroll — either you already started, or you are out of rerolls.', state: this.getState() };
    }
    const used = this.data.rerolls.date === today ? this.data.rerolls.count : 0;
    this.data.rerolls = { date: today, count: used + 1 };
    this._generateTarget(today);
    this.save();
    return { ok: true, message: 'New target rolled. No takebacks.', state: this.getState() };
  }

  // ---- history & stats ----

  _wordsByDate() {
    const map = new Map();
    for (const l of this.data.logs) {
      if (l.type !== 'write') continue;
      map.set(l.date, (map.get(l.date) || 0) + l.amount);
    }
    return map;
  }

  _dayHistory(days = HISTORY_DAYS) {
    const today = todayStr();
    const byDate = new Map();
    for (const l of this.data.logs) {
      let bucket = byDate.get(l.date);
      if (!bucket) { bucket = { words: 0, chapters: 0, plans: 0, count: 0 }; byDate.set(l.date, bucket); }
      bucket.count += 1;
      if (l.type === 'write') bucket.words += l.amount;
      else if (l.type === 'edit') bucket.chapters += l.amount;
      else if (l.type === 'plan') bucket.plans += 1;
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = shiftDate(today, -i);
      const bucket = byDate.get(date) || { words: 0, chapters: 0, plans: 0, count: 0 };
      const target = this.data.dailyTargets[date] || null;
      const rest = this.data.restDays.includes(date);
      const active = this.data.activeDates.includes(date);
      let status;
      if (rest) status = 'rest';
      else if (target && target.met) status = 'met';
      else if (date === today) status = target ? 'pending' : 'none';
      else if (target && active) status = 'missed';
      else status = 'none';
      out.push({
        date, status,
        words: bucket.words,
        chapters: bucket.chapters,
        plans: bucket.plans,
        logCount: bucket.count,
        target: target ? { type: target.type, amount: target.amount, met: target.met } : null
      });
    }
    return out;
  }

  getStats() {
    const today = todayStr();
    const logs = this.data.logs;
    const history = this._dayHistory(HISTORY_DAYS);
    const wordsByDate = this._wordsByDate();

    let bestDay = { date: null, words: 0 };
    for (const [date, words] of wordsByDate) {
      if (words > bestDay.words) bestDay = { date, words };
    }

    const sumWords = (arr) => arr.reduce((a, d) => a + d.words, 0);
    const last7 = history.slice(-7);
    const prev7 = history.slice(-14, -7);
    const last30 = history.slice(-30);

    const totalWords = logs.filter(l => l.type === 'write').reduce((a, l) => a + l.amount, 0);
    const totalChapters = logs.filter(l => l.type === 'edit').reduce((a, l) => a + l.amount, 0);
    const totalPlans = logs.filter(l => l.type === 'plan').length;
    const allBonuses = Object.values(this.data.bonusTargets)
      .flatMap(v => Array.isArray(v) ? v : (v ? [v] : []));

    let met = 0, missed = 0, rested = 0;
    for (const d of history) {
      if (d.status === 'met') met++;
      else if (d.status === 'missed') missed++;
      else if (d.status === 'rest') rested++;
    }
    const scored = met + missed;

    const writingDays = [...wordsByDate.values()].filter(w => w > 0).length;

    return {
      totalWords,
      totalChapters,
      totalPlans,
      totalLogs: logs.length,
      wordsToday: wordsByDate.get(today) || 0,
      words7: sumWords(last7),
      wordsPrev7: sumWords(prev7),
      words30: sumWords(last30),
      bestDay,
      writingDays,
      avgPerWritingDay: writingDays ? Math.round(totalWords / writingDays) : 0,
      targetsMet: met,
      targetsMissed: missed,
      restDaysTaken: rested,
      consistency: scored ? Math.round((met / scored) * 100) : 0,
      bonusesEarned: allBonuses.length,
      bonusesCompleted: allBonuses.filter(b => b && b.met).length,
      booksDone: this.data.books.filter(b => b.stage === 'done').length,
      history
    };
  }

  queryLogs({ bookId, type, limit = 200, offset = 0 } = {}) {
    let logs = this.data.logs.slice().reverse();
    if (bookId) logs = logs.filter(l => l.bookId === bookId);
    if (type) logs = logs.filter(l => l.type === type);
    return { total: logs.length, logs: logs.slice(offset, offset + limit) };
  }

  // ---- public API ----

  getState() {
    const today = todayStr();
    this._ensureToday();
    const target = this.data.dailyTargets[today] || null;
    const targetBook = target ? this.data.books.find(b => b.id === target.bookId) : null;
    const bonusChain = this._bonusChain(today);
    const bonus = bonusChain.length ? bonusChain[bonusChain.length - 1] : null;
    return {
      today,
      books: this.data.books,
      target,
      targetBook,
      bonus,
      bonusBook: bonus ? this.data.books.find(b => b.id === bonus.bookId) : null,
      bonusDone: bonus ? this.bonusProgress(today) : 0,
      bonusRound: bonus ? bonusChain.length : 0,
      bonusCleared: bonusChain.filter(b => b.met).length,
      activeEditingBookId: this.data.activeEditingBookId,
      wordTarget: { current: this._getCurrentWordTarget(), cap: this.data.settings.wordCap, start: this.data.settings.startWords },
      streak: this.data.streak,
      settings: this.data.settings,
      todaysLogs: this.data.logs.filter(l => l.date === today),
      punishState: this.data.punishState,
      recentLogs: this.data.logs.slice(-60).reverse(),
      isRestDay: this.isRestDay(today),
      restDaysLeft: this.restDaysLeft(),
      canReroll: this.canReroll(),
      rerollsLeft: this.rerollsLeft(),
      stats: this.getStats()
    };
  }

  addBook(title) {
    const book = {
      id: uid(),
      title: title.trim(),
      stage: 'writing',
      wordsWritten: 0,
      totalChapters: null,
      targetWords: null,
      chaptersEdited: 0,
      chaptersPlanned: 0,
      chaptersWritten: 0,
      lastWorkedAt: null,
      coverPath: null,
      blurb: '',
      paused: false,
      createdAt: new Date().toISOString()
    };
    this.data.books.push(book);
    this._refreshTodayTargetIfUntouched();
    this.save();
    return book;
  }

  // A newly-eligible book (just added, or a book just moved into editing) shouldn't
  // have to wait until tomorrow to get a shot at today's target — but only reroll
  // if nothing has been logged against today's current target yet, so we never
  // undo progress you've already made.
  _refreshTodayTargetIfUntouched() {
    const today = todayStr();
    const target = this.data.dailyTargets[today];
    if (!target) {
      this._generateTarget(today);
      return;
    }
    if (target.met) return;
    if (!this._hasProgressOnTarget(today)) this._generateTarget(today);
  }

  _coversDir() {
    const dir = path.join(path.dirname(this.filePath), 'covers');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Covers for a book always land on the same filename, so a replacement with the
  // same extension reuses the URL the renderer already has cached. coverUpdatedAt
  // gives the renderer a token to bust that cache with — and it only changes when
  // the cover does, so ordinary re-renders still hit the cache.
  _removeCoverFiles(bookId) {
    const dir = this._coversDir();
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(bookId + '.')) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* already gone */ }
      }
    }
  }

  setCover(bookId, sourcePath) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b || !sourcePath) return this.getState();
    const ext = path.extname(sourcePath) || '.jpg';
    const dest = path.join(this._coversDir(), `${bookId}${ext}`);
    if (path.resolve(sourcePath) === path.resolve(dest)) {
      // Re-picking the stored cover itself — deleting it would destroy the source.
      b.coverPath = dest;
      b.coverUpdatedAt = Date.now();
      this.save();
      return this.getState();
    }
    // Drop any previous cover first — a .png replaced by a .jpg would otherwise
    // leave the old file orphaned on disk forever.
    this._removeCoverFiles(bookId);
    fs.copyFileSync(sourcePath, dest);
    b.coverPath = dest;
    b.coverUpdatedAt = Date.now();
    this.save();
    return this.getState();
  }

  clearCover(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    this._removeCoverFiles(bookId);
    b.coverPath = null;
    b.coverUpdatedAt = Date.now();
    this.save();
    return this.getState();
  }

  setBlurb(bookId, blurb) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.blurb = (blurb || '').slice(0, 2000);
    this.save();
    return this.getState();
  }

  renameBook(bookId, title) {
    const b = this.data.books.find(x => x.id === bookId);
    const clean = (title || '').trim();
    if (!b || !clean) return this.getState();
    b.title = clean.slice(0, 160);
    this.save();
    return this.getState();
  }

  setTargetWords(bookId, words) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    const n = parseInt(words, 10);
    b.targetWords = Number.isFinite(n) && n > 0 ? n : null;
    this.save();
    return this.getState();
  }

  // A paused book is invisible to the daily picker — useful for a project you've
  // shelved without wanting to delete its history.
  setPaused(bookId, paused) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.paused = !!paused;
    this._ensureActiveEditingBook();
    this._refreshTodayTargetIfUntouched();
    this.save();
    return this.getState();
  }

  // Freeform progress counters for the phases that come before "Completed" —
  // there's no fixed chapter total yet at that point, so these aren't capped.
  setChaptersPlanned(bookId, count) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.chaptersPlanned = Math.max(0, parseInt(count, 10) || 0);
    this.save();
    return this.getState();
  }

  setChaptersWritten(bookId, count) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.chaptersWritten = Math.max(0, parseInt(count, 10) || 0);
    this.save();
    return this.getState();
  }

  // Absolute set for the running word total. Logging progress adds to this
  // incrementally, but a book you started outside the app (or in ForgeTales
  // before you installed it) needs a way to say "I'm already at 32,000" so the
  // word-goal progress bar means something.
  setWordsWritten(bookId, words) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    const n = parseInt(words, 10);
    b.wordsWritten = Number.isFinite(n) && n > 0 ? n : 0;
    this.save();
    return this.getState();
  }

  setTotalChapters(bookId, count) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.totalChapters = Math.max(1, parseInt(count, 10) || 1);
    this.save();
    return this.getState();
  }

  markCompleted(bookId, totalChapters) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return;
    b.stage = 'completed';
    b.totalChapters = Math.max(1, parseInt(totalChapters, 10) || 1);
    b.chaptersEdited = 0;
    this.save();
  }

  needsPlanning(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b || b.stage !== 'writing') return;
    b.stage = 'planning';
    this.save();
  }

  cancelPlanning(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b || b.stage !== 'planning') return;
    b.stage = 'writing';
    this.save();
  }

  // Escape hatch for a book marked "drafted" too early.
  reopenDraft(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b || b.stage !== 'completed') return this.getState();
    b.stage = 'writing';
    this._refreshTodayTargetIfUntouched();
    this.save();
    return this.getState();
  }

  startEditing(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return;
    b.stage = 'editing';
    b.editingStartedAt = b.editingStartedAt || new Date().toISOString();
    this._ensureActiveEditingBook();
    this._refreshTodayTargetIfUntouched();
    this.save();
  }

  // Absolute set (e.g. "I'm at chapter 7 of 12"), as an alternative to logging
  // incremental chapters via logProgress. Also handles the done transition.
  setChaptersEdited(bookId, count) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    const clamped = Math.max(0, Math.min(b.totalChapters || count, parseInt(count, 10) || 0));
    b.chaptersEdited = clamped;
    b.lastWorkedAt = todayStr();
    if (b.totalChapters && b.chaptersEdited >= b.totalChapters) {
      b.stage = 'done';
    }
    this._ensureActiveEditingBook();
    this.save();
    return this.getState();
  }

  markEditingDone(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return this.getState();
    b.chaptersEdited = b.totalChapters || b.chaptersEdited || 0;
    b.stage = 'done';
    this._ensureActiveEditingBook();
    this.save();
    return this.getState();
  }

  deleteBook(bookId) {
    this.data.books = this.data.books.filter(b => b.id !== bookId);
    this._ensureActiveEditingBook();
    this.save();
  }

  logProgress({ bookId, type, amount, note, chapterComplete }) {
    // Make sure today's target is generated/reconciled before we check it —
    // a stage change (e.g. flagging a book "needs planning") right before this
    // call could otherwise leave a stale target that silently never matches.
    this._ensureToday();
    const today = todayStr();
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) throw new Error('Book not found');
    amount = Math.max(0, parseInt(amount, 10) || 0);

    const entry = { id: uid(), date: today, bookId, type, amount, note: note || '', chapterComplete: !!chapterComplete, createdAt: new Date().toISOString() };
    this.data.logs.push(entry);

    b.lastWorkedAt = today;
    if (type === 'plan') {
      b.chaptersPlanned = (b.chaptersPlanned || 0) + 1;
      if (b.stage === 'planning') b.stage = 'writing';
    } else if (type === 'write') {
      b.wordsWritten = (b.wordsWritten || 0) + amount;
      if (entry.chapterComplete) b.chaptersWritten = (b.chaptersWritten || 0) + 1;
    } else if (type === 'edit') {
      b.chaptersEdited = Math.min((b.totalChapters || amount), (b.chaptersEdited || 0) + amount);
      if (b.totalChapters && b.chaptersEdited >= b.totalChapters) {
        b.stage = 'done';
        this._ensureActiveEditingBook();
      }
    }

    this._recomputeTargetMet(today);
    this._recomputeBonusMet(today);
    this._maybeGenerateBonus(today);
    if (chapterComplete && type === 'write') this._handOffRemainingTarget(today, bookId);
    this.save();
    return this.getState();
  }

  // Undo a mis-typed entry: reverse exactly what that log did to its book, then
  // re-score the day it belonged to (including walking the streak back if the
  // entry is what pushed the day over the line).
  deleteLog(logId) {
    const idx = this.data.logs.findIndex(l => l.id === logId);
    if (idx === -1) return this.getState();
    const entry = this.data.logs[idx];
    this.data.logs.splice(idx, 1);

    const b = this.data.books.find(x => x.id === entry.bookId);
    if (b) {
      if (entry.type === 'write') {
        b.wordsWritten = Math.max(0, (b.wordsWritten || 0) - entry.amount);
        if (entry.chapterComplete) b.chaptersWritten = Math.max(0, (b.chaptersWritten || 0) - 1);
      } else if (entry.type === 'edit') {
        b.chaptersEdited = Math.max(0, (b.chaptersEdited || 0) - entry.amount);
        if (b.stage === 'done' && b.totalChapters && b.chaptersEdited < b.totalChapters) b.stage = 'editing';
      } else if (entry.type === 'plan') {
        b.chaptersPlanned = Math.max(0, (b.chaptersPlanned || 0) - 1);
      }
      const remaining = this.data.logs.filter(l => l.bookId === b.id);
      b.lastWorkedAt = remaining.length ? remaining[remaining.length - 1].date : null;
    }

    // Rounds first: unscoring checks whether any bonus work survives, and that
    // answer is only right once the stale "cleared" flags have been walked back.
    this._rollbackBonusChain(entry.date);
    this._unscoreIfNoLongerMet(entry.date);
    this._ensureActiveEditingBook();
    this.save();
    return this.getState();
  }

  _unscoreIfNoLongerMet(date) {
    const target = this.data.dailyTargets[date];
    if (!target || !target.met) return;
    const sum = this.data.logs
      .filter(l => l.date === date && l.bookId === target.bookId && l.type === target.type)
      .reduce((a, l) => a + l.amount, 0);
    if (sum >= target.amount) return;

    target.met = false;
    target.metAt = null;
    // The bonus was awarded for finishing this target early; if it turns out you
    // hadn't, take it back — unless you've already started it.
    if (!this._anyBonusProgress(date)) delete this.data.bonusTargets[date];
    const s = this.data.streak;
    if (s.lastUpdatedDate === date) {
      s.current = Math.max(0, s.current - 1);
      // Rewind the scoring cursor to the day before, not to null — null would make
      // _rollStreakIfNeeded replay (and re-count) the entire history.
      const earlier = this.data.activeDates.filter(d => d < date).sort();
      s.lastUpdatedDate = earlier.length ? earlier[earlier.length - 1] : null;
      if (target.type === 'write') this._shrinkWordTarget();
    }
  }

  // If a chapter wraps up before today's word target is used up, don't force the
  // writer to keep grinding the same book past a natural break — immediately hand
  // the leftover word count to a different random writing book.
  _handOffRemainingTarget(date, justLoggedBookId) {
    const target = this.data.dailyTargets[date];
    if (!target || target.met || target.type !== 'write' || target.bookId !== justLoggedBookId) return;

    const sum = this.data.logs
      .filter(l => l.date === date && l.bookId === target.bookId && l.type === 'write')
      .reduce((a, l) => a + l.amount, 0);
    const remaining = target.amount - sum;
    if (remaining <= 0) return;

    const candidates = this.data.books.filter(b => b.stage === 'writing' && !b.paused && b.id !== justLoggedBookId);
    if (candidates.length === 0) return;

    const nextBook = this._weightedPick(candidates);
    this.data.dailyTargets[date] = { bookId: nextBook.id, type: 'write', amount: remaining, met: false, metAt: null };
  }

  _recomputeTargetMet(date) {
    const target = this.data.dailyTargets[date];
    if (!target || target.met) return;
    const sum = this.data.logs
      .filter(l => l.date === date && l.bookId === target.bookId && l.type === target.type)
      .reduce((a, l) => a + l.amount, 0);
    if (sum >= target.amount) {
      target.met = true;
      target.metAt = new Date().toISOString();
      if (date === todayStr()) this._scoreStreakForToday(target);
    }
  }

  // Don't make the streak wait until tomorrow's rollover to reflect a target
  // you just hit — count it the moment it's met, so the number on screen is
  // never a day behind reality. _rollStreakIfNeeded still handles past days
  // (missed days, or catching up after being away).
  _scoreStreakForToday(target) {
    const today = todayStr();
    const s = this.data.streak;
    if (s.lastUpdatedDate === today) return;
    s.current += 1;
    s.longest = Math.max(s.longest, s.current);
    s.lastUpdatedDate = today;
    if (target.type === 'write') this._growWordTarget();
  }

  isTargetMetToday() {
    const today = todayStr();
    if (this.isRestDay(today)) return true; // a declared day off is nothing to punish
    const t = this.data.dailyTargets[today];
    return !t || t.met; // no target (e.g. no books) counts as nothing to punish for
  }

  updateSettings(partial) {
    Object.assign(this.data.settings, partial);
    this.save();
    return this.data.settings;
  }

  setWindowBounds(bounds) {
    this.data.windowBounds = bounds;
    this.save();
  }

  // punishment bookkeeping
  getPunishState() {
    this._ensureToday();
    return this.data.punishState;
  }

  bumpSnooze() {
    const ps = this.getPunishState();
    ps.snoozeCount += 1;
    ps.lastNagAt = new Date().toISOString();
    if (ps.snoozeCount > this.data.settings.snoozeThreshold) {
      ps.escalated = true;
    }
    this.save();
    return ps;
  }

  setLastNagAt() {
    const ps = this.getPunishState();
    ps.lastNagAt = new Date().toISOString();
    this.save();
  }
}

module.exports = { Store, todayStr };
