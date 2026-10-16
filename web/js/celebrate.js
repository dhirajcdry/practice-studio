// The Accepted celebration: a short burst on a full-screen canvas, and a toast with the
// solved count and streak.
//
// Seven variants rotate through a shuffle bag kept in localStorage, so the same one never
// plays twice in a row, and every variant re-rolls its own counts, angles and colours, so
// even a repeat lands differently. Colours come from the live theme's tokens, so a
// celebration in Abyss glows teal and one in Editorial prints in oxblood and ochre.
//
// Nothing here may break the submit flow: every entry point swallows its own errors.

import { getSettings } from './settings.js';
import { announceStatsChanged, computeStreak, loadStats } from './streak.js';

const BAG_KEY = 'studio.celebrate.bag';
const MAX_PARTICLES = 400;
const HARD_STOP = 3.4;          // seconds; everything fades out over the last FADE
const FADE = 0.45;
const TOAST_MS = 4200;
const TAU = Math.PI * 2;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[(Math.random() * list.length) | 0];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

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
    runCanvas(VARIANTS[index], origin);
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

const css = ({ h, s, l }) => `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;

// Light themes lose anything near white against the paper, and dark themes lose
// anything muddy, so each appearance has its own lightness band.
function fit(hsl, dark, dl = 0) {
  const grey = hsl.s < 0.12;
  const l = dark ? clamp(hsl.l + dl, 0.5, 0.84) : clamp(hsl.l + dl, 0.26, 0.6);
  const s = grey ? hsl.s : clamp(hsl.s, dark ? 0.55 : 0.5, 1);
  return { h: hsl.h, s, l };
}

function buildPalette(ctx, dark) {
  const style = getComputedStyle(document.body);
  const read = (name, fallback) => {
    const rgb = parseColor(ctx, style.getPropertyValue(name).trim()) || parseColor(ctx, fallback);
    return toHsl(rgb);
  };
  const accent = read('--accent', '#355DCC');
  const solid = read('--solid-bg', '#345BCC');
  const easy = read('--easy', '#2E6B4F');
  const med = read('--med', '#93650B');
  const hard = read('--hard', '#B33A1A');
  const ink = read('--ink', dark ? '#E8E8E8' : '#111111');

  const shades = (c) => [fit(c, dark), fit(c, dark, dark ? 0.12 : 0.1), fit(c, dark, dark ? -0.1 : -0.1)].map(css);
  const accents = [...shades(accent), ...shades(solid)];
  const warm = [...shades(med), ...shades(hard)];
  const cool = [...shades(easy), ...shades(accent)];
  // Ink is the theme's own voice: a few pieces of it read as deliberate, a lot as dirt.
  const all = [...accents, ...warm, ...shades(easy), css(fit(ink, dark))];
  const bright = [fit(accent, dark, 0.16), fit(med, dark, 0.16), fit(easy, dark, 0.16), fit(hard, dark, 0.12)].map(css);
  return { all, accents, warm, cool, bright, ink: css(fit(ink, dark)), dark };
}

/* --------------------------------- the stage -------------------------------- */

function runCanvas(variant, origin) {
  if (document.hidden) return;
  if (active) active.stop();

  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dark = document.body.classList.contains('is-dark');
  const scene = {
    w: window.innerWidth,
    h: window.innerHeight,
    ox: 0, oy: 0,
    t: 0,
    dark,
    palette: buildPalette(ctx, dark),
    parts: [],
    waiting: 0,
    events: [],
    add(p) {
      if (this.parts.length + this.waiting >= MAX_PARTICLES) return null;
      p.age = 0;
      this.parts.push(p);
      return p;
    },
    at(time, fn) { this.events.push({ time, fn }); },
  };
  const rect = origin && Number.isFinite(origin.left) && origin.width > 0 ? origin : null;
  scene.ox = rect ? rect.left + rect.width / 2 : scene.w / 2;
  scene.oy = rect ? rect.top + rect.height / 2 : scene.h * 0.62;

  let dpr = 1;
  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    scene.w = window.innerWidth;
    scene.h = window.innerHeight;
    canvas.width = Math.round(scene.w * dpr);
    canvas.height = Math.round(scene.h * dpr);
  };
  size();
  document.body.append(canvas);

  try { variant.setup(scene); } catch { canvas.remove(); return; }
  scene.events.sort((a, b) => a.time - b.time);

  let frame = 0;
  let last = performance.now();
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', size);
    document.removeEventListener('visibilitychange', onHidden);
    canvas.remove();
    if (active === handle) active = null;
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
      // Clamp the step so a stalled frame never teleports everything off screen.
      const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
      last = now;
      scene.t += dt;
      while (scene.events.length && scene.events[0].time <= scene.t) scene.events.shift().fn(scene);
      step(scene, dt);
      draw(ctx, scene, dpr);
      const done = scene.t >= HARD_STOP || (!scene.events.length && !scene.parts.length && scene.t > 0.3);
      if (done) { stop(); return; }
      frame = requestAnimationFrame(tick);
    } catch { stop(); }
  };
  frame = requestAnimationFrame((now) => { last = now; tick(now); });
}

function step(scene, dt) {
  // Survivors and anything born this step (bursts, trails) land on a fresh list; the
  // particles still waiting their turn count toward the cap until they are judged.
  const old = scene.parts;
  scene.parts = [];
  for (let i = 0; i < old.length; i += 1) {
    const p = old[i];
    scene.waiting = old.length - i - 1;
    p.age += dt;
    if (p.age >= p.life) { p.onDeath?.(scene, p); continue; }
    KINDS[p.kind].update(p, dt, scene);
    if (p.dead) continue;
    scene.parts.push(p);
  }
  scene.waiting = 0;
}

function draw(ctx, scene, dpr) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fade = scene.t > HARD_STOP - FADE ? clamp((HARD_STOP - scene.t) / FADE, 0, 1) : 1;
  // Two passes: solid paper pieces first, then light. On a dark theme, light adds up
  // into a glow; on paper, additive blending would bleach it to white, so it stays normal.
  for (const glow of [false, true]) {
    ctx.globalCompositeOperation = glow && scene.dark ? 'lighter' : 'source-over';
    for (const p of scene.parts) {
      const kind = KINDS[p.kind];
      if (Boolean(kind.glow) !== glow) continue;
      ctx.globalAlpha = clamp(p.alpha ?? 1, 0, 1) * fade;
      kind.draw(ctx, p, scene);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

const lifeFade = (p, tail = 0.3) => clamp((p.life - p.age) / (p.life * tail), 0, 1);

/* ------------------------------- particle kinds ------------------------------ */

const KINDS = {
  // Paper confetti: a rectangle tumbling about two axes, faked by squashing its height.
  confetti: {
    update(p, dt) {
      const drag = Math.exp(-p.k * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt + Math.sin(p.age * p.wf + p.phase) * p.wa * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.vf * dt;
      if (p.trail) {
        p.trail.unshift(p.x, p.y);
        if (p.trail.length > 16) p.trail.length = 16;
      }
      p.alpha = lifeFade(p, 0.25);
      if (p.y > window.innerHeight + 40) p.dead = true;
    },
    draw(ctx, p) {
      const c = Math.cos(p.flip);
      ctx.fillStyle = c >= 0 ? p.color : p.back;
      ctx.strokeStyle = ctx.fillStyle;
      if (p.shape === 'ribbon' && p.trail && p.trail.length >= 6) {
        // A streamer: the recent path, rippled sideways so it reads as curling paper.
        ctx.lineWidth = p.h * (0.55 + 0.45 * Math.abs(c));
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        // Capped by length, not points, so a fast streamer is not a long straight line.
        let run = 0;
        for (let i = 0; i < p.trail.length; i += 2) {
          if (i) run += Math.hypot(p.trail[i] - p.trail[i - 2], p.trail[i + 1] - p.trail[i - 1]);
          if (run > 34) break;
          const wave = Math.sin(i * 0.9 + p.age * 14) * 2.6;
          const x = p.trail[i] + wave * Math.cos(p.rot);
          const y = p.trail[i + 1] + wave * Math.sin(p.rot);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.max(0.08, Math.abs(c)));
      if (p.shape === 'dot') {
        ctx.beginPath(); ctx.arc(0, 0, p.h * 0.7, 0, TAU); ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    },
  },

  // A spark: a short streak along its own velocity, so the trail does not depend on frame rate.
  spark: {
    glow: true,
    update(p, dt) {
      const drag = Math.exp(-p.k * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      let a = p.fadeIn ? clamp(p.age / p.fadeIn, 0, 1) : 1;
      a *= Math.pow(lifeFade(p, p.tail ?? 0.6), 1.3);
      if (p.twinkle && p.age > p.life * 0.35) a *= 0.45 + 0.55 * Math.abs(Math.sin(p.age * p.twinkle + p.phase));
      p.alpha = a;
    },
    draw(ctx, p) {
      const len = p.streak ?? 0.035;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * len, p.y - p.vy * len);
      ctx.lineTo(p.x + 0.01, p.y + 0.01);
      ctx.stroke();
    },
  },

  // A rocket climbing to its apex, shedding embers, then bursting.
  rocket: {
    glow: true,
    update(p, dt, scene) {
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.emit += dt;
      while (p.emit > 0.007) {
        p.emit -= 0.007;
        scene.add({
          kind: 'spark', x: p.x + rand(-1.5, 1.5), y: p.y + rand(0, 4), vx: rand(-20, 20), vy: rand(10, 60),
          k: 3, g: 120, life: rand(0.25, 0.5), size: rand(1, 1.8), color: p.trailColor, streak: 0.02,
        });
      }
      if (p.vy > -70) { p.dead = true; p.burst(scene, p); }
      p.alpha = 1;
    },
    draw(ctx, p) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.lineTo(p.x, p.y); ctx.stroke();
    },
  },

  // A soft flash of light where something bursts.
  flash: {
    glow: true,
    update(p) { p.alpha = (1 - easeOut(p.age / p.life)) * (p.peak ?? 1); },
    draw(ctx, p) {
      const r = p.r * (0.6 + 0.4 * easeOut(p.age / p.life));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, p.color);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
    },
  },

  // An expanding ring, thinning as it goes.
  ring: {
    update(p) {
      const t = easeOut(p.age / p.life);
      p.r = p.r0 + (p.r1 - p.r0) * t;
      p.alpha = Math.pow(1 - p.age / p.life, 1.4) * (p.peak ?? 1);
    },
    draw(ctx, p) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(0.6, p.width * (1 - p.age / p.life));
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
    },
  },

  // Glitter: a four-pointed glint drifting on the air.
  mote: {
    glow: true,
    update(p, dt) {
      const drag = Math.exp(-p.k * dt);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt + Math.sin(p.age * p.wf + p.phase) * p.wa * dt;
      p.y += p.vy * dt;
      const twinkle = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(p.age * p.tw + p.phase)), 2);
      p.alpha = clamp(p.age / 0.18, 0, 1) * lifeFade(p, 0.45) * twinkle;
      p.spin += dt * p.vs;
    },
    draw(ctx, p) {
      const s = p.size;
      ctx.fillStyle = p.color;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.22;
      ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.75, 0, TAU); ctx.fill();
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.beginPath();
      // Concave four-point star: long horizontal and vertical arms, pinched waist.
      ctx.moveTo(0, -s);
      ctx.quadraticCurveTo(0, 0, s * 0.62, 0);
      ctx.quadraticCurveTo(0, 0, 0, s);
      ctx.quadraticCurveTo(0, 0, -s * 0.62, 0);
      ctx.quadraticCurveTo(0, 0, 0, -s);
      ctx.fill();
      ctx.restore();
    },
  },

  // A meteor: a bright head with a long tapering tail.
  meteor: {
    glow: true,
    update(p, dt, scene) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.emit += dt;
      while (p.emit > p.every) {
        p.emit -= p.every;
        scene.add({
          kind: 'mote', x: p.x + rand(-6, 6), y: p.y + rand(-6, 6), vx: p.vx * 0.04 + rand(-15, 15), vy: p.vy * 0.04 + rand(-15, 15),
          k: 2, g: 30, life: rand(0.6, 1.2), size: rand(1.6, 3.4), color: pick(scene.palette.bright),
          wf: rand(2, 4), wa: rand(4, 12), phase: rand(0, TAU), tw: rand(8, 16), spin: rand(0, TAU), vs: rand(-2, 2),
        });
      }
      if (p.target && Math.hypot(p.target.x - p.x, p.target.y - p.y) < 16) {
        p.dead = true;
        p.onArrive?.(scene, p);
      }
      const off = p.x < -p.len - 40 || p.x > scene.w + p.len + 40 || p.y > scene.h + p.len + 40;
      if (off && p.age > 0.2) p.dead = true;
      p.alpha = clamp(p.age / 0.08, 0, 1);
    },
    draw(ctx, p) {
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const tx = p.x - (p.vx / speed) * p.len;
      const ty = p.y - (p.vy / speed) * p.len;
      const g = ctx.createLinearGradient(p.x, p.y, tx, ty);
      g.addColorStop(0, p.color);
      g.addColorStop(1, 'transparent');
      ctx.strokeStyle = g;
      ctx.lineCap = 'round';
      ctx.lineWidth = p.width;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke();
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.width * 5);
      halo.addColorStop(0, p.color);
      halo.addColorStop(1, 'transparent');
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * 0.45;
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.width * 5, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.head;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.width * 0.9, 0, TAU); ctx.fill();
    },
  },

  // A star in a spiral arm: orbits the button, unwinding outward, then lets go.
  orbit: {
    glow: true,
    update(p, dt) {
      p.w *= Math.exp(-p.wd * dt);
      p.vr += p.ar * dt;
      p.theta += p.w * dt;
      p.r += p.vr * dt;
      p.x = p.cx + Math.cos(p.theta) * p.r;
      p.y = p.cy + Math.sin(p.theta) * p.r * p.squash;
      p.alpha = clamp(p.age / 0.15, 0, 1) * Math.pow(lifeFade(p, 0.5), 1.2);
    },
    draw(ctx, p) {
      // The streak follows the orbit's own tangent, a few degrees back along the arc.
      const back = p.w * 0.06;
      const r = p.r - p.vr * 0.06;
      const bx = p.cx + Math.cos(p.theta - back) * r;
      const by = p.cy + Math.sin(p.theta - back) * r * p.squash;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(p.x, p.y); ctx.stroke();
    },
  },

  // A rising glass orb that pops into a spray.
  orb: {
    update(p, dt) {
      p.vy += p.lift * dt;
      p.vy *= Math.exp(-0.6 * dt);
      p.x += Math.sin(p.age * p.wf + p.phase) * p.wa * dt;
      p.y += p.vy * dt;
      p.alpha = clamp(p.age / 0.2, 0, 1) * (p.dark ? 0.9 : 0.92);
      if (p.age >= p.pop) { p.dead = true; p.onPop(p); }
    },
    draw(ctx, p) {
      // Swell a little just before popping.
      const swell = 1 + 0.12 * clamp((p.age - (p.pop - 0.12)) / 0.12, 0, 1);
      const r = p.r * swell;
      const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.05, p.x, p.y, r);
      g.addColorStop(0, p.hi);
      g.addColorStop(0.45, p.color);
      g.addColorStop(1, p.rim);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(p.x - r * 0.38, p.y - r * 0.42, r * 0.22, r * 0.13, -0.7, 0, TAU); ctx.fill();
    },
  },
};

/* --------------------------------- emitters --------------------------------- */

function confettiPiece(scene, x, y, angle, speed, colors, opts = {}) {
  const shape = opts.shape || (Math.random() < 0.22 ? 'ribbon' : Math.random() < 0.15 ? 'dot' : 'rect');
  const color = pick(colors);
  return scene.add({
    kind: 'confetti', shape, x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    k: opts.k ?? rand(1.9, 2.6), g: opts.g ?? rand(560, 760),
    w: rand(7, 12), h: shape === 'ribbon' ? rand(2.4, 3.4) : rand(4, 6.5),
    rot: rand(0, TAU), vr: rand(-9, 9), flip: rand(0, TAU), vf: rand(5, 13),
    wf: rand(3, 7), wa: rand(20, 60), phase: rand(0, TAU),
    life: opts.life ?? rand(2.2, 3.1),
    color, back: shadeOf(color, scene.dark),
    trail: shape === 'ribbon' ? [] : null,
  });
}

// The underside of a piece of confetti: the same colour, in shadow.
function shadeOf(color, dark) {
  const m = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/.exec(color);
  if (!m) return color;
  const l = Number(m[3]) * (dark ? 0.72 : 0.78);
  return `hsl(${m[1]} ${m[2]}% ${l.toFixed(1)}%)`;
}

function sparkBurst(scene, x, y, { count, speed, colors, k = 1.7, g = 160, life = [0.9, 1.3], size = [1.4, 2.4], twinkle = 0, ring = false, squash = 1, streak, tail }) {
  const tilt = rand(0, TAU);
  for (let i = 0; i < count; i += 1) {
    const a = ring ? (i / count) * TAU + rand(-0.02, 0.02) : rand(0, TAU);
    const v = ring ? speed[1] * rand(0.97, 1.03) : rand(speed[0], speed[1]) * Math.sqrt(Math.random() * 0.6 + 0.4);
    // Rings are tilted ellipses, so they look like a sphere seen at an angle.
    let vx = Math.cos(a) * v;
    let vy = Math.sin(a) * v * squash;
    if (squash !== 1) [vx, vy] = [vx * Math.cos(tilt) - vy * Math.sin(tilt), vx * Math.sin(tilt) + vy * Math.cos(tilt)];
    scene.add({
      kind: 'spark', x, y, vx, vy, k, g,
      life: rand(life[0], life[1]), size: rand(size[0], size[1]),
      color: pick(colors), twinkle: twinkle && Math.random() < 0.6 ? twinkle * rand(0.7, 1.3) : 0,
      phase: rand(0, TAU), streak, tail,
    });
  }
}

function flash(scene, x, y, r, color, life = 0.35, peak = 1) {
  scene.add({ kind: 'flash', x, y, r, color, life, peak: scene.dark ? peak : peak * 0.35 });
}

/* --------------------------------- variants --------------------------------- */

const VARIANTS = [
  // 1. Confetti burst from the Submit button.
  {
    name: 'burst',
    setup(scene) {
      const { ox, oy, palette } = scene;
      const colors = Math.random() < 0.3 ? palette.accents.concat(palette.ink) : palette.all;
      // Lean the cone toward the middle of the screen so a corner button still fills it.
      const lean = clamp((scene.w / 2 - ox) / scene.w, -0.5, 0.5) * 0.9;
      const up = -Math.PI / 2 + lean + rand(-0.12, 0.12);
      const spread = rand(0.75, 1.1);
      const waves = Math.random() < 0.5 ? 2 : 3;
      const total = (rand(180, 240)) | 0;
      for (let w = 0; w < waves; w += 1) {
        scene.at(w * rand(0.09, 0.16), () => {
          const n = (total / waves) | 0;
          for (let i = 0; i < n; i += 1) {
            const a = up + rand(-spread, spread) * Math.pow(Math.random(), 0.7);
            confettiPiece(scene, ox + rand(-10, 10), oy + rand(-4, 4), a, rand(900, 2100) * (1 - w * 0.12), colors, { k: rand(2.6, 3.3) });
          }
        });
      }
      flash(scene, ox, oy, 70, palette.bright[0], 0.3, 0.5);
    },
  },

  // 2. Side cannons: two streams from the bottom corners, crossing in the middle.
  {
    name: 'cannons',
    setup(scene) {
      const { w, h, palette } = scene;
      const lift = rand(-1.25, -1.0);          // how steep the cannons point
      const pulses = (rand(5, 8)) | 0;
      const per = (rand(26, 34)) | 0;
      const colorsL = Math.random() < 0.5 ? palette.all : palette.accents.concat(palette.warm.slice(0, 3));
      const colorsR = Math.random() < 0.5 ? colorsL : palette.all;
      for (let k = 0; k < pulses; k += 1) {
        scene.at(k * rand(0.07, 0.11), () => {
          for (let i = 0; i < per / 2; i += 1) {
            const speed = rand(1500, 2300) * (h / 900) ** 0.5;
            const k = rand(1.5, 1.9);
            confettiPiece(scene, -6, h + 6, lift + rand(-0.2, 0.2), speed, colorsL, { k });
            confettiPiece(scene, w + 6, h + 6, -Math.PI - lift + rand(-0.2, 0.2), speed, colorsR, { k });
          }
        });
      }
    },
  },

  // 3. Fireworks: rockets climb and burst into peonies, rings and willows.
  {
    name: 'fireworks',
    setup(scene) {
      const { w, h, palette } = scene;
      const count = 3 + ((Math.random() * 3) | 0);
      const styles = ['peony', 'ring', 'willow', 'peony', 'ring'].sort(() => Math.random() - 0.5);
      const g = 1050;
      for (let i = 0; i < count; i += 1) {
        const x = w * (0.18 + (0.64 * (i + rand(0.15, 0.85))) / count);
        const top = h * rand(0.14, 0.42);
        const vy = -Math.sqrt(2 * g * (h + 10 - top));
        const style = styles[i % styles.length];
        const hue = palette.bright[i % palette.bright.length];
        scene.at(i * rand(0.17, 0.26), () => scene.add({
          kind: 'rocket', x, y: h + 10, vx: rand(-40, 40), vy, g, emit: 0, life: 3,
          color: hue, trailColor: pick(palette.warm),
          burst: (s, p) => explode(s, p.x, p.y, style, hue, palette),
        }));
      }
    },
  },

  // 4. Starfall: meteors streak diagonally across the screen; the last one lands on the button.
  {
    name: 'starfall',
    setup(scene) {
      const { w, h, ox, oy, palette } = scene;
      const leftward = Math.random() < 0.6;
      const angle = (leftward ? Math.PI - rand(0.85, 1.05) : rand(0.85, 1.05));
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const count = (rand(18, 26)) | 0;
      for (let i = 0; i < count; i += 1) {
        scene.at(rand(0, 1.3), () => {
          const speed = rand(1100, 1700);
          // Start somewhere along the top edge, or the side the meteors come from.
          const along = rand(-0.2, 1.3);
          const sx = leftward ? w * along : w * (1 - along);
          meteor(scene, sx, -20, dx * speed, dy * speed, palette);
        });
      }
      scene.at(1.15, () => {
        const speed = 1500;
        const dist = Math.min(w, h) * 0.95;
        const sx = ox - dx * dist, sy = oy - dy * dist;
        const m = meteor(scene, sx, sy, dx * speed, dy * speed, palette, { big: true });
        if (!m) return;
        m.target = { x: ox, y: oy };
        m.onArrive = (s) => {
          flash(s, ox, oy, 90, palette.bright[0], 0.45, 0.8);
          sparkBurst(s, ox, oy, { count: 42, speed: [120, 360], colors: palette.bright, k: 2.4, g: 90, life: [0.7, 1.2], twinkle: 22 });
          glitter(s, ox, oy, 26, 90, palette);
        };
      });
    },
  },

  // 5. Shockwave and glitter: rings roll out from the button and leave glitter in their wake.
  {
    name: 'shockwave',
    setup(scene) {
      const { ox, oy, palette } = scene;
      const reach = rand(300, 460);
      const color = pick(palette.accents.slice(0, 3));
      const rings = Math.random() < 0.5 ? 2 : 3;
      for (let i = 0; i < rings; i += 1) {
        scene.at(i * 0.13, () => scene.add({
          kind: 'ring', x: ox, y: oy, r0: 6, r1: reach * (1 - i * 0.18), life: 0.95 - i * 0.1,
          width: 9 - i * 2.5, color: i === 1 ? pick(palette.warm.slice(0, 3)) : color, peak: 1 - i * 0.2,
        }));
      }
      flash(scene, ox, oy, 110, palette.bright[0], 0.4, 0.9);
      sparkBurst(scene, ox, oy, { count: 36, speed: [500, 900], colors: palette.bright, k: 5, g: 0, life: [0.35, 0.6], size: [1.6, 2.6], streak: 0.05 });
      // Glitter seeds behind the leading ring, so the wave appears to leave it behind.
      const seeds = (rand(150, 200)) | 0;
      for (let i = 0; i < seeds; i += 1) {
        const at = rand(0.05, 0.8);
        scene.at(at, (s) => {
          const r = reach * easeOut(at / 0.95) * rand(0.55, 1);
          const a = rand(0, TAU);
          glitterMote(s, ox + Math.cos(a) * r, oy + Math.sin(a) * r, Math.cos(a) * rand(10, 40), Math.sin(a) * rand(10, 40) - rand(15, 45), palette);
        });
      }
    },
  },

  // 6. Galaxy: spiral arms unwind out of the button, then the stars drift off.
  {
    name: 'galaxy',
    setup(scene) {
      const { w, h, palette } = scene;
      // Keep the whole disc on screen even when the button sits in a corner.
      const cx = clamp(scene.ox, Math.min(w / 2, 260), Math.max(w / 2, w - 260));
      const cy = clamp(scene.oy, Math.min(h / 2, 240), Math.max(h / 2, h - 240));
      const arms = 2 + ((Math.random() * 3) | 0);
      const dir = Math.random() < 0.5 ? 1 : -1;
      const spin = dir * rand(3.3, 4.1);
      const squash = rand(0.55, 0.85);       // seen slightly from the side, like a real galaxy
      const count = (rand(230, 280)) | 0;
      const start = rand(0, TAU);
      const pool = palette.bright.concat(palette.accents.slice(0, 3), palette.warm.slice(0, 2));
      const armColor = [...Array(arms)].map(() => pick(pool));
      flash(scene, cx, cy, 70, armColor[0], 1.2, 0.55);
      // Every star leaves the core along its arm's fixed heading while the disc turns, so
      // stars born earlier sit further out and further round: the arm draws itself.
      for (let i = 0; i < count; i += 1) {
        const arm = i % arms;
        const born = (i / count) * 0.95;
        scene.at(born, (s) => s.add({
          kind: 'orbit', cx, cy, squash,
          theta: start + (arm / arms) * TAU + rand(-0.16, 0.16),
          r: rand(2, 10), vr: rand(150, 200), ar: rand(20, 60),
          w: spin * rand(0.94, 1.06), wd: 0.25,
          size: rand(1.3, 2.8), color: Math.random() < 0.75 ? armColor[arm] : pick(pool), life: rand(1.4, 1.9),
          x: cx, y: cy,
        }));
      }
    },
  },

  // 7. Orbs: glass bubbles drift up from below and pop into little sprays.
  {
    name: 'orbs',
    setup(scene) {
      const { w, h, palette } = scene;
      const count = (rand(9, 14)) | 0;
      const colors = Math.random() < 0.5 ? palette.all.filter((c) => c !== palette.ink) : palette.accents.concat(palette.bright);
      for (let i = 0; i < count; i += 1) {
        const x = w * (0.08 + 0.84 * ((i + rand(0.1, 0.9)) / count));
        const color = pick(colors);
        scene.at(rand(0, 0.55), (s) => s.add({
          kind: 'orb', x, y: h + 30, vy: -rand(380, 560), lift: -rand(40, 120),
          r: rand(10, 19), wf: rand(1.5, 3), wa: rand(20, 50), phase: rand(0, TAU),
          pop: rand(0.95, 1.9), life: 3, dark: s.dark,
          color, hi: lighten(color, 0.3), rim: shadeOf(color, s.dark),
          onPop: (p) => {
            const c = [p.color, lighten(p.color, 0.15), pick(palette.bright)];
            sparkBurst(s, p.x, p.y, { count: (rand(16, 24)) | 0, speed: [220, 480], colors: c, k: 2.6, g: 260, life: [0.6, 1.0], size: [1.4, 2.4], twinkle: 18 });
            s.add({ kind: 'ring', x: p.x, y: p.y, r0: p.r, r1: p.r * 4.5, life: 0.4, width: 2.4, color: p.color, peak: 0.8 });
            for (let k = 0; k < 6; k += 1) confettiPiece(s, p.x, p.y, rand(0, TAU), rand(120, 280), c, { life: rand(1.0, 1.5), g: 420, shape: Math.random() < 0.5 ? 'dot' : 'rect' });
          },
        }));
      }
    },
  },
];

function lighten(color, by) {
  const m = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/.exec(color);
  if (!m) return color;
  return `hsl(${m[1]} ${m[2]}% ${Math.min(94, Number(m[3]) + by * 100).toFixed(1)}%)`;
}

function explode(scene, x, y, style, color, palette) {
  const second = pick(palette.bright.filter((c) => c !== color)) || color;
  flash(scene, x, y, 120, color, 0.4, 0.9);
  if (style === 'ring') {
    sparkBurst(scene, x, y, { count: 56, speed: [0, 470], colors: [color], ring: true, squash: rand(0.45, 1), k: 1.5, g: 120, life: [0.95, 1.25], twinkle: 20 });
    sparkBurst(scene, x, y, { count: 22, speed: [40, 170], colors: [second], k: 1.8, g: 100, life: [0.6, 0.9] });
  } else if (style === 'willow') {
    // Willows hang: slow, heavy-dragged sparks with long golden trails.
    sparkBurst(scene, x, y, { count: 80, speed: [120, 420], colors: palette.warm.slice(0, 3).concat(second), k: 1.2, g: 190, life: [1.2, 1.6], size: [1.1, 1.9], twinkle: 26, streak: 0.09, tail: 0.8 });
  } else {
    sparkBurst(scene, x, y, { count: 84, speed: [180, 560], colors: [color, color, second], k: 1.7, g: 150, life: [0.9, 1.3], twinkle: 18 });
  }
}

function meteor(scene, x, y, vx, vy, palette, { big = false } = {}) {
  return scene.add({
    kind: 'meteor', x, y, vx, vy, emit: 0, every: big ? 0.012 : rand(0.03, 0.06),
    len: big ? 340 : rand(150, 300), width: big ? 4.2 : rand(2, 3.4),
    color: pick(palette.bright), head: scene.dark ? lighten(pick(palette.bright), 0.25) : pick(palette.accents),
    life: 2.4,
  });
}

function glitterMote(scene, x, y, vx, vy, palette) {
  return scene.add({
    kind: 'mote', x, y, vx, vy, k: 1.2, g: -8,
    life: rand(1.4, 2.4), size: rand(3.5, 7.5), color: pick(palette.bright.concat(palette.accents.slice(0, 2))),
    wf: rand(1.2, 2.6), wa: rand(8, 24), phase: rand(0, TAU), tw: rand(4, 9), spin: rand(0, TAU), vs: rand(-1.5, 1.5),
  });
}

function glitter(scene, x, y, count, radius, palette) {
  for (let i = 0; i < count; i += 1) {
    const a = rand(0, TAU), r = rand(0, radius);
    glitterMote(scene, x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * rand(10, 40), -rand(10, 50), palette);
  }
}

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
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    window.__studioCelebrate = (variantIndex) => {
      const button = [...document.querySelectorAll('button')].find((b) => /submit|judging/i.test(b.textContent || '') && b.offsetParent);
      celebrate({ origin: button ? button.getBoundingClientRect() : null, variant: variantIndex });
    };
  }
} catch { /* no window */ }
