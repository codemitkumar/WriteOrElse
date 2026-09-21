// Celebration layer — confetti, banners, stamps, shockwaves and count-ups.
//
// Pure DOM + one requestAnimationFrame loop. No canvas, no dependencies, so it
// ships with the rest of the renderer and costs nothing until something is
// actually worth celebrating.
//
// Every entry point is a silent no-op when effects are off — the user turned
// them down in Settings, the OS asked for reduced motion, or the window is
// hidden in the tray and nobody would see it. Callers never have to check.
(function () {
  'use strict';

  // One shared rAF loop drives every live particle. Transform/opacity only, so
  // the compositor does the work and nothing reflows.
  const GRAVITY = 1450;      // px/s^2
  const DRAG = 3.1;          // velocity damping per second
  const MAX_PARTICLES = 260; // hard ceiling; new bursts trim the oldest
  const SHAPES = ['sq', 'bar', 'tri', 'dot'];

  let fxLayer = null;
  let bannerLayer = null;
  let enabled = true;
  const particles = [];
  let rafId = null;
  let lastTs = 0;

  const bannerQueue = [];
  let bannerBusy = false;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reduced() { return prefersReduced.matches; }
  function active() { return enabled && !reduced() && !document.hidden; }

  function layers() {
    if (!fxLayer) {
      fxLayer = document.createElement('div');
      fxLayer.className = 'fx-layer';
      document.body.appendChild(fxLayer);
    }
    if (!bannerLayer) {
      bannerLayer = document.createElement('div');
      bannerLayer.className = 'fx-banner-layer';
      document.body.appendChild(bannerLayer);
    }
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Palettes are read live so confetti always matches the accent the user
  // picked rather than a hard-coded orange.
  function palette(tone) {
    const accent = cssVar('--accent', '#ff8a3d');
    const accent2 = cssVar('--accent-2', '#ff6b35');
    const green = cssVar('--green', '#4ade80');
    const amber = cssVar('--amber', '#fbbf24');
    const violet = cssVar('--violet', '#a78bfa');
    const blue = cssVar('--blue', '#6ea8ff');
    if (tone === 'green') return [green, green, accent, amber, '#ffffff'];
    if (tone === 'gold') return [amber, '#ffd166', accent, '#fff3c4', '#ffffff'];
    if (tone === 'violet') return [violet, blue, accent, '#ffffff'];
    return [accent, accent2, amber, violet, '#ffffff'];
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function makeParticle(x, y, angle, speed, color, scalar) {
    const node = document.createElement('i');
    const shape = pick(SHAPES);
    const size = rand(6, 11) * scalar;
    node.className = 'fx-p ' + shape;
    node.style.background = color;
    node.style.width = (shape === 'bar' ? size * 0.45 : size) + 'px';
    node.style.height = (shape === 'bar' ? size * 1.6 : size) + 'px';
    fxLayer.appendChild(node);
    return {
      node, x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: rand(0, 360),
      rotV: rand(-620, 620),
      tilt: rand(0, 360),
      tiltV: rand(-420, 420),
      life: 0,
      maxLife: rand(1.5, 2.6),
      wobble: rand(0, Math.PI * 2),
      wobbleV: rand(3, 7),
      sway: rand(8, 34)
    };
  }

  function step(ts) {
    const dt = Math.min(0.048, lastTs ? (ts - lastTs) / 1000 : 0.016);
    lastTs = ts;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.wobble += p.wobbleV * dt;
      const damp = Math.max(0, 1 - DRAG * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + GRAVITY * dt;
      p.x += (p.vx + Math.cos(p.wobble) * p.sway) * dt;
      p.y += p.vy * dt;
      p.rot += p.rotV * dt;
      p.tilt += p.tiltV * dt;
      // Fade over the last third of the life so nothing pops out of existence.
      const fade = p.life / p.maxLife;
      const opacity = fade < 0.66 ? 1 : Math.max(0, 1 - (fade - 0.66) / 0.34);
      p.node.style.opacity = opacity;
      p.node.style.transform =
        'translate3d(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px,0) ' +
        'rotate(' + p.rot.toFixed(0) + 'deg) rotate3d(1,.6,0,' + p.tilt.toFixed(0) + 'deg)';
      if (p.life >= p.maxLife || p.y > window.innerHeight + 80) {
        p.node.remove();
        particles.splice(i, 1);
      }
    }
    if (particles.length) rafId = requestAnimationFrame(step);
    else { rafId = null; lastTs = 0; }
  }

  function pump() {
    if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(step); }
  }

  function trim() {
    while (particles.length > MAX_PARTICLES) particles.shift().node.remove();
  }

  // ---- effects ----

  // A cone of confetti from a point. `angle`/`spread` are in degrees, measured
  // the screen way up: -90 is straight up.
  function confetti(opts) {
    if (!active()) return;
    layers();
    const o = Object.assign({
      x: window.innerWidth / 2, y: window.innerHeight * 0.55,
      count: 60, angle: -90, spread: 70, power: 780, tone: '', scalar: 1
    }, opts || {});
    const colors = o.colors || palette(o.tone);
    const base = (o.angle * Math.PI) / 180;
    const half = (o.spread * Math.PI) / 360;
    for (let i = 0; i < o.count; i++) {
      particles.push(makeParticle(
        o.x + rand(-8, 8), o.y + rand(-8, 8),
        base + rand(-half, half),
        o.power * rand(0.55, 1.15),
        pick(colors), o.scalar
      ));
    }
    trim();
    pump();
  }

  // Burst centred on an element, so a cleared bonus card throws its own
  // confetti instead of the middle of the screen throwing it for it.
  function fromElement(target, opts) {
    if (!active() || !target) return;
    const r = target.getBoundingClientRect();
    if (!r.width) return;
    confetti(Object.assign({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, opts || {}));
  }

  // Two corner cannons firing inward — the big one.
  function cannons(tone, count) {
    if (!active()) return;
    const n = count || 55;
    const y = window.innerHeight * 0.96;
    confetti({ x: 8, y, angle: -62, spread: 52, power: 1180, count: n, tone });
    confetti({ x: window.innerWidth - 8, y, angle: -118, spread: 52, power: 1180, count: n, tone });
  }

  function flash(tone) {
    if (!active()) return;
    layers();
    const node = document.createElement('div');
    node.className = 'fx-flash ' + (tone || '');
    fxLayer.appendChild(node);
    node.addEventListener('animationend', () => node.remove());
  }

  // An expanding ring pinned to an element's centre.
  function shockwave(target, tone) {
    if (!active() || !target) return;
    const r = target.getBoundingClientRect();
    if (!r.width) return;
    layers();
    const node = document.createElement('div');
    node.className = 'fx-wave ' + (tone || '');
    const size = Math.max(r.width, r.height) * 0.7;
    node.style.left = (r.left + r.width / 2 - size / 2) + 'px';
    node.style.top = (r.top + r.height / 2 - size / 2) + 'px';
    node.style.width = node.style.height = size + 'px';
    fxLayer.appendChild(node);
    node.addEventListener('animationend', () => node.remove());
  }

  // Little sparks thrown off a small element (a counter ticking over, a flame
  // catching). Cheaper and much quieter than confetti.
  function sparkle(target, count, tone) {
    if (!active() || !target) return;
    const r = target.getBoundingClientRect();
    if (!r.width) return;
    layers();
    const colors = palette(tone);
    const n = count || 10;
    for (let i = 0; i < n; i++) {
      const node = document.createElement('i');
      node.className = 'fx-spark';
      node.style.background = pick(colors);
      node.style.left = (r.left + r.width / 2) + 'px';
      node.style.top = (r.top + r.height / 2) + 'px';
      const a = rand(0, Math.PI * 2);
      const d = rand(22, 60);
      node.style.setProperty('--tx', (Math.cos(a) * d).toFixed(1) + 'px');
      node.style.setProperty('--ty', (Math.sin(a) * d).toFixed(1) + 'px');
      node.style.animationDelay = rand(0, 90).toFixed(0) + 'ms';
      fxLayer.appendChild(node);
      node.addEventListener('animationend', () => node.remove());
    }
  }

  // A rubber-stamp slam over a card. Any previous stamp on the same element is
  // removed first, so a second win doesn't stack two of them.
  function stamp(target, text, tone) {
    if (!active() || !target) return;
    target.querySelectorAll(':scope > .fx-stamp').forEach(n => n.remove());
    const node = document.createElement('div');
    node.className = 'fx-stamp ' + (tone || '');
    node.textContent = text;
    node.style.setProperty('--tilt', rand(-9, -3).toFixed(1) + 'deg');
    target.appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      node.addEventListener('transitionend', () => node.remove(), { once: true });
    }, 2100);
  }

  // Banners are queued rather than stacked — one log can clear a target, bank a
  // reroll and set a record all at once, and three cards fighting over the
  // middle of the screen reads as a bug.
  function banner(spec) {
    if (!enabled || document.hidden) return;
    bannerQueue.push(spec);
    if (!bannerBusy) nextBanner();
  }

  function nextBanner() {
    const spec = bannerQueue.shift();
    if (!spec) { bannerBusy = false; return; }
    bannerBusy = true;
    layers();
    const hold = spec.duration || 2500;
    const node = document.createElement('div');
    node.className = 'fx-banner ' + (spec.tone || '');
    node.innerHTML =
      '<div class="fx-banner-glow"></div>' +
      '<div class="fx-banner-icon"></div>' +
      '<div class="fx-banner-text">' +
        '<div class="fx-banner-title"></div>' +
        '<div class="fx-banner-sub"></div>' +
      '</div>';
    node.querySelector('.fx-banner-icon').textContent = spec.icon || '✓';
    node.querySelector('.fx-banner-title').textContent = spec.title || '';
    const sub = node.querySelector('.fx-banner-sub');
    if (spec.subtitle) sub.textContent = spec.subtitle;
    else sub.remove();
    bannerLayer.appendChild(node);

    // Clicking it dismisses early — a celebration you have to sit through stops
    // being one the second time you see it.
    const dismiss = () => {
      if (node.dataset.going) return;
      node.dataset.going = '1';
      clearTimeout(timer);
      node.classList.add('leaving');
      setTimeout(() => { node.remove(); setTimeout(nextBanner, 90); }, reduced() ? 0 : 300);
    };
    node.addEventListener('click', dismiss);
    const timer = setTimeout(dismiss, reduced() ? Math.min(hold, 1400) : hold);
  }

  // Tiered composite. Callers say what happened and how big it was; the mix of
  // effects lives here so the whole app escalates consistently.
  function party(spec) {
    const tier = spec.tier || 2;
    const tone = spec.tone || '';
    if (spec.title) {
      banner({ icon: spec.icon, title: spec.title, subtitle: spec.subtitle, tone, duration: spec.duration });
    }
    if (tier >= 3) {
      flash(tone);
      cannons(tone, tier >= 4 ? 80 : 55);
      confetti({
        x: window.innerWidth / 2, y: window.innerHeight * 0.42,
        count: tier >= 4 ? 90 : 60, spread: 360, power: 620, tone
      });
    } else if (spec.anchor) {
      fromElement(spec.anchor, { count: 42, spread: 150, power: 640, tone });
    } else {
      confetti({ count: 38, tone });
    }
    if (spec.anchor) {
      shockwave(spec.anchor, tone);
      if (spec.win) pulse(spec.anchor, 'fx-win');
      if (spec.stamp) stamp(spec.anchor, spec.stamp, tone);
    }
  }

  // ---- number count-up ----
  // Animates an element's number toward a new value. The first value an element
  // is ever given is written straight in: a dashboard that counts every figure
  // up from zero on open is a loading screen, not a celebration.
  const countTimers = new WeakMap();

  function countUp(node, to, opts) {
    if (!node) return;
    const o = Object.assign({ duration: 620, format: (n) => Math.round(n).toLocaleString() }, opts || {});
    const prev = node.dataset.fxVal;
    const from = prev === undefined ? to : parseFloat(prev);
    node.dataset.fxVal = String(to);
    const existing = countTimers.get(node);
    if (existing) cancelAnimationFrame(existing);
    if (prev === undefined || from === to || reduced() || !enabled || document.hidden) {
      node.textContent = o.format(to);
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / o.duration);
      // ease-out-cubic: quick off the mark, settles gently on the real figure
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = o.format(from + (to - from) * eased);
      if (t < 1) countTimers.set(node, requestAnimationFrame(tick));
      else { countTimers.delete(node); node.textContent = o.format(to); }
    };
    countTimers.set(node, requestAnimationFrame(tick));
  }

  // A one-shot class that re-triggers its animation even when the class is
  // already on the element (used for "this number just changed" pops).
  function pulse(node, cls) {
    if (!node || !active()) return;
    const name = cls || 'fx-pop';
    node.classList.remove(name);
    void node.offsetWidth; // force a reflow so the animation restarts
    node.classList.add(name);
    node.addEventListener('animationend', () => node.classList.remove(name), { once: true });
  }

  // Drop everything in flight — used when the window is hidden mid-burst so we
  // aren't animating into a tray icon.
  function clear() {
    while (particles.length) particles.pop().node.remove();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; lastTs = 0; }
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });

  window.Celebrate = {
    setEnabled(v) { enabled = !!v; if (!enabled) clear(); },
    isEnabled() { return enabled; },
    reduced,
    confetti, fromElement, cannons, flash, shockwave, sparkle, stamp,
    banner, party, countUp, pulse, clear
  };
})();
