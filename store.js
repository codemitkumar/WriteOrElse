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
  nagProbability: 0.7 // chance a nag actually fires each check, before escalation
};

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
    this._ensureToday();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Object.assign(this._blank(), parsed, {
        settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {})
      });
    } catch (e) {
      return this._blank();
    }
  }

  _blank() {
    return {
      version: 1,
      books: [],
      logs: [],
      dailyTargets: {},
      activeDates: [],
      activeEditingBookId: null,
      currentWordTarget: null,
      punishState: { date: null, snoozeCount: 0, escalated: false, lastNagAt: null },
      streak: { current: 0, longest: 0, lastUpdatedDate: null },
      settings: Object.assign({}, DEFAULT_SETTINGS)
    };
  }

  save() {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
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
    }
    this.save();
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
      if (target && target.met) {
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
    const editingBooks = this.data.books.filter(b => b.stage === 'editing');
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

  _generateTarget(date) {
    const activeEditingBook = this._ensureActiveEditingBook();
    const pool = this.data.books.filter(b => b.stage === 'writing' || b.stage === 'planning');
    if (activeEditingBook) pool.push(activeEditingBook);
    if (pool.length === 0) {
      this.data.dailyTargets[date] = null;
      return;
    }
    const book = this._weightedPick(pool);
    const s = this.data.settings;
    const wantsPlanning = book.stage === 'planning' ||
      (book.stage === 'writing' && Math.random() < s.planningProbability);

    if (wantsPlanning) {
      // No word count today — just figure out what happens in the next chapter.
      this.data.dailyTargets[date] = { bookId: book.id, type: 'plan', amount: 1, met: false, metAt: null };
    } else if (book.stage === 'writing') {
      const amount = this._getCurrentWordTarget();
      this.data.dailyTargets[date] = { bookId: book.id, type: 'write', amount, met: false, metAt: null };
    } else {
      const remaining = Math.max(1, (book.totalChapters || 1) - (book.chaptersEdited || 0));
      const maxC = Math.max(s.minChapters, Math.min(s.maxChapters, remaining));
      const amount = s.minChapters + Math.floor(Math.random() * (maxC - s.minChapters + 1));
      this.data.dailyTargets[date] = { bookId: book.id, type: 'edit', amount, met: false, metAt: null };
    }
  }

  // ---- public API ----

  getState() {
    const today = todayStr();
    this._ensureToday();
    const target = this.data.dailyTargets[today] || null;
    const targetBook = target ? this.data.books.find(b => b.id === target.bookId) : null;
    return {
      today,
      books: this.data.books,
      target,
      targetBook,
      activeEditingBookId: this.data.activeEditingBookId,
      wordTarget: { current: this._getCurrentWordTarget(), cap: this.data.settings.wordCap },
      streak: this.data.streak,
      settings: this.data.settings,
      todaysLogs: this.data.logs.filter(l => l.date === today),
      punishState: this.data.punishState,
      recentLogs: this.data.logs.slice(-30).reverse()
    };
  }

  addBook(title) {
    const book = {
      id: uid(),
      title: title.trim(),
      stage: 'writing',
      wordsWritten: 0,
      totalChapters: null,
      chaptersEdited: 0,
      lastWorkedAt: null,
      coverPath: null,
      blurb: '',
      createdAt: new Date().toISOString()
    };
    this.data.books.push(book);
    this.save();
    return book;
  }

  _coversDir() {
    const dir = path.join(path.dirname(this.filePath), 'covers');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  setCover(bookId, sourcePath) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b || !sourcePath) return this.getState();
    const ext = path.extname(sourcePath) || '.jpg';
    const dest = path.join(this._coversDir(), `${bookId}${ext}`);
    fs.copyFileSync(sourcePath, dest);
    b.coverPath = dest;
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

  startEditing(bookId) {
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) return;
    b.stage = 'editing';
    b.editingStartedAt = b.editingStartedAt || new Date().toISOString();
    this._ensureActiveEditingBook();
    this.save();
  }

  deleteBook(bookId) {
    this.data.books = this.data.books.filter(b => b.id !== bookId);
    this.save();
  }

  logProgress({ bookId, type, amount, note, chapterComplete }) {
    const today = todayStr();
    const b = this.data.books.find(x => x.id === bookId);
    if (!b) throw new Error('Book not found');
    amount = Math.max(0, parseInt(amount, 10) || 0);

    const entry = { id: uid(), date: today, bookId, type, amount, note: note || '', chapterComplete: !!chapterComplete, createdAt: new Date().toISOString() };
    this.data.logs.push(entry);

    b.lastWorkedAt = today;
    if (type === 'plan') {
      if (b.stage === 'planning') b.stage = 'writing';
    } else if (type === 'write') {
      b.wordsWritten = (b.wordsWritten || 0) + amount;
    } else if (type === 'edit') {
      b.chaptersEdited = Math.min((b.totalChapters || amount), (b.chaptersEdited || 0) + amount);
      if (b.totalChapters && b.chaptersEdited >= b.totalChapters) {
        b.stage = 'done';
        this._ensureActiveEditingBook();
      }
    }

    this._recomputeTargetMet(today);
    if (chapterComplete && type === 'write') this._handOffRemainingTarget(today, bookId);
    this.save();
    return this.getState();
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

    const candidates = this.data.books.filter(b => b.stage === 'writing' && b.id !== justLoggedBookId);
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
    }
  }

  isTargetMetToday() {
    const today = todayStr();
    const t = this.data.dailyTargets[today];
    return !t || t.met; // no target (e.g. no books) counts as nothing to punish for
  }

  updateSettings(partial) {
    Object.assign(this.data.settings, partial);
    this.save();
    return this.data.settings;
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
