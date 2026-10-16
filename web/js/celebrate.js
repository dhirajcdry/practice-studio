// The Accepted celebration: a five-second event across the whole page, and a toast with
// the solved count and streak.
//
// Eight variants rotate through a shuffle bag kept in localStorage, so the same one never
// plays twice in a row, and each re-rolls its own layout, direction, density and colour
// mix, so even a repeat lands differently. Colours come from the live theme's tokens: a
// celebration in Abyss glows teal, one in Editorial prints in oxblood and ochre.
//
// Every variant has the same shape: a bloom from the Submit button and a dimmed (dark) or
// warm-washed (light) stage, a peak that holds for a second or two, then a settle where
// everything drifts down and fades with the stage. Depth comes from two layers: crisp
// small pieces far away and big soft-focus ones close up, moving faster.
//
// Nothing here may break the submit flow: every entry point swallows its own errors.

import { getSettings } from './settings.js';
import { announceStatsChanged, computeStreak, loadStats } from './streak.js';

const BAG_KEY = 'studio.celebrate.bag';
const MAX_PARTICLES = 600;
const END = 5.1;                // seconds; the stage is clear by here
const FADE_OUT = 0.7;           // everything left fades over the last stretch
const TOAST_MS = 5500;
const TAU = Math.PI * 2;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeIn = (t) => Math.pow(clamp(t, 0, 1), 3);
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const backOut = (t) => { const x = clamp(t, 0, 1) - 1; return 1 + 2.2 * x * x * x + 1.2 * x * x; };
const chance = (p) => Math.random() < p;

let active = null;              // the running celebration, so a second one replaces it

/**
 * @param {{origin?: DOMRect|null, variant?: number}} [options]
 */
export function celebrate({ origin = null, variant } = {}) {
  try {
    const settings = safeSettings();
    const reduced = settings.motion === false || prefersReducedMotion();
    showToast({ still: reduced });
    if (reduced || settings.celebrations === false) return;
    const index = Number.isInteger(variant) ? ((variant % VARIANTS.length) + VARIANTS.length) % VARIANTS.length : nextVariant();
    runStage(VARIANTS[index], origin);
  } catch { /* a celebration is never worth an error */ }
}

function safeSettings() {
  try { return getSettings() || {}; } catch { return {}; }
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/* ------------------------------ the shuffle bag ------------------------------ */

function nextVariant() {
  const count = VARIANTS.length;
  let state = null;
  try { state = JSON.parse(localStorage.getItem(BAG_KEY) || 'null'); } catch { /* private window */ }
  let bag = Array.isArray(state?.bag) ? state.bag.filter((i) => Number.isInteger(i) && i >= 0 && i < count) : [];
  const last = Number.isInteger(state?.last) ? state.last : -1;
  if (!bag.length) {
    bag = [...Array(count).keys()];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = (Math.random() * (i + 1)) | 0;
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // A fresh bag could start with the one that just ended the old bag.
    if (bag[0] === last && bag.length > 1) [bag[0], bag[1]] = [bag[1], bag[0]];
  }
  const index = bag.shift();
  try { localStorage.setItem(BAG_KEY, JSON.stringify({ bag, last: index })); } catch { /* forgets */ }
  return index;
}

/* --------------------------------- colours --------------------------------- */

function parseColor(ctx, value) {
  if (!value) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = value;
  const out = String(ctx.fillStyle);
  if (out[0] === '#') return [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16));
  const nums = out.match(/[\d.]+/g);
  return nums && nums.length >= 3 ? nums.slice(0, 3).map(Number) : null;
}

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** A colour as CSS, optionally at partial alpha. Colours are {h, s, l} in 0..1 units. */
const css = (c, a = 1) => `hsl(${c.h.toFixed(1)} ${(c.s * 100).toFixed(1)}% ${(c.l * 100).toFixed(1)}% / ${a})`;

// Light themes lose anything near white against the paper, and dark themes lose anything
// muddy, so each appearance has its own lightness band.
const band = (dark) => (dark ? [0.5, 0.86] : [0.26, 0.6]);
function fit(c, dark, dl = 0) {
  const [lo, hi] = band(dark);
  const grey = c.s < 0.12;
  return { h: c.h, s: grey ? c.s : clamp(c.s, dark ? 0.55 : 0.5, 1), l: clamp(c.l + dl, lo, hi) };
}
const lift = (c, dark, dl) => fit(c, dark, dl);

function buildPalette(ctx, dark) {
  const style = getComputedStyle(document.body);
  const read = (name, fallback) => toHsl(parseColor(ctx, style.getPropertyValue(name).trim()) || parseColor(ctx, fallback));
  const raw = {
    accent: read('--accent', '#355DCC'),
    solid: read('--solid-bg', '#345BCC'),
    easy: read('--easy', '#2E6B4F'),
    med: read('--med', '#93650B'),
    hard: read('--hard', '#B33A1A'),
    ink: read('--ink', dark ? '#E8E8E8' : '#111111'),
  };
  const f = (c, dl = 0) => fit(c, dark, dl);
  const shades = (c) => [f(c), f(c, dark ? 0.12 : 0.1), f(c, -0.1)];
  const accents = [...shades(raw.accent), ...shades(raw.solid)];
  const warm = [...shades(raw.med), ...shades(raw.hard)];
  const cool = [...shades(raw.easy), ...shades(raw.accent)];
  const bright = [f(raw.accent, 0.16), f(raw.med, 0.16), f(raw.easy, 0.16), f(raw.hard, 0.12), f(raw.solid, 0.14)];
  // Ink is the theme's own voice: a few pieces of it read as deliberate, a lot as dirt.
  const all = [...accents, ...warm, ...shades(raw.easy), f(raw.ink)];
  return {
    dark, accents, warm, cool, bright, all,
    accent: f(raw.accent), med: f(raw.med), easy: f(raw.easy), hard: f(raw.hard), ink: f(raw.ink),
    rawAccent: raw.accent, rawMed: raw.med,
  };
}

/** One of several colour mixes from the theme, so a repeat of a variant changes hue too. */
function scheme(P) {
  return pick([
    P.all,
    P.accents.concat(P.ink),
    P.warm.concat(P.accents.slice(0, 2)),
    P.cool.concat(P.warm.slice(0, 2)),
    [P.accent, P.med, P.easy, P.hard].concat(P.bright),
  ]);
}

/* --------------------------------- sprites --------------------------------- */

// Pre-rendered once per colour: drawing a cached image is far cheaper than shadowBlur or
// a fresh gradient for every particle on every frame.
const sprites = new Map();
let blurWorks = null;

function sprite(key, size, paint) {
  let s = sprites.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = size;
  paint(s.getContext('2d'), size);
  if (sprites.size > 160) sprites.clear();
  sprites.set(key, s);
  return s;
}

function glowSprite(c) {
  return sprite(`g${css(c)}`, 64, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, css(c, 1));
    r.addColorStop(0.2, css(c, 0.5));
    r.addColorStop(0.5, css(c, 0.12));
    r.addColorStop(1, css(c, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  });
}

