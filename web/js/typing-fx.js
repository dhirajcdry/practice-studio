// Typing effects: tiny sparks and a soft caret glow in the Monaco editor.
//
// The point is feel, not spectacle. Hours of typing must not be slower or noisier for
// it, so three rules hold throughout:
//
//   1. Nothing here ever touches the text, the caret or the viewport. Everything is drawn
//      on one canvas laid over the editor with pointer-events off.
//   2. The keystroke itself does no work beyond noting what happened. The caret is read
//      once, in the next animation frame (after Monaco has painted), and the loop only
//      runs while something is still alive on screen.
//   3. Only a person typing gets an effect. Restores, undo, redo, pastes and the coach's
//      edits arrive through the same model event and are told apart here.

import { getSettings, onSettingsChange } from './settings.js';

const MAX_PARTICLES = 150;
const RATE_WINDOW_MS = 1200;
const CLOSERS = new Set([')', ']', '}', ':']);

/* --------------------------------- colour --------------------------------- */

function parseColor(value, fallback) {
  const text = String(value || '').trim();
  let m = text.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = text.match(/^#([0-9a-f]{6})/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = text.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return fallback;
}

function readPalette() {
  const css = getComputedStyle(document.body);
  const accent = parseColor(css.getPropertyValue('--accent-rgb'), null) || parseColor(css.getPropertyValue('--accent'), [120, 140, 255]);
  return {
    dark: document.body.classList.contains('is-dark'),
    accent,
    ink: parseColor(css.getPropertyValue('--ink-rgb'), [128, 128, 128]),
    alt: [parseColor(css.getPropertyValue('--tok-kw'), accent), parseColor(css.getPropertyValue('--tok-def'), accent)],
  };
}

// A soft round glow, drawn once per colour and stamped with drawImage: far cheaper than
// building a gradient for every particle on every frame.
const sprites = new Map();
function glowSprite(rgb) {
  const key = rgb.join(',');
  let sprite = sprites.get(key);
  if (sprite) return sprite;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const g = sprite.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${key},1)`);
  grad.addColorStop(0.22, `rgba(${key},.55)`);
  grad.addColorStop(0.55, `rgba(${key},.14)`);
  grad.addColorStop(1, `rgba(${key},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  if (sprites.size > 24) sprites.clear(); // themes come and go; never grow without bound
  sprites.set(key, sprite);
  return sprite;
}

const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

/* --------------------------------- attach --------------------------------- */

export function attachTypingFx(instance, host, monaco) {
  const root = instance.getDomNode?.() || host;
  if (!root || typeof instance.onDidChangeModelContent !== 'function') return () => {};

  const canvas = document.createElement('canvas');
  canvas.className = 'typing-fx';
  canvas.setAttribute('aria-hidden', 'true');
  // Inline as well as in typing.css, so the overlay can never land in the flow and push text.
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:4';
  root.append(canvas);
  const ctx = canvas.getContext('2d');

  let palette = null;
  let width = 0, height = 0, dpr = 1;
  let clip = { x: 0, w: 0 };
  let particles = [];
  let bloom = null;     // { x, y, h, amp, t } — one glow that follows the caret
  let sweeps = [];      // Enter and `return` glints
  let rings = [];       // closing-bracket flourish
  let frame = 0, last = 0;
  let pending = null;   // what the last keystroke did, read in the next frame
  let contentSeen = false;
  const stamps = [];
  let energy = 0;
  let scrollTop = instance.getScrollTop?.(), scrollLeft = instance.getScrollLeft?.();

  const reduceQuery = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; } })();
  const enabled = () => {
    const s = getSettings();
    return s.motion !== false && s.typingFx !== false && s.typingSparks === true && !reduceQuery?.matches && !document.hidden;
  };

  function size() {
    // The layout info is Monaco's own cached measurement, so this costs no DOM read.
    const info = instance.getLayoutInfo();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = info.width; height = info.height;
    clip = { x: info.contentLeft, w: Math.max(0, info.width - info.contentLeft - (info.minimap?.minimapWidth || 0) - (info.verticalScrollbarWidth || 0)) };
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  size();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => size()) : null;
  ro?.observe(host);
  const subs = [instance.onDidLayoutChange?.(() => size())];

  function clearAll() {
    particles = []; sweeps = []; rings = []; bloom = null; pending = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function wake() {
    if (!frame) { last = 0; frame = requestAnimationFrame(tick); }
  }

  /* ----------------------------- reading input ---------------------------- */

  subs.push(instance.onDidChangeModelContent((event) => {
    if (event.isFlush || event.isUndoing || event.isRedoing) return;
    if (!instance.hasTextFocus()) return; // a restore or the coach, not his hands
    if (!enabled()) return;
    const changes = event.changes || [];
    if (!changes.length) return;
    const primary = changes[0];
    const text = primary.text || '';
    let kind = null;
    if (text.includes('\n')) {
      // Enter with auto-indent is a newline plus whitespace; anything else multi-line is a paste.
      if (/^\r?\n[ \t]*$/.test(text)) kind = 'enter';
    } else if (text.length) {
      if (text.length <= 12) kind = 'type';
    } else if (primary.rangeLength > 0 && primary.rangeLength <= 40) {
      kind = 'delete';
    }
    if (!kind) return;
    contentSeen = true;
    // Auto-closing types "()" for "(", so the key he pressed is the first character.
    pending = { kind, char: text[0] || '', line: primary.range.startLineNumber };
    wake();
  }));

  // Typing over an auto-closed bracket only moves the caret, so no content event comes.
  // The key still deserves its flourish.
  subs.push(instance.onKeyDown?.((event) => {
    const key = event.browserEvent?.key;
    if (!key || !CLOSERS.has(key) || event.metaKey || event.ctrlKey || !enabled()) return;
    contentSeen = false;
    requestAnimationFrame(() => {
      if (contentSeen || pending) return;
      pending = { kind: 'type', char: key, overtype: true };
      wake();
    });
  }));

  // Particles live in screen space; scrolling should carry them with the text.
  subs.push(instance.onDidScrollChange?.((event) => {
    if (!frame) return;
    const dy = event.scrollTopChanged ? -(event.scrollTop - (scrollTop ?? event.scrollTop)) : 0;
    const dx = event.scrollLeftChanged ? -(event.scrollLeft - (scrollLeft ?? event.scrollLeft)) : 0;
    scrollTop = event.scrollTop; scrollLeft = event.scrollLeft;
    if (!dx && !dy) return;
    for (const p of particles) { p.x += dx; p.y += dy; }
    for (const s of sweeps) { s.x0 += dx; s.x1 += dx; s.y += dy; }
    for (const r of rings) { r.x += dx; r.y += dy; }
    if (bloom) { bloom.x += dx; bloom.y += dy; }
  }));

  subs.push({ dispose: onSettingsChange(() => { palette = null; if (!enabled()) clearAll(); }) });
  const onReduce = () => { if (!enabled()) clearAll(); };
  reduceQuery?.addEventListener?.('change', onReduce);
  const onVisible = () => { if (document.hidden) clearAll(); };
  document.addEventListener('visibilitychange', onVisible);

  /* -------------------------------- spawning ------------------------------- */

  function caretAt(position) {
    const pos = position && instance.getScrolledVisiblePosition(position);
    if (!pos) return null;
    return { x: pos.left, y: pos.top, h: pos.height || instance.getOption?.(monaco.editor.EditorOption.lineHeight) || 20 };
  }

  function momentum(now) {
    stamps.push(now);
    while (stamps.length && now - stamps[0] > RATE_WINDOW_MS) stamps.shift();
    const perSecond = stamps.length / (RATE_WINDOW_MS / 1000);
    // ~5 keys a second is steady typing; ~11 is a real burst.
    const target = Math.max(0, Math.min(1, (perSecond - 5) / 6));
    energy += (target - energy) * 0.35;
    return energy;
  }

  function push(p) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push(p);
  }

  function pulse(caret, amount) {
    const y = caret.y + caret.h / 2;
    if (bloom && Math.abs(bloom.x - caret.x) < 40 && Math.abs(bloom.y - y) < 4) {
      bloom.amp = Math.min(1, bloom.amp * 0.6 + amount); // a run of keys keeps it warm, never blinding
    } else {
      bloom = { x: caret.x, y, h: caret.h, amp: amount };
    }
    bloom.x = caret.x; bloom.y = y; bloom.t = 0;
  }

  function sparks(caret, char, e) {
    const count = 3 + Math.round(e * 3) + (Math.random() < 0.35 ? 1 : 0) - (/\s/.test(char) ? 2 : 0);
    for (let i = 0; i < count; i++) {
      const second = Math.random() < 0.16 + e * 0.18;
      const angle = -Math.PI / 2 + rand(-1.15, 1.15);
      const speed = rand(22, 58) * (1 + e * 0.35);
      push({
        kind: 'spark',
        x: caret.x + rand(-1, 1.5),
        y: caret.y + caret.h * rand(0.25, 0.75),
        vx: Math.cos(angle) * speed + rand(4, 14), // a slight lean forward, the way the text grows
        vy: Math.sin(angle) * speed,
        g: -6, drag: 2.6,
        life: 0, max: rand(350, 600),
        size: rand(1.1, 2.3) * (1 + e * 0.12),
        bright: 0.95 + e * 0.3 + rand(0, 0.2),
        rgb: second ? palette.alt[Math.random() < 0.5 ? 0 : 1] : palette.accent,
      });
    }
  }

  function puff(caret) {
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      push({
        kind: 'dust',
        x: caret.x + rand(-2, 3),
        y: caret.y + caret.h * rand(0.35, 0.7),
        vx: rand(-14, 14), vy: rand(4, 18),
        g: 70, drag: 2,
        life: 0, max: rand(320, 460),
        size: rand(0.9, 1.5),
        bright: rand(0.3, 0.45),
        rgb: palette.ink,
      });
    }
  }

  function glint(lineNumber, fromColumn, toColumn, duration, strength) {
    const a = caretAt({ lineNumber, column: fromColumn });
    const b = caretAt({ lineNumber, column: toColumn });
    if (!a || !b || b.x - a.x < 4) return;
    sweeps.push({ x0: a.x, x1: b.x, y: a.y + a.h - 2.5, life: 0, max: duration, strength });
  }

  function spawn(event) {
    if (!palette) palette = readPalette();
    const now = performance.now();
    const e = momentum(now);
    const model = instance.getModel();
    const position = instance.getPosition();
    const caret = caretAt(position);
    if (!caret || !model) return;
    if (caret.x < clip.x - 2 || caret.x > clip.x + clip.w + 2 || caret.y < -caret.h || caret.y > height) return;

    if (event.kind === 'type') {
      sparks(caret, event.char, e);
      pulse(caret, 0.55 + e * 0.3);
      if (CLOSERS.has(event.char)) {
        rings.push({ x: caret.x, y: caret.y + caret.h / 2, r: caret.h * 0.55, life: 0, max: 340 });
      } else if (event.char === 'n') {
        // Finishing the word `return` earns the same glint a finished line does.
        const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        if (/(^|[^\w])return$/.test(before)) glint(position.lineNumber, position.column - 6, position.column, 260, 0.9);
      }
    } else if (event.kind === 'delete') {
      puff(caret);
      pulse(caret, 0.25);
    } else if (event.kind === 'enter') {
      // The line just finished gets a quick light run along its text, left to right.
      const done = position.lineNumber - 1;
      if (done >= 1) {
        const content = model.getLineContent(done);
        const first = content.search(/\S/);
        if (first >= 0) glint(done, first + 1, content.trimEnd().length + 1, 250, 1);
      }
      pulse(caret, 0.45);
    }
  }

  /* --------------------------------- frame --------------------------------- */

  function tick(now) {
    frame = 0;
    if (!enabled()) { clearAll(); return; }
    if (pending) { const event = pending; pending = null; spawn(event); }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const ms = dt * 1000;
    const dark = palette?.dark;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, 0, clip.w, height);
    ctx.clip();

    // Bloom first, under the sparks.
    if (bloom) {
      bloom.t += ms;
      const a = bloom.amp * Math.exp(-bloom.t / 210);
      if (a < 0.01) bloom = null;
      else {
        const sprite = glowSprite(palette.accent);
        const rx = bloom.h * 0.95, ry = bloom.h * 0.85;
        ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        ctx.globalAlpha = a * (dark ? 0.34 : 0.16);
        ctx.drawImage(sprite, bloom.x - rx, bloom.y - ry, rx * 2, ry * 2);
      }
    }

    for (let i = sweeps.length - 1; i >= 0; i--) {
      const s = sweeps[i];
      s.life += ms;
      const t = s.life / s.max;
      if (t >= 1.6) { sweeps.splice(i, 1); continue; }
      const head = s.x0 + (s.x1 - s.x0) * easeOut(Math.min(1, t));
      const tail = Math.max(s.x0, head - Math.max(28, (s.x1 - s.x0) * 0.55));
      const fade = t <= 1 ? 1 : 1 - (t - 1) / 0.6;
      const rgb = palette.accent.join(',');
      const grad = ctx.createLinearGradient(tail, 0, head, 0);
      grad.addColorStop(0, `rgba(${rgb},0)`);
      grad.addColorStop(1, `rgba(${rgb},${(dark ? 0.95 : 0.7) * s.strength * fade})`);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(tail, s.y, head - tail, 1.25);
      // A bright bead at the head while it travels.
      if (t < 1) {
        ctx.globalAlpha = (dark ? 0.7 : 0.4) * s.strength;
        ctx.drawImage(glowSprite(palette.accent), head - 7, s.y - 6.5, 14, 14);
      }
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life += ms;
      const t = r.life / r.max;
      if (t >= 1) { rings.splice(i, 1); continue; }
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      ctx.globalAlpha = (1 - t) * (1 - t) * (dark ? 0.5 : 0.4);
      ctx.strokeStyle = `rgb(${palette.accent.join(',')})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 1.5 + r.r * easeOut(t), 0, Math.PI * 2);
      ctx.stroke();
    }

    let alive = 0;
    for (const p of particles) {
      p.life += ms;
      if (p.life >= p.max) continue;
      particles[alive++] = p;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const t = p.life / p.max;
      // Quick in, long tail out: a spark is brightest just after it leaves the caret.
      const a = Math.min(1, t * 8) * (1 - t) * (1 - t) * p.bright;
      if (p.kind === 'spark') {
        ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        const glow = p.size * (dark ? 5 : 3.2);
        ctx.globalAlpha = Math.min(1, a * (dark ? 0.55 : 0.35));
        ctx.drawImage(glowSprite(p.rgb), p.x - glow, p.y - glow, glow * 2, glow * 2);
        ctx.globalAlpha = Math.min(1, a);
        ctx.fillStyle = `rgb(${p.rgb.join(',')})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5 * (1 - t * 0.4), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${p.rgb.join(',')})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    particles.length = alive;
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (particles.length || sweeps.length || rings.length || bloom || pending) frame = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, width, height);
  }

  return function dispose() {
    clearAll();
    for (const sub of subs) sub?.dispose?.();
    ro?.disconnect();
    reduceQuery?.removeEventListener?.('change', onReduce);
    document.removeEventListener('visibilitychange', onVisible);
    canvas.remove();
  };
}
