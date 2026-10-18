// Pictures the coach asks for: a ```image block becomes one Codex-painted image.
//
// The block is model output, so it is only ever read as data: a prompt and an alt
// line, both shown as text. The painting happens on the server, in a Codex job that
// can do nothing but draw (server/coach/visuals.mjs); this file only asks for it,
// waits honestly, and shows what came back.
//
// Three rules shape it.
//
//   1. A picture spends the user's image allowance, so nothing here paints on its own
//      except a reply that is arriving right now, with Settings on Auto. Re-opening a
//      thread, replaying history or re-rendering a message only *looks up* a picture;
//      one that was never painted gets a button, not a job.
//   2. Waiting is shown as waiting: elapsed time, and a hard stop after which we say
//      we stopped watching. Never a spinner that can hang.
//   3. A failure says what failed and offers to try again. It never shows a broken
//      image or an empty frame.

import { el, replace } from './dom.js';
import { requestVisual, visualStatus, visualId } from './api.js';
import { getSettings } from './settings.js';

const POLL_MS = 2000;
const WATCH_CAP_MS = 5 * 60 * 1000;
const MAX_PROMPT = 2000;

/* ============================== shaping (pure) ============================== */

/**
 * Read a ```image block.
 * @returns {{ok:true, prompt:string, alt:string}|{ok:false, reason:string}}
 */
export function parseImageBlock(code) {
  let value;
  try { value = JSON.parse(String(code ?? '')); }
  catch { return { ok: false, reason: 'The picture request was not valid JSON, so here is what the coach wrote.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'The picture request was not an object with a "prompt", so here is what the coach wrote.' };
  }
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: 'The picture request had no "prompt", so here is what the coach wrote.' };
  if (prompt.length > MAX_PROMPT) {
    return { ok: false, reason: `The picture description was ${prompt.length} characters; the limit is ${MAX_PROMPT}, so here is what the coach wrote.` };
  }
  const alt = typeof value.alt === 'string' ? value.alt.trim().slice(0, 300) : '';
  return { ok: true, prompt, alt };
}

/** `75000` → `1:15`. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ============================== one watcher per picture ============================== */

// Two cards can show the same picture (a reply re-rendered while streaming, the same
// block in a replayed thread). They share one poll rather than each running their own.
const watchers = new Map();

function watcherFor(slug, id) {
  const key = `${slug}/${id}`;
  if (!watchers.has(key)) watchers.set(key, { slug, id, state: null, listeners: new Set(), timer: null, since: 0 });
  return watchers.get(key);
}

function publish(w, state) {
  w.state = state;
  for (const fn of [...w.listeners]) fn(state);
}

function stopPolling(w) { clearTimeout(w.timer); w.timer = null; }

function poll(w) {
  if (w.timer) return;
  w.since ||= Date.now();
  const tick = async () => {
    w.timer = null;
    if (!w.listeners.size) { w.since = 0; return; }   // nobody is looking any more
    if (Date.now() - w.since > WATCH_CAP_MS) {
      publish(w, { status: 'gave-up' });
      w.since = 0;
      return;
    }
    const result = await visualStatus(w.slug, w.id);
    if (!result.ok) { publish(w, { status: 'failed', message: result.message }); w.since = 0; return; }
    publish(w, result.data);
    if (result.data.status === 'queued' || result.data.status === 'drawing') w.timer = setTimeout(tick, POLL_MS);
    else w.since = 0;
  };
  w.timer = setTimeout(tick, POLL_MS);
}

async function ask(w, prompt, alt, retry) {
  publish(w, { status: 'queued' });
  const result = await requestVisual(w.slug, prompt, { alt, retry });
  if (!result.ok) { publish(w, { status: 'failed', message: result.message }); return; }
  publish(w, result.data);
  if (result.data.status === 'queued' || result.data.status === 'drawing') poll(w);
}

/* ============================== the card ============================== */

/**
 * @param {string} code the block's body
 * @param {{slug?:string|null, live?:boolean}} options live: this reply is arriving now
 * @returns {HTMLElement|null} null when the block is unreadable (the caller shows its source)
 */