// A soft-focus disc with a faint rim, like an out-of-focus light.
function bokehSprite(c) {
  return sprite(`b${css(c)}`, 128, (g, n) => {
    const r = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    r.addColorStop(0, css(c, 0.42));
    r.addColorStop(0.62, css(c, 0.5));
    r.addColorStop(0.82, css(c, 0.62));
    r.addColorStop(1, css(c, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
  });
}

// A big near-camera piece of paper, blurred once into an image.
function softPieceSprite(c, shape) {
  return sprite(`s${shape}${css(c)}`, 96, (g, n) => {
    if (blurWorks === null) { g.filter = 'blur(5px)'; blurWorks = g.filter === 'blur(5px)'; }
    if (blurWorks) g.filter = 'blur(5px)';
    g.fillStyle = css(c, blurWorks ? 1 : 0.7);
    g.translate(n / 2, n / 2);
    if (shape === 'petal') { g.scale(14, 24); petalPath(g); g.fill(); }
    else if (shape === 'coin' || shape === 'dot') { g.beginPath(); g.arc(0, 0, 20, 0, TAU); g.fill(); }
    else g.fillRect(-20, -11, 40, 22);
  });
}

// An aurora ray: transparent at the top, a bright fringe at the lower edge.
function raySprite(top, edge) {
  return sprite(`r${css(top)}${css(edge)}`, 256, (g, n) => {
    const r = g.createLinearGradient(0, 0, 0, n);
    r.addColorStop(0, css(top, 0));
    r.addColorStop(0.5, css(top, 0.28));
    r.addColorStop(0.84, css(edge, 0.85));
    r.addColorStop(0.92, css(edge, 1));
    r.addColorStop(1, css(edge, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, 8, n);
  });
}

function petalPath(g) {
  g.beginPath();
  g.moveTo(0, -1);
  g.bezierCurveTo(0.95, -0.7, 0.75, 0.5, 0, 1);
  g.bezierCurveTo(-0.75, 0.5, -0.95, -0.7, 0, -1);
}

function starPath(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y - s);
  g.quadraticCurveTo(x, y, x + s * 0.62, y);
  g.quadraticCurveTo(x, y, x, y + s);
  g.quadraticCurveTo(x, y, x - s * 0.62, y);
  g.quadraticCurveTo(x, y, x, y - s);
}

/* --------------------------------- the stage -------------------------------- */

function runStage(variant, origin) {
  if (document.hidden) return;
  if (active) active.stop();

  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dark = document.body.classList.contains('is-dark');
  const w = window.innerWidth, h = window.innerHeight;
  const rect = origin && Number.isFinite(origin.left) && origin.width > 0 ? origin : null;
  const s = {
    w, h, dpr: 1, t: 0, dark,
    ox: rect ? rect.left + rect.width / 2 : w / 2,
    oy: rect ? rect.top + rect.height / 2 : h * 0.62,
    cx: w / 2, cy: h * 0.46,
    diag: Math.hypot(w, h),
    P: buildPalette(ctx, dark),
    parts: [], waiting: 0, events: [],
    settle: 2.9,          // when the peak gives way; variants move it
    dim: 1,               // how strongly the stage dims (dark) or warms (light)
    sweep: null,          // an optional band of light crossing the page
    wind: null,
    add(p) {
      if (this.parts.length + this.waiting >= MAX_PARTICLES) return null;
      p.age = 0;
      if (p.z === undefined) p.z = 0.5;
      this.parts.push(p);
      return p;
    },
    at(time, fn) { this.events.push({ time, fn }); },
    room() { return MAX_PARTICLES - this.parts.length - this.waiting; },
  };

  const size = () => {
    s.dpr = Math.min(window.devicePixelRatio || 1, 2);
    s.w = window.innerWidth; s.h = window.innerHeight;
    s.diag = Math.hypot(s.w, s.h);
    canvas.width = Math.round(s.w * s.dpr);
    canvas.height = Math.round(s.h * s.dpr);
  };
  size();
  document.body.append(canvas);

  try { variant.setup(s); } catch { canvas.remove(); return; }
  s.events.sort((a, b) => a.time - b.time);

  let frame = 0, last = performance.now(), stopped = false;
  const perf = { frames: 0, total: 0, worst: 0, variant: variant.name, peak: 0 };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', size);
    document.removeEventListener('visibilitychange', onHidden);
    canvas.remove();
    if (active === handle) active = null;
    if (isLocal) window.__studioCelebrateLast = perf;
  };
  // A hidden tab gets no frames anyway; finishing on return would replay stale fireworks.
  const onHidden = () => { if (document.hidden) stop(); };
  const handle = { stop };
  active = handle;
  window.addEventListener('resize', size);
  document.addEventListener('visibilitychange', onHidden);

  const tick = (now) => {
    try {
      if (stopped) return;
      const t0 = performance.now();
      // Clamp the step so a stalled frame never teleports everything off screen.
      const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
      last = now;
      s.t += dt;
      while (s.events.length && s.events[0].time <= s.t) s.events.shift().fn(s);
      step(s, dt);
      variant.tick?.(s, dt);
      draw(ctx, s, variant);
      const cost = performance.now() - t0;
      perf.frames += 1; perf.total += cost; perf.worst = Math.max(perf.worst, cost);
      perf.peak = Math.max(perf.peak, s.parts.length);
      if (s.t >= END) { stop(); return; }
      frame = requestAnimationFrame(tick);
    } catch { stop(); }
  };
  frame = requestAnimationFrame((now) => { last = now; tick(now); });
}

function step(s, dt) {
  // Survivors and anything born this step land on a fresh list; particles still waiting
  // their turn count toward the cap until they are judged.
  const old = s.parts;
  s.parts = [];
  for (let i = 0; i < old.length; i += 1) {
    const p = old[i];
    s.waiting = old.length - i - 1;
    p.age += dt;
    if (p.age >= p.life) { p.onDeath?.(s, p); continue; }
    (p.up || KINDS[p.kind].update)(p, dt, s);
    if (p.dead) continue;
    s.parts.push(p);
  }
  s.waiting = 0;
}

/** 0 → 1 as the peak arrives, back to 0 as the stage settles. */
const envelope = (s) => smooth(0, 0.35, s.t) * (1 - smooth(s.settle, END - 0.15, s.t));

function draw(ctx, s, variant) {
  const D = s.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(D, 0, 0, D, 0, 0);

  backdrop(ctx, s);
  const fade = s.t > END - FADE_OUT ? clamp((END - s.t) / FADE_OUT, 0, 1) : 1;
  s.fade = fade;
  if (variant.back) { ctx.globalAlpha = fade; variant.back(ctx, s); ctx.setTransform(D, 0, 0, D, 0, 0); }

  // Far to near, so close-up pieces pass in front. On a dark theme light adds up into a
  // glow; on paper additive blending would bleach to white, so it stays normal there.
  const solids = [], glows = [];
  for (const p of s.parts) {
    const glow = p.dr ? p.glow : KINDS[p.kind].glow;
    (glow ? glows : solids).push(p);
  }
  solids.sort((a, b) => a.z - b.z);
  glows.sort((a, b) => a.z - b.z);
  for (const [list, add] of [[solids, false], [glows, true]]) {
    ctx.globalCompositeOperation = add && s.dark ? 'lighter' : 'source-over';
    for (const p of list) {
      const a = clamp(p.alpha ?? 1, 0, 1) * fade;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      (p.dr || KINDS[p.kind].draw)(ctx, p, s);
    }
    ctx.setTransform(D, 0, 0, D, 0, 0);
  }
  if (variant.front) { ctx.globalAlpha = fade; variant.front(ctx, s); ctx.setTransform(D, 0, 0, D, 0, 0); }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// The full-screen moment: one gradient dims (dark) or warms (light) the page around the
// action, a bloom spreads from the button, and an optional band of light crosses it.
function backdrop(ctx, s) {
  const e = envelope(s);
  const { w, h, diag, P } = s;
  if (e > 0.002) {
    const g = ctx.createRadialGradient(s.cx, s.cy, diag * 0.05, s.cx, s.cy, diag * 0.72);
    if (s.dark) {
      const hue = P.rawAccent.h.toFixed(0);
      g.addColorStop(0, `hsl(${hue} 40% 3% / ${0.1 * e * s.dim})`);
      g.addColorStop(1, `hsl(${hue} 45% 2% / ${0.4 * e * s.dim})`);
    } else {
      const hue = P.rawMed.h.toFixed(0);
      g.addColorStop(0, `hsl(${hue} 95% 62% / ${0.07 * e * s.dim})`);
      g.addColorStop(1, `hsl(${hue} 60% 40% / ${0.17 * e * s.dim})`);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  if (s.t < 1.3) {
    const k = s.t / 1.3;
    const r = 30 + easeOut(k) * diag;
    const a = Math.pow(1 - k, 1.6) * (s.dark ? 0.34 : 0.16);
    const g = ctx.createRadialGradient(s.ox, s.oy, 0, s.ox, s.oy, r);
    const c = s.dark ? lift(P.accent, true, 0.1) : P.accent;
    g.addColorStop(0, css(c, a));
    g.addColorStop(0.45, css(c, a * 0.45));
    g.addColorStop(1, css(c, 0));
    ctx.globalCompositeOperation = s.dark ? 'lighter' : 'source-over';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  const sw = s.sweep;
  if (sw && s.t > sw.t0 && s.t < sw.t0 + sw.dur) {
    const u = (s.t - sw.t0) / sw.dur;
    const dx = Math.cos(sw.angle), dy = Math.sin(sw.angle);
    const x0 = w / 2 - dx * diag * 0.6, y0 = h / 2 - dy * diag * 0.6;
    const g = ctx.createLinearGradient(x0, y0, x0 + dx * diag * 1.2, y0 + dy * diag * 1.2);
    const c = s.dark ? lift(sw.color, true, 0.1) : sw.color;
    const a = (s.dark ? 0.16 : 0.1) * Math.sin(Math.PI * u);
    const at = (v) => clamp(v, 0, 1);
    g.addColorStop(0, css(c, 0));
    g.addColorStop(at(u - 0.12), css(c, 0));
    g.addColorStop(at(u), css(c, a));
    g.addColorStop(at(u + 0.12), css(c, 0));
    g.addColorStop(1, css(c, 0));
    ctx.globalCompositeOperation = s.dark ? 'lighter' : 'source-over';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// A ring of soft light, drawn as one radial gradient rather than a blurred stroke.
function glowRing(ctx, x, y, r, thick, c, a) {
  if (r <= 0 || a <= 0.003) return;
  const inner = Math.max(0, r - thick);
  const g = ctx.createRadialGradient(x, y, inner, x, y, r + thick);
  g.addColorStop(0, css(c, 0));
  g.addColorStop(0.5, css(c, a));
  g.addColorStop(1, css(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r + thick, 0, TAU);
  ctx.fill();
}

const lifeFade = (p, tail = 0.3) => clamp((p.life - p.age) / (p.life * tail), 0, 1);

function xform(ctx, s, x, y, rot, sx, sy) {
  const D = s.dpr, c = Math.cos(rot), n = Math.sin(rot);
  ctx.setTransform(D * c * sx, D * n * sx, -D * n * sy, D * c * sy, D * x, D * y);
}

/* ------------------------------- particle kinds ------------------------------ */

const KINDS = {
  // Paper: confetti, foil, petals and coins, tumbling about two axes.
  piece: {
    update(p, dt, s) {
      const face = Math.abs(Math.cos(p.flip));
      // A petal face-on catches the air; edge-on it slips and falls faster.
      const k = p.k * (p.flutter ? 0.45 + 1.1 * face : 1);
      const drag = Math.exp(-k * dt);
      const wind = s.wind ? s.wind(s.t) * (0.5 + p.z) : 0;
      p.vx = wind + (p.vx - wind) * drag;
      p.vy = p.vy * drag + p.g * dt;
      const sway = Math.sin(p.age * p.wf + p.phase);
      p.x += p.vx * dt + sway * p.wa * dt;
      p.y += p.vy * dt;
      p.rot = p.flutter ? p.rot0 + sway * 0.9 + p.age * p.vr * 0.3 : p.rot + p.vr * dt;
      p.flip += p.vf * dt;
      if (p.trail) {
        p.trail.unshift(p.x, p.y);
        if (p.trail.length > 24) p.trail.length = 24;
      }
      p.alpha = clamp(p.age / 0.12, 0, 1) * lifeFade(p, 0.2) * (p.soft ? 0.85 : 1);
      if (p.y > s.h + 120 || p.x < -200 || p.x > s.w + 200) p.dead = true;
    },
    draw(ctx, p, s) {
      const c = Math.cos(p.flip);
      const face = Math.max(0.1, Math.abs(c));
      if (p.soft) {
        const img = softPieceSprite(p.c, p.shape);
        if (p.shape === 'coin') xform(ctx, s, p.x, p.y, p.rot, p.size / 40 * face, p.size / 40);
        else xform(ctx, s, p.x, p.y, p.rot, p.size / 40, p.size / 40 * face);
        ctx.drawImage(img, -48, -48);
        return;
      }
      if (p.shape === 'ribbon' && p.trail && p.trail.length >= 6) {
        ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
        ctx.strokeStyle = c >= 0 ? p.color : p.back;
        ctx.lineWidth = p.size * 0.32 * (0.5 + 0.5 * Math.abs(c));
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        let run = 0;
        for (let i = 0; i < p.trail.length; i += 2) {
          if (i) run += Math.hypot(p.trail[i] - p.trail[i - 2], p.trail[i + 1] - p.trail[i - 1]);
          if (run > p.len) break;
          const wave = Math.sin(i * 0.8 + p.age * 12) * 3.2;
          const x = p.trail[i] + wave * Math.cos(p.rot), y = p.trail[i + 1] + wave * Math.sin(p.rot);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }
      if (p.shape === 'coin') {
        xform(ctx, s, p.x, p.y, p.rot * 0.2, p.size * face, p.size);
        ctx.fillStyle = c >= 0 ? p.color : p.back;
        ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
        ctx.strokeStyle = p.back; ctx.lineWidth = 0.14;
        ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, TAU); ctx.stroke();
        if (Math.abs(c) > 0.9) { ctx.fillStyle = p.shine; ctx.beginPath(); ctx.ellipse(-0.3, -0.35, 0.18, 0.4, 0.6, 0, TAU); ctx.fill(); }
        return;
      }
      if (p.shape === 'petal') {
        xform(ctx, s, p.x, p.y, p.rot, p.size * 0.62, p.size * face);
        petalPath(ctx);
        ctx.fillStyle = c >= 0 ? p.color : p.back;
        ctx.fill();
        ctx.strokeStyle = p.back; ctx.lineWidth = 0.07;
        ctx.beginPath(); ctx.moveTo(0, -0.75); ctx.quadraticCurveTo(0.12, 0, 0, 0.85); ctx.stroke();
        return;
      }
      xform(ctx, s, p.x, p.y, p.rot, 1, face);
      // Foil catches the light for an instant as it turns to face you.
      const glint = p.foil && Math.abs(c) > 0.94;
      ctx.fillStyle = glint ? p.shine : c >= 0 ? p.color : p.back;
      if (p.shape === 'dot') { ctx.beginPath(); ctx.arc(0, 0, p.size * 0.32, 0, TAU); ctx.fill(); }
      else ctx.fillRect(-p.size / 2, -p.size * 0.28, p.size, p.size * 0.56);
      if (glint) {
        ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
        ctx.fillStyle = p.shine;
        starPath(ctx, p.x, p.y, p.size * 0.9);
        ctx.fill();
      }
    },
  },

  // A spark: a streak along its own velocity, so the trail does not depend on frame rate.
  spark: {
    glow: true,
    update(p, dt) {
      const drag = Math.exp(-p.k * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      let a = Math.pow(lifeFade(p, p.tail ?? 0.6), 1.2);
      if (p.twinkle && p.age > p.life * 0.4) a *= 0.35 + 0.65 * Math.abs(Math.sin(p.age * p.twinkle + p.phase));
      p.alpha = a;
    },
    draw(ctx, p, s) {
      const len = p.streak ?? 0.04;
      ctx.strokeStyle = p.color;
      // Thin light reads on a dark sky; on paper the same spark needs more ink.
      ctx.lineWidth = s.dark ? p.size : p.size * 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * len, p.y - p.vy * len);
      ctx.lineTo(p.x + 0.01, p.y + 0.01);
      ctx.stroke();
      if (p.halo && s.dark) {
        const r = p.size * p.halo;
        ctx.globalAlpha *= 0.55;
        ctx.drawImage(glowSprite(p.c), p.x - r, p.y - r, r * 2, r * 2);
      }
    },
  },

  // Stardust and glitter: a four-pointed glint drifting on the air.
  glint: {
    glow: true,
    update(p, dt) {
      const drag = Math.exp(-p.k * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt + Math.sin(p.age * p.wf + p.phase) * p.wa * dt;
      p.y += p.vy * dt;
      const tw = 0.3 + 0.7 * Math.pow(Math.abs(Math.sin(p.age * p.tw + p.phase)), 2);
      p.alpha = clamp(p.age / 0.2, 0, 1) * lifeFade(p, 0.4) * tw;
    },
    draw(ctx, p, s) {
      if (s.dark) {
        const r = p.size * 2.6;
        ctx.drawImage(glowSprite(p.c), p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.fillStyle = p.color;
      starPath(ctx, p.x, p.y, p.size);
      ctx.fill();
    },
  },

  // A soft out-of-focus light, close to the camera.
  bokeh: {
    glow: true,
    update(p, dt) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.r += (p.grow || 0) * dt;
      p.alpha = smooth(0, p.fadeIn ?? 0.4, p.age) * lifeFade(p, 0.45) * p.peak;
    },
    draw(ctx, p) {
      ctx.drawImage(bokehSprite(p.c), p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    },
  },

  // A soft light that blooms where something bursts.
  flash: {
    glow: true,
    update(p) { p.alpha = Math.pow(1 - p.age / p.life, 2) * p.peak; },
    draw(ctx, p) {
      const r = p.r * (0.55 + 0.45 * easeOut(p.age / p.life));
      ctx.drawImage(glowSprite(p.c), p.x - r, p.y - r, r * 2, r * 2);
    },
  },
};

/* --------------------------------- emitters --------------------------------- */

// Depth: most pieces far and crisp, a handful close and soft.
function piece(s, x, y, vx, vy, colors, o = {}) {
  const z = o.z ?? Math.random();
  const soft = o.soft ?? false;
  const scale = soft ? rand(2.6, 3.8) : 0.6 + z * 0.75;
  const c = o.c || pick(colors);
  const shape = o.shape || 'rect';
  const P = s.P;
  return s.add({
    kind: 'piece', shape, x, y, vx, vy, z: soft ? 1 + z : z, soft,
    k: o.k ?? rand(1.6, 2.4), g: (o.g ?? rand(420, 620)) * (soft ? 1.5 : 0.75 + z * 0.4),
    size: (o.size ?? rand(9, 14)) * scale,
    rot: rand(0, TAU), rot0: rand(-0.6, 0.6), vr: rand(-7, 7), flip: rand(0, TAU), vf: (o.vf ?? rand(5, 12)) * (chance(0.5) ? 1 : -1),
    wf: rand(2.5, 6), wa: o.wa ?? rand(20, 60), phase: rand(0, TAU), flutter: !!o.flutter,
    life: o.life ?? rand(3.6, 4.8), foil: !!o.foil, len: o.len ?? rand(30, 60),
    c, color: css(c), back: css(fit(c, P.dark, P.dark ? -0.16 : -0.12)), shine: css(fit(c, P.dark, P.dark ? 0.3 : 0.22)),
    trail: shape === 'ribbon' ? [] : null,
  });
}

function spark(s, x, y, vx, vy, c, o = {}) {
  return s.add({
    kind: 'spark', x, y, vx, vy, c, color: css(c),
    k: o.k ?? 1.8, g: o.g ?? 140, life: o.life ?? rand(1, 1.5), size: o.size ?? rand(1.4, 2.6),
    twinkle: o.twinkle || 0, phase: rand(0, TAU), streak: o.streak, tail: o.tail, halo: o.halo, z: o.z ?? 0.5,
  });
}

function glint(s, x, y, vx, vy, c, o = {}) {
  return s.add({
    kind: 'glint', x, y, vx, vy, c, color: css(s.dark ? lift(c, true, 0.12) : c),
    k: o.k ?? 1.2, g: o.g ?? 24, life: o.life ?? rand(1.6, 2.6), size: o.size ?? rand(2.6, 5.5),
    wf: rand(1.2, 2.6), wa: o.wa ?? rand(8, 26), phase: rand(0, TAU), tw: rand(4, 10), z: o.z ?? 0.6,
  });
}

function bokeh(s, x, y, r, c, o = {}) {
  return s.add({
    kind: 'bokeh', x, y, r, c, vx: o.vx ?? rand(-12, 12), vy: o.vy ?? rand(-20, 10), grow: o.grow || 0,
    life: o.life ?? rand(2.4, 3.6), peak: o.peak ?? (s.dark ? 0.26 : 0.2), fadeIn: o.fadeIn, z: o.z ?? 2,
  });
}

function flash(s, x, y, r, c, life = 0.5, peak = 1) {
  s.add({ kind: 'flash', x, y, r, c, life, peak: s.dark ? peak : peak * 0.4, z: 0 });
}

// Big soft lights drifting close to the camera: the near half of the parallax.
function foreground(s, count, colors, o = {}) {
  for (let i = 0; i < count; i += 1) {
    s.at(rand(o.from ?? 0.1, o.to ?? 1.2), () => bokeh(s, rand(-0.05, 1.05) * s.w, rand(o.top ?? 0.05, o.bottom ?? 0.95) * s.h,
      rand(30, 85), pick(colors), { vx: rand(-25, 25), vy: o.vy ?? rand(-40, -10), life: rand(2.6, 3.8) }));
  }
}

/* --------------------------------- variants --------------------------------- */

const VARIANTS = [];

// 1. Grand finale: shells burst from the first instant and build to one huge crown.
VARIANTS.push({
  name: 'finale',
  setup(s) {
    const { w, h, P } = s;
    s.dim = 1.25;
    const colors = scheme(P).concat(P.bright);
    const shells = 7 + ((Math.random() * 4) | 0);
    // Three opening shells almost at once, a rolling middle, then the crown.
    const times = [0, 0.08, 0.2];
    const gap = rand(0.12, 0.17);
    for (let i = 3; i < shells; i += 1) times.push(0.32 + (i - 3) * gap);
    // The opening shells are mortars: short flights, so light fills the page at once.
    times.forEach((at, i) => s.at(at, () => launch(s, w * rand(0.08, 0.92), h * rand(0.12, 0.5), pick(['peony', 'ring', 'willow', 'chrys', 'palm']), pick(colors), i < 3 ? rand(0.16, 0.24) : rand(0.3, 0.45))));
    const crownAt = Math.min(times[times.length - 1] + rand(0.25, 0.35), 1.7);
    s.at(crownAt, () => launch(s, w * rand(0.4, 0.6), h * rand(0.28, 0.36), 'crown', pick(P.bright), 0.4));
    s.settle = crownAt + 1.3;
    foreground(s, 4, P.bright, { from: 0.3, to: 1.8, vy: rand(-10, 10) });
  },
});

function launch(s, x, y, style, c, flight) {
  const x0 = x + rand(-60, 60), y0 = s.h + 10;
  const g = (2 * (y0 - y)) / (flight * flight);
  s.add({
    up(p, dt, sc) {
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.emit += dt;
      while (p.emit > 0.008) {
        p.emit -= 0.008;
        spark(sc, p.x + rand(-1, 1), p.y, rand(-25, 25), rand(20, 80), sc.P.med, { k: 3, g: 150, life: rand(0.25, 0.5), size: rand(1, 1.8), streak: 0.02 });
      }
      if (p.vy >= -5) { p.dead = true; burst(sc, p.x, p.y, style, c); }
    },
    dr(ctx, p) {
      ctx.strokeStyle = css(c); ctx.lineWidth = 2.8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02); ctx.lineTo(p.x, p.y); ctx.stroke();
    },
    glow: true, x: x0, y: y0, vx: (x - x0) / flight, vy: -g * flight, g, emit: 0, life: flight + 0.3,
  });
}

function burst(s, x, y, style, c) {
  const P = s.P, m = Math.min(s.w, s.h);
  const other = pick(P.bright.filter((b) => b !== c)) || c;
  const big = style === 'crown';
  flash(s, x, y, big ? s.diag * 0.55 : m * 0.45, c, big ? 0.9 : 0.55, big ? 0.9 : 0.6);
  const R = (big ? 0.46 : rand(0.2, 0.3)) * m;
  const k = 2.1;
  const ring = (n, speed, col, o = {}) => {
    const tilt = rand(0, TAU), squash = o.squash ?? 1;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * TAU;
      let vx = Math.cos(a) * speed, vy = Math.sin(a) * speed * squash;
      if (squash !== 1) [vx, vy] = [vx * Math.cos(tilt) - vy * Math.sin(tilt), vx * Math.sin(tilt) + vy * Math.cos(tilt)];
      spark(s, x, y, vx * rand(0.97, 1.03), vy * rand(0.97, 1.03), col, { k, g: o.g ?? 110, life: o.life ?? rand(1.2, 1.6), twinkle: o.twinkle ?? 18, halo: 4, size: o.size });
    }
  };
  const ball = (n, speed, cols, o = {}) => {
    for (let i = 0; i < n; i += 1) {
      const a = rand(0, TAU), v = speed * Math.sqrt(rand(0.15, 1));
      spark(s, x, y, Math.cos(a) * v, Math.sin(a) * v, pick(cols), { k: o.k ?? k, g: o.g ?? 130, life: o.life ?? rand(1.1, 1.6), twinkle: o.twinkle ?? 0, streak: o.streak, tail: o.tail, halo: 4, size: o.size });
    }
  };
  if (style === 'ring') { ring(56, R * k, c, { squash: rand(0.4, 1) }); ball(16, R * k * 0.35, [other]); }
  else if (style === 'willow') ball(80, R * k * 0.9, [P.med, lift(P.med, s.dark, 0.1), other], { k: 1.5, g: 170, life: rand(1.8, 2.3), streak: 0.1, tail: 0.85, size: 1.6, twinkle: 24 });
  else if (style === 'chrys') { ball(70, R * k, [c, c, other], { twinkle: 30 }); s.at(s.t + 0.75, () => crackle(s, x, y, R * 0.8, other)); }
  else if (style === 'palm') {
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * TAU + rand(-0.1, 0.1);
      spark(s, x, y, Math.cos(a) * R * 1.8, Math.sin(a) * R * 1.8, c, { k: 1.6, g: 260, life: 1.6, size: 4, streak: 0.12, halo: 5 });
    }
    ball(30, R * k * 0.5, [other]);
  } else if (big) {
    ring(90, R * k, c, { life: rand(1.8, 2.2), size: 2.4 });
    ring(64, R * k * 0.68, other, { life: rand(1.7, 2.1) });
    ball(70, R * k * 0.5, P.bright, { life: rand(1.6, 2.2), twinkle: 26 });
    s.at(s.t + 0.9, () => crackle(s, x, y, R, P.med));
  } else ball(90, R * k, [c, c, other], { twinkle: 16 });
}

// The glittering crackle after a chrysanthemum: brief strobes scattered over the sphere.
function crackle(s, x, y, r, c) {
  const n = Math.min(60, s.room());
  for (let i = 0; i < n; i += 1) {
    const a = rand(0, TAU), d = r * Math.sqrt(Math.random());
    glint(s, x + Math.cos(a) * d, y + Math.sin(a) * d + 30, rand(-10, 10), rand(10, 40), c, { life: rand(0.5, 1.2), size: rand(2, 4), g: 60 });
  }
}

// 2. Aurora: curtains of light sweep across the top of the page and shed stardust.
VARIANTS.push({
  name: 'aurora',
  setup(s) {
    const { w, h, P } = s;
    s.dim = 1.5;
    s.settle = rand(3.1, 3.4);
    const fromLeft = chance(0.5);
    const pairs = [[P.accent, P.easy], [P.easy, P.accent], [P.med, P.hard], [P.accent, P.med], [P.hard, P.accent]];
    const count = 2 + ((Math.random() * 2) | 0);
    s.curtains = [...Array(count)].map((_, i) => {
      const [top, edge] = pick(pairs);
      return {
        top: lift(top, s.dark, s.dark ? 0.06 : 0), edge: lift(edge, s.dark, s.dark ? 0.14 : 0),
        base: h * (0.2 + i * 0.1 + rand(-0.03, 0.05)), height: h * rand(0.18, 0.3),
        k1: rand(1.6, 3.2) / w * TAU / 2, k2: rand(5, 9) / w * TAU / 2, amp: h * rand(0.04, 0.08), speed: rand(0.6, 1.2) * (chance(0.5) ? 1 : -1),
        delay: i * 0.18, phase: rand(0, TAU),
      };
    });
    s.fromLeft = fromLeft;
    s.sweep = { t0: 0.05, dur: 1.4, angle: fromLeft ? 0.2 : Math.PI - 0.2, color: P.accent };
    // Stardust falls from the lower fringe once each curtain has unrolled past it.
    for (let i = 0; i < 230; i += 1) {
      const at = rand(0.3, 2.9);
      s.at(at, () => {
        const cur = pick(s.curtains);
        const x = rand(0, w);
        if (!revealed(s, cur, x)) return;
        const y = curtainY(s, cur, x);
        glint(s, x, y + rand(-10, 10), rand(-10, 10), rand(30, 80), chance(0.6) ? cur.edge : cur.top, { life: rand(1.6, 2.4), g: 30, size: rand(2, 4.6) });
      });
    }
    if (s.dark) {
      for (let i = 0; i < 70; i += 1) s.at(rand(0, 0.8), () => glint(s, rand(0, w), rand(0, h * 0.55), 0, 0, P.ink, { life: rand(3.2, 4.4), size: rand(1, 2), g: 0, wa: 0, z: 0 }));
    }
    foreground(s, 7, [P.accent, P.easy, P.med], { top: 0.1, bottom: 0.7, from: 0.5, to: 1.8 });
  },
  back(ctx, s) {
    const e = smooth(0.05, 0.6, s.t) * (1 - smooth(s.settle - 0.2, END - 0.3, s.t));
    if (e <= 0.003) return;
    ctx.globalCompositeOperation = s.dark ? 'lighter' : 'source-over';
    const step = 7;
    for (const cur of s.curtains) {
      const img = raySprite(cur.top, cur.edge);
      for (let x = -step; x < s.w + step; x += step) {
        const reveal = revealed(s, cur, x);
        if (!reveal) continue;
        const y = curtainY(s, cur, x);
        // Rays shimmer: fine fast ripples on top of a slow swell along the curtain.
        const t = s.t;
        const shimmer = 0.55 + 0.25 * Math.sin(x * 0.045 + t * 5 + cur.phase) + 0.2 * Math.sin(x * 0.013 - t * 2.2);
        const len = cur.height * (0.6 + 0.4 * Math.sin(x * 0.006 + t * 0.8 + cur.phase));
        ctx.globalAlpha = clamp(e * shimmer * reveal * (s.dark ? 0.75 : 0.4), 0, 1) * s.fade;
        ctx.drawImage(img, 0, 0, 8, 256, x, y - len, step + 1, len * 1.1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  },
});

function curtainY(s, cur, x) {
  const t = s.t;
  return cur.base + Math.sin(x * cur.k1 + t * cur.speed + cur.phase) * cur.amp + Math.sin(x * cur.k2 - t * cur.speed * 1.7) * cur.amp * 0.35;
}

/** How unrolled the curtain is at x: 0 before the sweep reaches it, 1 well after. */
function revealed(s, cur, x) {
  const front = (s.t - cur.delay) / 1.3 * (s.w + 300) - 150;
  const d = s.fromLeft ? front - x : front - (s.w - x);
  return clamp(d / 220, 0, 1);
}

// 3. Confetti storm: the whole sky fills with paper, foil and ribbons.
VARIANTS.push({
  name: 'storm',
  setup(s) {
    const { w, P } = s;
    const colors = scheme(P);
    const windDir = chance(0.5) ? 1 : -1;
    const wind = rand(30, 120) * windDir;
    s.wind = (t) => wind + Math.sin(t * 1.3) * 50 * windDir;
    s.sweep = { t0: 0.15, dur: 1.2, angle: windDir > 0 ? 0.35 : Math.PI - 0.35, color: P.med };
    s.settle = 3.0;
    // An opening pop from the button, then the sky opens.
    for (let i = 0; i < 70; i += 1) {
      const a = -Math.PI / 2 + rand(-0.9, 0.9), v = rand(700, 1700);
      piece(s, s.ox, s.oy, Math.cos(a) * v, Math.sin(a) * v, colors, { k: rand(2.6, 3.2), shape: chance(0.2) ? 'ribbon' : 'rect', foil: chance(0.3) });
    }
    const total = (rand(330, 400)) | 0;
    for (let i = 0; i < total; i += 1) {
      s.at(rand(0.05, 1.5) * (0.6 + 0.4 * Math.random()), () => {
        const shape = chance(0.14) ? 'ribbon' : chance(0.12) ? 'dot' : 'rect';
        piece(s, rand(-0.1, 1.1) * w, rand(-120, -20), rand(-60, 60), rand(150, 500), colors, { shape, foil: chance(0.35), life: rand(3.6, 4.9), len: rand(40, 80) });
      });
    }
    for (let i = 0; i < 18; i += 1) {
      s.at(rand(0.2, 1.6), () => piece(s, rand(0, w), -80, rand(-40, 40), rand(250, 450), colors, { soft: true, shape: chance(0.3) ? 'dot' : 'rect', life: 4 }));
    }
  },
});

// 4. Warp: stars rush out of the button, then gather into a constellation.
VARIANTS.push({
  name: 'warp',
  setup(s) {
    const { w, h, P } = s;
    s.dim = 1.6;
    s.settle = 3.4;
    const vx = s.ox + (s.cx - s.ox) * 0.55, vy = s.oy + (s.cy - s.oy) * 0.55;
    const starCols = [P.accent, P.easy, P.med, P.ink].map((c) => lift(c, s.dark, s.dark ? 0.12 : 0));
    for (let i = 0; i < 260; i += 1) s.at(rand(0, 0.9), () => warpStar(s, vx, vy, pick(starCols)));
    const S = Math.min(w, h) * rand(0.5, 0.62);
    const shape = pick(['check', 'check', 'ring', 'checkring', 'star']);
    const lines = constellation(shape, s.cx, s.cy - h * 0.02, S);
    s.lines = lines;
    s.nodes = [];
    s.lineColor = s.dark ? lift(P.accent, true, 0.1) : P.accent;
    let order = 0;
    for (const line of lines) {
      line.nodes = line.points.map((pt) => {
        const node = { ...pt, arrive: 1.0 + order * 0.035, on: 0 };
        order += 1;
        s.nodes.push(node);
        s.at(node.arrive - 0.6, () => flyToNode(s, vx, vy, node, pick(starCols)));
        return node;
      });
    }
    s.pulseAt = 1.0 + order * 0.035 + 0.25;
    // The far layer: a quiet field of fixed stars across the whole page.
    for (let i = 0; i < 80; i += 1) s.at(rand(0.6, 1.4), () => glint(s, rand(0, w), rand(0, h), 0, 0, pick(starCols), { life: rand(2.8, 3.8), size: rand(1, 2.2), g: 0, wa: 0, z: 0 }));
    foreground(s, 5, starCols, { from: 1.0, to: 2.0, vy: rand(-8, 8) });
  },
  front(ctx, s) {
    const fadeLines = 1 - smooth(3.1, 3.8, s.t);
    if (fadeLines <= 0 || !s.lines) return;
    ctx.globalCompositeOperation = s.dark ? 'lighter' : 'source-over';
    ctx.strokeStyle = css(s.lineColor);
    ctx.lineCap = 'round';
    for (const line of s.lines) {
      const ns = line.nodes;
      for (let i = 1; i < ns.length + (line.closed ? 1 : 0); i += 1) {
        const a = ns[i - 1], b = ns[i % ns.length];
        const on = Math.min(a.on, b.on);
        if (on <= 0) continue;
        // Each segment draws itself from a toward b as b arrives.
        const k = easeOut(on);
        ctx.globalAlpha = (s.dark ? 0.55 : 0.6) * fadeLines * s.fade;
        ctx.lineWidth = s.dark ? 1.6 : 1.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k); ctx.stroke();
      }
    }
    // A pulse of light runs along the figure once it is complete.
    const u = (s.t - s.pulseAt) / 0.9;
    if (u > 0 && u < 1 && s.dark) {
      const all = s.nodes;
      const i = Math.min(all.length - 1, Math.floor(u * all.length));
      const n = all[i];
      const r = 60;
      ctx.globalAlpha = Math.sin(Math.PI * u) * s.fade;
      ctx.drawImage(glowSprite(s.lineColor), n.x - r, n.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  },
  tick(s, dt) {
    for (const n of s.nodes || []) if (s.t >= n.arrive) n.on = Math.min(1, n.on + dt / 0.25);
  },
});

function warpStar(s, vx, vy, c) {
  s.add({
    up(p, dt, sc) {
      p.zz *= Math.exp(-p.speed * dt);
      const r = (p.rho * 0.16) / p.zz;
      p.x = vx + Math.cos(p.a) * r; p.y = vy + Math.sin(p.a) * r;
      p.r = r;
      if (r > sc.diag || p.zz < 0.03) {
        if (sc.t < 0.95) { p.zz = rand(0.7, 1.1); p.rho = rand(20, 420); p.a = rand(0, TAU); }
        else p.dead = true;
      }
      p.alpha = clamp((1 - p.zz) * 1.6, 0, 1) * (1 - smooth(1.0, 1.4, sc.t));
    },
    dr(ctx, p) {
      const back = (p.rho * 0.16) / (p.zz * Math.exp(p.speed * 0.06));
      ctx.strokeStyle = p.color;
      ctx.lineWidth = clamp(0.6 / p.zz, 0.6, 3.4);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(vx + Math.cos(p.a) * back, vy + Math.sin(p.a) * back);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    },
    glow: true, x: vx, y: vy, a: rand(0, TAU), rho: rand(20, 420), zz: rand(0.5, 1.1), speed: rand(2.6, 3.6),
    color: css(c), life: 1.6, z: 0.3,
  });
}

function constellation(shape, cx, cy, S) {
  const sample = (pts, closed, spacing) => {
    const out = [];
    const segs = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i += 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
      for (let j = 0; j < n; j += 1) out.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n });
    }
    if (!closed) out.push(pts[pts.length - 1]);
    // A little hand-placed wobble, so it reads as stars rather than a vector drawing.
    return out.map((p) => ({ x: p.x + rand(-4, 4), y: p.y + rand(-4, 4) }));
  };
  const at = (x, y) => ({ x: cx + x * S, y: cy + y * S });
  const check = (k = 1) => ({ points: sample([at(-0.36 * k, 0.02 * k), at(-0.1 * k, 0.28 * k), at(0.4 * k, -0.28 * k)], false, S * 0.075), closed: false });
  const ring = (r) => ({ points: sample([...Array(28)].map((_, i) => at(Math.cos((i / 28) * TAU) * r, Math.sin((i / 28) * TAU) * r)), true, S * 0.09), closed: true });
  if (shape === 'ring') return [ring(0.42)];
  if (shape === 'checkring') return [ring(0.46), check(0.75)];
  if (shape === 'star') {
    const pts = [...Array(10)].map((_, i) => { const a = -Math.PI / 2 + (i / 10) * TAU, r = i % 2 ? 0.19 : 0.46; return at(Math.cos(a) * r, Math.sin(a) * r); });
    return [{ points: sample(pts, true, S * 0.08), closed: true }];
  }
  return [check()];
}

function flyToNode(s, vx, vy, node, c) {
  const mx = (vx + node.x) / 2 + rand(-1, 1) * 160, my = (vy + node.y) / 2 + rand(-1, 1) * 160;
  s.add({
    up(p, dt, sc) {
      const u = easeOut(p.age / 0.6);
      const px = p.x, py = p.y;
      p.x = (1 - u) * (1 - u) * vx + 2 * (1 - u) * u * mx + u * u * node.x;
      p.y = (1 - u) * (1 - u) * vy + 2 * (1 - u) * u * my + u * u * node.y;
      p.dx = p.x - px; p.dy = p.y - py;
      if (p.age > 0.6) { p.x = node.x + Math.sin(sc.t * 1.3 + p.ph) * 2; p.y = node.y + Math.cos(sc.t * 1.1 + p.ph) * 2; p.dx = p.dy = 0; }
      const tw = 0.75 + 0.25 * Math.sin(sc.t * 7 + p.ph);
      p.alpha = smooth(0, 0.15, p.age) * tw * (1 - smooth(3.3, 3.7, sc.t));
      if (sc.t > 3.4 && !p.shed) {
        p.shed = true;
        for (let i = 0; i < 3; i += 1) glint(sc, p.x, p.y, rand(-30, 30), rand(-20, 30), c, { life: rand(1.2, 1.7), g: 40, size: rand(2.4, 4.2) });
      }
    },
    dr(ctx, p, sc) {
      const r = sc.dark ? 16 : 0;
      if (r) ctx.drawImage(glowSprite(c), p.x - r, p.y - r, r * 2, r * 2);
      if (p.dx || p.dy) {
        ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x - p.dx * 4, p.y - p.dy * 4); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      ctx.fillStyle = p.color;
      starPath(ctx, p.x, p.y, sc.dark ? 6 : 7);
      ctx.fill();
    },
    glow: true, x: vx, y: vy, dx: 0, dy: 0, ph: rand(0, TAU), color: css(c), life: 3.9 - (node.arrive - 0.6), z: 0.8,
  });
}

// 5. Halo: a spark leaves the button and opens a ring of light over the page, with comets
// riding it, until it breaks outward past the edges of the screen.
VARIANTS.push({
  name: 'halo',
  setup(s) {
    const { P } = s;
    s.dim = 1.4;
    const R = Math.min(s.w, s.h) * rand(0.27, 0.34);
    const dir = chance(0.5) ? 1 : -1;
    const ring = pick([P.accent, P.med, P.easy]);
    const second = pick([P.accent, P.med, P.easy, P.hard].filter((c) => c !== ring));
    const release = rand(2.5, 2.8);
    Object.assign(s, { haloR: R, haloDir: dir, haloC: ring, halo2: second, release, settle: release + 0.2 });
    // The igniting spark.
    s.add({
      up(p, dt, sc) {
        const u = easeOut(p.age / 0.45);
        const mx = (sc.ox + sc.cx) / 2, my = Math.min(sc.oy, sc.cy) - 160;
        p.x = (1 - u) * (1 - u) * sc.ox + 2 * (1 - u) * u * mx + u * u * sc.cx;
        p.y = (1 - u) * (1 - u) * sc.oy + 2 * (1 - u) * u * my + u * u * sc.cy;
        spark(sc, p.x, p.y, rand(-40, 40), rand(-40, 40), ring, { k: 3, g: 0, life: rand(0.3, 0.6), size: 2.2, halo: 4 });
        if (p.age > 0.45) p.dead = true;
      },
      dr() {}, glow: true, x: s.ox, y: s.oy, life: 0.5,
    });
    s.at(0.45, () => flash(s, s.cx, s.cy, s.diag * 0.5, ring, 0.8, 0.8));
    const comets = (rand(46, 64)) | 0;
    for (let i = 0; i < comets; i += 1) {
      s.at(rand(0.55, 1.0), () => {
        const c = chance(0.6) ? ring : second;
        s.add({
          up(p, dt, sc) {
            const open = backOut((sc.t - 0.45) / 0.65);
            if (sc.t < sc.release) {
              p.th += p.om * dt;
              const r = sc.haloR * open * p.off;
              p.x = sc.cx + Math.cos(p.th) * r; p.y = sc.cy + Math.sin(p.th) * r;
              p.alpha = smooth(0, 0.25, p.age);
            } else {
              if (!p.free) {
                // Let go: fly off along the tangent, a little outward.
                p.free = true;
                const r = sc.haloR * p.off;
                p.vx = -Math.sin(p.th) * p.om * r + Math.cos(p.th) * 260;
                p.vy = Math.cos(p.th) * p.om * r + Math.sin(p.th) * 260;
              }
              const drag = Math.exp(-1.6 * dt);
              p.vx *= drag; p.vy = p.vy * drag + 60 * dt;
              p.x += p.vx * dt; p.y += p.vy * dt;
              p.alpha = 1 - smooth(sc.release, sc.release + 1.6, sc.t);
            }
          },
          dr(ctx, p, sc) {
            ctx.strokeStyle = p.color; ctx.lineCap = 'round'; ctx.lineWidth = p.size;
            ctx.beginPath();
            if (!p.free) {
              const r = sc.haloR * backOut((sc.t - 0.45) / 0.65) * p.off;
              ctx.arc(sc.cx, sc.cy, Math.max(1, r), p.th - p.om * 0.14, p.th, p.om < 0);
            } else { ctx.moveTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05); ctx.lineTo(p.x, p.y); }
            ctx.stroke();
            if (sc.dark) { const q = p.size * 6; ctx.drawImage(glowSprite(p.c), p.x - q, p.y - q, q * 2, q * 2); }
          },
          glow: true, x: s.cx, y: s.cy, th: rand(0, TAU), om: dir * rand(1.8, 3.4) * (chance(0.15) ? -1 : 1), off: rand(0.9, 1.1),
          size: rand(1.6, 3.4), c, color: css(c), life: 4.4, z: 0.7,
        });
      });
    }
    s.at(release, () => {
      flash(s, s.cx, s.cy, s.diag * 0.6, ring, 0.7, 0.5);
      for (let i = 0; i < 150; i += 1) {
        const a = rand(0, TAU), r = R * rand(0.9, 1.15);
        glint(s, s.cx + Math.cos(a) * r, s.cy + Math.sin(a) * r, Math.cos(a) * rand(20, 90), Math.sin(a) * rand(20, 90), pick([ring, second, P.med]), { life: rand(1.6, 2.4), g: 40 });
      }
    });
    foreground(s, 6, [ring, second], { from: 0.5, to: 1.5, vy: rand(-12, 12) });
  },
  back(ctx, s) {
    if (s.t < 0.45) return;
    const open = backOut((s.t - 0.45) / 0.65);
    const out = easeIn((s.t - s.release) / 0.9);
    const R = s.haloR * open + (s.diag - s.haloR) * out;
    const a = (1 - smooth(s.release, s.release + 0.9, s.t)) * s.fade;
    const D = s.dark;
    ctx.globalCompositeOperation = D ? 'lighter' : 'source-over';
    ctx.globalAlpha = 1;
    // The portal's interior: a faint lens of light.
    const inner = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, Math.max(1, R));
    inner.addColorStop(0, css(s.haloC, 0));
    inner.addColorStop(0.75, css(s.haloC, (D ? 0.05 : 0.04) * a));
    inner.addColorStop(1, css(s.haloC, (D ? 0.16 : 0.08) * a));
    ctx.fillStyle = inner;
    ctx.beginPath(); ctx.arc(s.cx, s.cy, Math.max(1, R), 0, TAU); ctx.fill();
    glowRing(ctx, s.cx, s.cy, R, 26 + 60 * out, s.haloC, (D ? 0.55 : 0.28) * a);
    ctx.globalAlpha = a;
    ctx.strokeStyle = css(D ? lift(s.haloC, true, 0.2) : s.haloC);
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(s.cx, s.cy, Math.max(1, R), 0, TAU); ctx.stroke();
    // Two etched rings turning against each other, like a dial.
    ctx.save();
    ctx.translate(s.cx, s.cy);
    ctx.strokeStyle = css(s.halo2);
    ctx.globalAlpha = a * 0.75;
    ctx.lineWidth = 1.6;
    ctx.rotate(s.t * 0.5 * s.haloDir);
    ctx.setLineDash([3, 12]);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1, R * 0.86), 0, TAU); ctx.stroke();
    ctx.rotate(-s.t * 1.0 * s.haloDir);
    ctx.setLineDash([18, 26]);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1, R * 1.12), 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';
  },
});

// 6. Petals or coins: theme-coloured petals (or spinning coins) flutter down the page.
VARIANTS.push({
  name: 'petals',
  setup(s) {
    const { w, P } = s;
    const mode = pick(['petals', 'petals', 'coins', 'mixed']);
    const colors = mode === 'coins' ? [P.med, lift(P.med, s.dark, 0.08), P.hard] : scheme(P).filter((c) => c !== P.ink);
    const coinCols = [P.med, lift(P.med, s.dark, 0.08)];
    const windDir = chance(0.5) ? 1 : -1;
    const wind = rand(20, 90) * windDir;
    // A gust arrives about a second in and eases off.
    s.wind = (t) => wind + Math.exp(-((t - 1.2) ** 2) / 0.4) * 160 * windDir;
    s.sweep = { t0: 0.6, dur: 1.4, angle: windDir > 0 ? 0.5 : Math.PI - 0.5, color: P.med };
    s.settle = 3.1;
    const shapeFor = () => (mode === 'coins' ? 'coin' : mode === 'mixed' && chance(0.35) ? 'coin' : 'petal');
    const opts = (shape) => (shape === 'coin'
      ? { shape, k: rand(1.2, 1.6), g: rand(380, 520), vf: rand(6, 11), wa: rand(10, 30), size: rand(7, 10), c: pick(coinCols) }
      : { shape, flutter: true, k: rand(2.4, 3.2), g: rand(260, 360), vf: rand(2.5, 5), wa: rand(40, 90), size: rand(8, 12) });
    // The first handful burst up from the button like a flower opening.
    for (let i = 0; i < 46; i += 1) {
      const a = -Math.PI / 2 + rand(-1.2, 1.2), v = rand(500, 1300);
      const shape = shapeFor();
      piece(s, s.ox, s.oy, Math.cos(a) * v, Math.sin(a) * v, colors, { ...opts(shape), k: rand(2.8, 3.4), life: rand(3.8, 4.8) });
    }
    const total = (rand(240, 300)) | 0;
    for (let i = 0; i < total; i += 1) {
      s.at(rand(0, 1.9), () => {
        const shape = shapeFor();
        piece(s, rand(-0.15, 1.1) * w, rand(-100, -20), rand(-30, 30), rand(80, 220), colors, { ...opts(shape), life: rand(3.6, 4.9) });
      });
    }
    for (let i = 0; i < 14; i += 1) {
      s.at(rand(0.3, 1.8), () => {
        const shape = shapeFor();
        piece(s, rand(0, w), -90, rand(-30, 30), rand(160, 300), colors, { ...opts(shape), soft: true, life: 4 });
      });
    }
  },
});

// 7. Supernova: light falls into a core, it collapses, then a shell of colour bands tears
// outward across the page, leaving a nebula and a turning pulsar.
VARIANTS.push({
  name: 'supernova',
  setup(s) {
    const { w, h, P } = s;
    s.dim = 1.7;
    s.settle = 3.2;
    const BOOM = 0.85;
    s.boom = BOOM;
    s.bands = [P.hard, P.med, P.accent, P.easy].sort(() => Math.random() - 0.5).slice(0, 3 + (chance(0.5) ? 1 : 0))
      .map((c, i) => ({ c: lift(c, s.dark, s.dark ? 0.1 : 0), reach: s.diag * rand(0.55, 1.05) * (1 - i * 0.12), dur: rand(1.4, 2.0) + i * 0.15, thick: rand(30, 70) }));
    s.coreC = lift(P.med, s.dark, s.dark ? 0.2 : 0);
    s.beamDir = chance(0.5) ? 1 : -1;
    for (let i = 0; i < 150; i += 1) {
      const t0 = rand(0, 0.25);
      s.at(t0, () => infall(s, rand(0, w), rand(0, h), BOOM - t0 - 0.05, pick(P.bright)));
    }
    s.at(BOOM, () => {
      flash(s, s.cx, s.cy, s.diag * 0.8, s.coreC, 0.8, 0.75);
      for (let i = 0; i < 220; i += 1) {
        const a = rand(0, TAU), v = rand(250, 1500);
        spark(s, s.cx, s.cy, Math.cos(a) * v, Math.sin(a) * v, pick(P.bright.concat(s.bands.map((b) => b.c))), { k: rand(1.2, 1.8), g: 40, life: rand(1.3, 2.6), size: rand(1.4, 3.2), streak: 0.05, halo: chance(0.3) ? 4 : 0, twinkle: chance(0.3) ? 20 : 0 });
      }
      // The remnant: faint clouds drifting apart, never bright enough to hide the page.
      for (let i = 0; i < 10; i += 1) {
        const a = rand(0, TAU), d = rand(60, 200);
        bokeh(s, s.cx + Math.cos(a) * d, s.cy + Math.sin(a) * d, rand(80, 170), pick(s.bands).c, { vx: Math.cos(a) * rand(20, 50), vy: Math.sin(a) * rand(20, 50), grow: 25, life: rand(3.0, 3.8), peak: s.dark ? 0.09 : 0.1, fadeIn: 0.8, z: 0.1 });
      }
    });
  },
  back(ctx, s) {
    const D = s.dark, B = s.boom;
    ctx.globalCompositeOperation = D ? 'lighter' : 'source-over';
    // The core swells as light falls in, then collapses to a point just before the blast.
    let r;
    if (s.t < B - 0.12) r = 10 + 40 * easeIn(s.t / (B - 0.12)) + Math.sin(s.t * 30) * 3;
    else if (s.t < B) r = 50 * (1 - (s.t - (B - 0.12)) / 0.12) + 6;
    else r = 34 + Math.sin(s.t * 9) * 6;
    const coreA = s.t < B ? 1 : 1 - smooth(3.2, END - 0.4, s.t);
    ctx.globalAlpha = coreA * s.fade;
    const q = r * 3;
    ctx.drawImage(glowSprite(s.coreC), s.cx - q, s.cy - q, q * 2, q * 2);
    if (s.t < B) return;
    // The shell: bands of colour racing outward at different speeds.
    for (const b of s.bands) {
      const u = (s.t - B) / b.dur;
      if (u >= 1) continue;
      const R = b.reach * easeOut(u);
      glowRing(ctx, s.cx, s.cy, R, b.thick * (0.6 + u * 1.4), b.c, (D ? 0.5 : 0.42) * Math.pow(1 - u, 1.2) * s.fade);
    }
    // The pulsar's twin beams sweeping round.
    const beamA = smooth(B + 0.3, B + 0.8, s.t) * (1 - smooth(3.4, END - 0.3, s.t)) * s.fade;
    if (beamA > 0) {
      const ang = (s.t - B) * 1.6 * s.beamDir;
      for (const k of [0, Math.PI]) {
        const a = ang + k;
        const ex = s.cx + Math.cos(a) * s.diag * 0.55, ey = s.cy + Math.sin(a) * s.diag * 0.55;
        const g = ctx.createLinearGradient(s.cx, s.cy, ex, ey);
        g.addColorStop(0, css(s.coreC, (D ? 0.5 : 0.35) * beamA));
        g.addColorStop(1, css(s.coreC, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = 7;
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.moveTo(s.cx, s.cy); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  },
});

function infall(s, x0, y0, dur, c) {
  const swirl = rand(0.6, 1.4) * (chance(0.5) ? 1 : -1);
  s.add({
    up(p, dt, sc) {
      const u = easeIn(p.age / dur);
      const dx = x0 - sc.cx, dy = y0 - sc.cy;
      const a = swirl * u, k = 1 - u;
      const px = p.x, py = p.y;
      p.x = sc.cx + (dx * Math.cos(a) - dy * Math.sin(a)) * k;
      p.y = sc.cy + (dx * Math.sin(a) + dy * Math.cos(a)) * k;
      p.dx = p.x - px; p.dy = p.y - py;
      p.alpha = smooth(0, 0.2, p.age);
      if (p.age >= dur) p.dead = true;
    },
    dr(ctx, p) {
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x - p.dx * 5, p.y - p.dy * 5); ctx.lineTo(p.x, p.y); ctx.stroke();
    },
    glow: true, x: x0, y: y0, dx: 0, dy: 0, color: css(c), life: dur + 0.1, z: 0.4,
  });
}

// 8. Deep-sea bubbles: luminous bubbles rise from the bottom of the page and pop in chains.
VARIANTS.push({
  name: 'bubbles',
  setup(s) {
    const { w, h, P } = s;
    s.dim = 1.3;
    s.settle = 3.2;
    const colors = pick([[P.accent, P.easy], [P.easy, P.med], [P.accent, P.hard, P.med], P.bright]);
    s.deepC = colors[0];
    const count = (rand(64, 84)) | 0;
    for (let i = 0; i < count; i += 1) {
      const near = i < 8;
      s.at(rand(0, 1.5), () => bubble(s, rand(0.02, 0.98) * w, h + 40 - (i % 3 === 0 ? rand(0, h * 0.35) : 0), pick(colors), near));
    }
    // Plankton: tiny lights rising slowly through the whole page.
    for (let i = 0; i < 90; i += 1) s.at(rand(0, 1.2), () => glint(s, rand(0, w), rand(0.3, 1.05) * h, rand(-8, 8), rand(-50, -15), pick(colors), { life: rand(3.0, 4.2), size: rand(1.4, 2.8), g: 0, z: 0.1 }));
  },
  back(ctx, s) {
    // Light welling up from the deep along the bottom edge.
    const e = envelope(s) * s.fade;
    if (e <= 0.003) return;
    const g = ctx.createLinearGradient(0, s.h, 0, s.h * 0.45);
    g.addColorStop(0, css(s.deepC, (s.dark ? 0.3 : 0.12) * e));
    g.addColorStop(1, css(s.deepC, 0));
    ctx.globalCompositeOperation = s.dark ? 'lighter' : 'source-over';
    ctx.fillStyle = g;
    ctx.fillRect(0, s.h * 0.45, s.w, s.h * 0.55);
    ctx.globalCompositeOperation = 'source-over';
  },
});

function bubble(s, x, y, c, near) {
  const z = near ? 1.5 : Math.random();
  const r = near ? rand(34, 60) : 6 + z * 18;
  const b = s.add({
    up(p, dt, sc) {
      p.vy += -p.buoy * dt; p.vy *= Math.exp(-0.5 * dt);
      p.x += Math.sin(p.age * p.wf + p.ph) * p.wa * dt;
      p.y += p.vy * dt;
      p.alpha = smooth(0, 0.3, p.age) * (sc.t > 4.2 ? 1 - smooth(4.2, END - 0.2, sc.t) : 1);
      if (!near && (p.age > p.pop || p.y < p.popY)) { p.dead = true; pop(sc, p); }
      if (p.y < -p.r * 2) p.dead = true;
    },
    dr(ctx, p, sc) {
      const sq = 1 + Math.sin(p.age * 6 + p.ph) * 0.05;
      if (p.near) { ctx.drawImage(bokehSprite(p.c), p.x - p.r, p.y - p.r, p.r * 2, p.r * 2); return; }
      if (sc.dark) {
        const q = p.r * 2.2;
        ctx.globalAlpha *= 0.5;
        ctx.drawImage(glowSprite(p.c), p.x - q, p.y - q, q * 2, q * 2);
        ctx.globalAlpha *= 2;
      } else {
        ctx.fillStyle = css(p.c, 0.12);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r * sq, p.r / sq, 0, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = p.color; ctx.lineWidth = sc.dark ? 1.4 : 1.8;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r * sq, p.r / sq, 0, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.68, -2.5, -1.7); ctx.stroke();
    },
    glow: true, x, y, r, z, near, c, color: css(sc0(s, c)), vy: -(near ? rand(160, 260) : rand(120, 260) * (0.6 + z * 0.6)), buoy: rand(30, 90),
    wf: rand(1.5, 3), wa: rand(15, 40), ph: rand(0, TAU), pop: rand(1.4, 3.2), popY: s.h * rand(0.08, 0.6), life: 5,
  });
  return b;
}
const sc0 = (s, c) => (s.dark ? lift(c, true, 0.12) : c);

function pop(s, p) {
  flash(s, p.x, p.y, p.r * 5, p.c, 0.5, 0.8);
  s.add({
    up(q) { q.alpha = 1 - easeOut(q.age / q.life); },
    dr(ctx, q) {
      ctx.strokeStyle = q.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r + easeOut(q.age / q.life) * q.r * 2.2, 0, TAU); ctx.stroke();
    },
    glow: true, x: p.x, y: p.y, r: p.r, color: p.color, life: 0.45, z: 0.6,
  });
  const n = 6 + ((Math.random() * 5) | 0);
  for (let i = 0; i < n; i += 1) {
    const a = rand(0, TAU), v = rand(60, 200);
    glint(s, p.x, p.y, Math.cos(a) * v, Math.sin(a) * v, p.c, { life: rand(0.9, 1.6), size: rand(2, 3.6), k: 2.4, g: 60 });
  }
  // Chain reaction: neighbours close by go a moment later.
  for (const o of s.parts) {
    if (o.near === false && !o.dead && o !== p && o.pop && Math.hypot(o.x - p.x, o.y - p.y) < 130) o.pop = Math.min(o.pop, o.age + rand(0.06, 0.16));
  }
}

const isLocal = (() => { try { return ['127.0.0.1', 'localhost'].includes(location.hostname); } catch { return false; } })();

/* ---------------------------------- the toast --------------------------------- */

let toastTimer = 0;

function showToast({ still }) {
  try {
    document.querySelector('.fx-toast')?.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement('div');
    toast.className = still ? 'fx-toast is-still' : 'fx-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <span class="fx-toast-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5.5 12.5l4.2 4.2L18.5 7.8" /></svg>
      </span>
      <span class="fx-toast-text">
        <strong class="fx-toast-head">Accepted</strong>
        <span class="fx-toast-meta"></span>
      </span>`;
    const dismiss = () => {
      clearTimeout(toastTimer);
      if (still) { toast.remove(); return; }
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 260);
    };
    toast.addEventListener('click', dismiss);
    document.body.append(toast);
    // Two frames, so the entrance transition starts from its first state rather than skipping it.
    if (!still) requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('is-in')));
    else toast.classList.add('is-in');
    toastTimer = setTimeout(dismiss, TOAST_MS);
    fillStats(toast.querySelector('.fx-toast-meta')).catch(() => {});
  } catch { /* the verdict is already on screen in the results pane */ }
}

const FLAME = `<svg class="fx-flame" viewBox="0 0 16 20" width="11" height="14" aria-hidden="true">
  <path class="fx-flame-outer" d="M8 1c.6 3-1.2 4.4-2.6 6.1C4 8.8 2.5 10.6 2.5 13.2 2.5 16.6 5 19 8 19s5.5-2.4 5.5-5.6c0-2.3-1-3.9-2-5.1-.3 1.3-1 2.2-1.9 2.6C10.4 7.4 9.9 3.6 8 1z"/>
  <path class="fx-flame-inner" d="M8 10.2c.2 1.5-.8 2.1-1.4 2.9-.4.5-.8 1.1-.8 1.9 0 1.3 1 2.3 2.2 2.3s2.2-1 2.2-2.3c0-1.6-1.1-2.5-1.7-3.4-.2.5-.4.8-.7 1 .3-.8.4-1.6.2-2.4z"/>
</svg>`;

async function fillStats(meta) {
  if (!meta) return;
  announceStatsChanged();
  const stats = await loadStats({ fresh: true });
  if (!stats || !meta.isConnected) return;
  const parts = [];
  const list = stats.lists?.neetcode250;
  if (list && Number.isFinite(list.accepted) && Number.isFinite(list.total) && list.total > 0) {
    parts.push(`<span><b>${list.accepted}</b> / ${list.total} solved</span>`);
  }
  const streak = computeStreak(stats.activity);
  if (streak.current > 0) {
    const label = streak.current === 1 ? 'Streak started' : `${streak.current}-day streak`;
    parts.push(`<span class="fx-toast-streak">${FLAME}${label}</span>`);
  }
  if (!parts.length) return;
  meta.innerHTML = parts.join('<span class="fx-toast-dot" aria-hidden="true">·</span>');
  meta.classList.add('is-filled');
}

/* ------------------------------- the test hook ------------------------------- */

try {
  if (isLocal) {
    window.__studioCelebrate = (variantIndex) => {
      const button = [...document.querySelectorAll('button')].find((b) => /submit|judging/i.test(b.textContent || '') && b.offsetParent);
      celebrate({ origin: button ? button.getBoundingClientRect() : null, variant: variantIndex });
    };
  }
} catch { /* no window */ }