export function renderImageCard(code, { slug = null, live = false } = {}) {
  const block = parseImageBlock(code);
  if (!block.ok) return null;
  const { prompt, alt } = block;

  const status = el('span', { class: 'pic-status mono dim' });
  const stage = el('div', { class: 'pic-stage' });
  const asked = el('details', { class: 'pic-asked' }, [
    el('summary', { class: 'mono dim', text: 'What the coach asked for' }),
    el('p', { text: prompt }),
  ]);
  const card = el('figure', { class: 'ill pic', 'aria-label': alt || 'A picture from the coach' }, [
    el('figcaption', { class: 'pic-head' }, [el('span', { class: 'mono dim', text: 'Picture · Codex' }), status]),
    stage,
    alt ? el('div', { class: 'ill-note pic-alt', text: alt }) : null,
    asked,
  ]);

  if (!slug) {
    status.textContent = 'not available here';
    replace(stage, el('div', { class: 'pic-offer' }, el('p', { class: 'dim', text: 'Pictures are painted on the problem page.' })));
    return card;
  }

  let w = null;
  let ticker = null;
  const stopTicker = () => { clearInterval(ticker); ticker = null; };

  const offer = (lead) => {
    status.textContent = '';
    replace(stage, el('div', { class: 'pic-offer' }, [
      el('p', { class: 'dim', text: lead }),
      el('button', { class: 'act pic-go', type: 'button', text: 'Paint this picture', onclick: () => ask(w, prompt, alt, false) }),
      el('span', { class: 'mono dim pic-cost', text: 'about 30–60 s · uses your ChatGPT image allowance' }),
    ]));
  };

  const waiting = (state) => {
    const startedAt = Date.now() - (Number(state.elapsedMs) || 0);
    const label = el('span', { class: 'mono' });
    const paintLabel = () => {
      const verb = state.status === 'queued' ? 'Waiting for the painter' : 'Painting with Codex';
      label.textContent = `${verb} · ${clock(Date.now() - startedAt)}`;
    };
    paintLabel();
    stopTicker();
    ticker = setInterval(() => { if (!card.isConnected) return; paintLabel(); }, 1000);
    status.textContent = '';
    replace(stage, el('div', { class: 'pic-wait', role: 'status' }, [el('i', { class: 'pic-shimmer' }), label]));
  };

  const ready = (state) => {
    stopTicker();
    status.textContent = '';
    const img = el('img', { class: 'pic-img', src: state.url, alt: alt || 'Picture from the coach', decoding: 'async' });
    img.addEventListener('error', () => failed({ message: 'The picture file could not be loaded from the studio server.' }), { once: true });
    replace(stage, el('button', { class: 'pic-open', type: 'button', title: 'Open larger', onclick: () => openLightbox(state.url, alt) }, img));
  };

  const failed = (state) => {
    stopTicker();
    status.textContent = '';
    replace(stage, el('div', { class: 'state warn pic-failed' }, [
      el('h3', { text: state.status === 'gave-up' ? 'Stopped waiting for the picture' : 'The picture was not painted' }),
      el('p', { text: state.status === 'gave-up'
        ? 'Five minutes passed without a picture. Codex may still finish it; trying again picks it up if it did.'
        : (state.message || 'Codex did not return a picture.') }),
      el('div', { class: 'acts' }, el('button', { class: 'act', type: 'button', text: 'Try again', onclick: () => ask(w, prompt, alt, true) })),
    ]));
  };

  const show = (state) => {
    if (!state) return;
    if (state.status === 'ready' && state.url) return ready(state);
    if (state.status === 'queued' || state.status === 'drawing') return waiting(state);
    if (state.status === 'failed' || state.status === 'gave-up') return failed(state);
    // missing: never painted. Only a live reply under Auto paints by itself.
    const mode = getSettings().coachPictures;
    if (live && mode === 'auto') { ask(w, prompt, alt, false); return; }
    offer(mode === 'off'
      ? 'Pictures are off in Settings. The description is below if you want it anyway.'
      : 'The coach suggested a picture here.');
  };

  status.textContent = 'looking it up';
  replace(stage, el('div', { class: 'pic-wait' }, [el('i', { class: 'pic-shimmer' }), el('span', { class: 'mono', text: 'Looking for this picture' })]));

  visualId(slug, prompt).then(async (id) => {
    w = watcherFor(slug, id);
    w.listeners.add(show);
    // Detached cards stop listening; the reply re-renders often while streaming and
    // reattaches the same node, so give it a moment before letting go.
    const sweep = setInterval(() => {
      if (card.isConnected) { card.dataset.seen = String(Date.now()); return; }
      if (Date.now() - Number(card.dataset.seen || 0) > 15000) { w.listeners.delete(show); stopTicker(); clearInterval(sweep); }
    }, 5000);
    card.dataset.seen = String(Date.now());

    if (w.state && w.state.status !== 'missing') { show(w.state); if (w.state.status === 'queued' || w.state.status === 'drawing') poll(w); return; }
    const result = await visualStatus(slug, id);
    if (!result.ok) {
      // An older server without the route: say so plainly rather than offering a button that cannot work.
      publish(w, { status: 'failed', message: result.message });
      return;
    }
    publish(w, result.data);
    if (result.data.status === 'queued' || result.data.status === 'drawing') poll(w);
  }).catch(() => failed({ message: 'This browser could not compute the picture id (it needs a secure context).' }));

  return card;
}

/* ============================== lightbox ============================== */

function openLightbox(url, alt) {
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation(); event.preventDefault();
    close();
  };
  const box = el('div', { class: 'pic-lightbox', role: 'dialog', 'aria-label': alt || 'Picture', onclick: close }, [
    el('img', { src: url, alt: alt || 'Picture from the coach' }),
    alt ? el('p', { text: alt }) : null,
    el('button', { class: 'ws-mini pic-close', type: 'button', text: 'Close esc', onclick: close }),
  ]);
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  box.querySelector('.pic-close').focus();
}
