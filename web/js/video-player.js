// The Video tab of the problem pane: the problem's walkthrough, played in Studio.
//
// The player is YouTube's embed from youtube-nocookie.com, driven by postMessage to the
// iframe directly (the protocol YouTube's own IFrame API script speaks), so no third-party
// script ever runs in Studio's page. Nothing is requested from YouTube until the tab is
// first opened: no iframe, no script, no thumbnail. After that the iframe stays mounted
// while the learner switches tabs, so it neither reloads nor loses its place.
//
// What is remembered, in this browser's localStorage only:
//   studio.video.v1:<slug>   { t, d, at }  the position (seconds) and duration in one problem
//   studio.video.rate.v1     number        the playback rate, for every video
// The position is written at most every 5 s while playing, and on pause, on leaving the
// tab, on collapsing the pane and on pagehide. A video that reached its end starts again
// from the beginning next time.
//
// YouTube's terms require the player to be visible while it plays, so it is paused
// whenever it is hidden (another tab, a collapsed pane, another problem). If a pause is
// not confirmed, the iframe is unloaded rather than left playing out of sight.

import { el } from './dom.js';
import { icon } from './ui/icon.js';

const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
const READY_MS = 15000;          // no word from the player by then: it did not load
const HANDSHAKE_MS = 250;        // how often to say "listening" until the player answers
const SAVE_EVERY_MS = 5000;      // position writes while playing
const PAUSE_CONFIRM_MS = 1500;   // a hidden player still playing after this is unloaded
const END_MARGIN_S = 5;          // this close to the end counts as finished
const SHOWN_AFTER_MS = 600;      // ready this long without an error: the video is on screen

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const positionKey = slug => `studio.video.v1:${slug}`;
const RATE_KEY = 'studio.video.rate.v1';

/* --------------------------------- storage --------------------------------- */

export function readPosition(slug) {
  try {
    const saved = JSON.parse(localStorage.getItem(positionKey(slug)));
    if (!saved || !Number.isFinite(saved.t) || saved.t < 0) return null;
    return { t: saved.t, d: Number.isFinite(saved.d) && saved.d > 0 ? saved.d : null, at: saved.at ?? null };
  } catch { return null; }
}

function writePosition(slug, t, d) {
  try { localStorage.setItem(positionKey(slug), JSON.stringify({ t: Math.round(t * 10) / 10, d: d || null, at: Date.now() })); }
  catch { /* the player still works without storage */ }
}

export function readRate() {
  try {
    const rate = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(rate) && rate >= 0.25 && rate <= 2 ? rate : 1;
  } catch { return 1; }
}

function writeRate(rate) {
  try { if (Number.isFinite(rate) && rate > 0) localStorage.setItem(RATE_KEY, String(rate)); } catch { /* noop */ }
}

/** Where a saved position resumes: the start again once the video was (nearly) finished. */
export function resumeAt(saved) {
  if (!saved || !(saved.t >= 1)) return 0;
  if (saved.d && saved.t >= saved.d - END_MARGIN_S) return 0;
  return Math.floor(saved.t);
}

/* --------------------------------- adapter --------------------------------- */

// The embed origin. Browser checks substitute a local fake player that speaks the same
// protocol, by defining window.__STUDIO_VIDEO_EMBED__ before the page loads; only a
// loopback http origin is accepted, so the override cannot point the player anywhere else.
function embedTarget() {
  const override = globalThis.__STUDIO_VIDEO_EMBED__;
  if (override && typeof override.origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(override.origin)) {
    return {
      origin: override.origin,
      path: typeof override.path === 'string' && /^\/[\w/-]*\/$/.test(override.path) ? override.path : '/embed/',
      readyMs: Number.isFinite(override.readyMs) ? override.readyMs : READY_MS,
    };
  }
  return { origin: PLAYER_ORIGIN, path: '/embed/', readyMs: READY_MS };
}

export function embedUrl(target, videoId, start) {
  const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0', origin: location.origin });
  if (start > 0) params.set('start', String(start));
  return `${target.origin}${target.path}${encodeURIComponent(videoId)}?${params}`;
}

export function watchUrl(videoId, at = 0) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${at >= 1 ? `&t=${Math.floor(at)}s` : ''}`;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const ERRORS = {
  2: ['This video link is not valid', 'YouTube rejected the video id Studio has for this problem.'],
  5: ['The player could not play this video here', 'YouTube\'s player hit a playback error in this browser.'],
  100: ['This video is no longer available', 'YouTube says it was removed or made private.'],
  101: ['This video only plays on YouTube', 'Its owner does not allow it to be played inside other sites.'],
  150: ['This video only plays on YouTube', 'Its owner does not allow it to be played inside other sites.'],
};

/* ---------------------------------- the tab ---------------------------------- */

/**
 * The Video tab's panel and player. `panel` is the tabpanel element; the player is only
 * created by the first `setShown(true)`. `whenReady()` settles true once the player has
 * answered (the walkthrough is on screen), false if it failed.
 */
export function createVideoTab(entry) {
  const slug = entry.slug, videoId = entry.youtubeVideoId;
  let target = embedTarget();
  const panel = el('section', { class: 'card ref-tab video-tab', role: 'tabpanel', id: 'ref-video', 'aria-label': 'Video', dataset: { panel: 'video' } });
  const stage = el('div', { class: 'video-stage' });
  const meta = el('span', { class: 'video-meta', text: 'Video walkthrough' });
  const focusNote = el('span', { class: 'video-focus-note', role: 'status' });
  const link = el('a', {
    class: 'btn btn--quiet pane-link video-out', target: '_blank', rel: 'noopener noreferrer',
    href: watchUrl(videoId), 'aria-label': 'Open on YouTube (opens in a new tab)',
  }, [icon('external', 13), el('span', { text: 'Open on YouTube' })]);
  const bar = el('div', { class: 'video-bar' }, [el('div', { class: 'video-status' }, [meta, focusNote]), el('nav', { class: 'pane-links', 'aria-label': 'This video elsewhere' }, link)]);
  const body = el('div', { class: 'desc ref-body video-body' }, [stage, bar]);
  panel.append(body);

  let frame = null, iframe = null;
  let shown = false, disposed = false;
  let status = 'idle';            // idle · loading · ready · failed
  let handshake = 0, readyTimer = 0, pauseTimer = 0, settleTimer = 0, lastSave = 0;
  let player = { state: null, time: 0, duration: 0, rate: 1 };
  let resumeOnShow = false, rateWanted = readRate(), rateSettled = false, savedT = null;
  let readyWaiters = [];
  let sizer = null;

  const settle = value => { const waiters = readyWaiters; readyWaiters = []; for (const resolve of waiters) resolve(value); };

  function post(func, args = []) {
    if (!iframe?.contentWindow) return;
    try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), target.origin); }
    catch { /* a frame mid-navigation drops the message; the next one is resent */ }
  }

  function save(force = false) {
    if (status !== 'ready' || !(player.time >= 0)) return;
    const finished = player.state === STATE.ENDED || (player.duration && player.time >= player.duration - END_MARGIN_S);
    const t = finished ? 0 : player.time;
    if (!force && savedT !== null && Math.abs(t - savedT) < 1) return;
    savedT = t; lastSave = Date.now();
    writePosition(slug, t, player.duration);
  }

  function updateMeta() {
    const parts = ['Video walkthrough'];
    if (player.duration) parts.push(clock(player.duration));
    meta.textContent = parts.join(' · ');
    link.href = watchUrl(videoId, player.state === STATE.ENDED ? 0 : player.time);
  }

  // The player holds the keyboard while focus is inside it: Studio's shortcuts cannot
  // hear a key pressed in another origin's frame. Say so while it is true.
  function syncFocusNote() {
    const inside = !!iframe && document.activeElement === iframe;
    focusNote.textContent = inside ? 'The player has the keyboard. Click outside it to use Studio shortcuts.' : '';
  }
  const onWindowBlur = () => setTimeout(syncFocusNote, 0);
  const onWindowFocus = () => syncFocusNote();

  function onMessage(event) {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== target.origin) return;
    let data = event.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
    if (!data || typeof data !== 'object' || typeof data.event !== 'string') return;
    if (data.event === 'onError') { fail(Number(data.info)); return; }
    if (status === 'loading') becomeReady();
    const info = data.info && typeof data.info === 'object' ? data.info : null;
    if (!info) return;
    if (Number.isFinite(info.duration) && info.duration > 0) player.duration = info.duration;
    if (Number.isFinite(info.currentTime)) player.time = info.currentTime;
    if (Number.isFinite(info.playbackRate)) onRate(info.playbackRate, info.availablePlaybackRates);
    if (Number.isInteger(info.playerState) && info.playerState !== player.state) onState(info.playerState);
    if (player.state === STATE.PLAYING && Date.now() - lastSave >= SAVE_EVERY_MS) save();
    updateMeta();
  }

  function onRate(rate, available) {
    if (!rateSettled) {
      // Ours to set once; until the player reports the wanted rate, a 1x is its default.
      if (Math.abs(rate - rateWanted) < 0.01) { rateSettled = true; player.rate = rate; return; }
      if (Array.isArray(available) && available.length && !available.includes(rateWanted)) { rateSettled = true; player.rate = rate; return; }
      post('setPlaybackRate', [rateWanted]);
      return;
    }
    if (Math.abs(rate - player.rate) >= 0.01) { player.rate = rate; rateWanted = rate; writeRate(rate); }
  }

  function onState(state) {
    player.state = state;
    if (state === STATE.PAUSED || state === STATE.ENDED) save(true);
    if (state === STATE.PLAYING && !shown) post('pauseVideo'); // never out of sight
  }

  function becomeReady() {
    status = 'ready';
    clearInterval(handshake); clearTimeout(readyTimer);
    iframe.classList.add('is-ready');
    frame.classList.remove('is-loading');
    if (Math.abs(rateWanted - 1) < 0.01) rateSettled = true;
    // YouTube answers before it has looked the video up, and an embed it refuses still says
    // hello first, then reports the error: the walkthrough counts as shown a moment later.
    settleTimer = setTimeout(() => { if (status === 'ready') settle(true); }, SHOWN_AFTER_MS);
  }

  function fail(code) {
    save(true); // a player that failed mid-video keeps its place
    status = 'failed';
    clearInterval(handshake); clearTimeout(readyTimer); clearTimeout(pauseTimer); clearTimeout(settleTimer);
    unloadFrame();
    const [head, why] = code === 'offline'
      ? ['You are offline', 'The player loads from youtube-nocookie.com, which needs a connection.']
      : code === 'timeout'
        ? ['The player did not load', 'Studio could not reach YouTube\'s player at youtube-nocookie.com. It may be blocked on this network, or the connection dropped.']
        : ERRORS[code] || ['The player reported a problem', `YouTube's player stopped with error ${Number.isFinite(code) ? code : 'unknown'}.`];
    const retry = code === 'timeout' || code === 'offline' || code === 5;
    stage.replaceChildren(el('div', { class: 'state ui-inset ui-inset--roomy warn video-fallback', dataset: { reason: String(code) } }, [
      el('h3', { text: head }),
      el('p', { text: why }),
      el('p', { text: 'The walkthrough is still on YouTube.' }),
      el('div', { class: 'acts' }, [
        el('a', { class: 'btn btn--quiet act', href: watchUrl(videoId, resumeAt(readPosition(slug))), target: '_blank', rel: 'noopener noreferrer' }, [icon('external', 13), el('span', { text: 'Watch on YouTube' })]),
        retry ? el('button', { class: 'btn btn--quiet act', type: 'button', text: 'Try again', onclick: () => { status = 'idle'; mount(); } }) : null,
      ]),
    ]));
    bar.hidden = true;
    settle(false);
  }

  function unloadFrame() {
    if (iframe && document.activeElement === iframe) returnFocus();
    sizer?.disconnect(); sizer = null;
    iframe?.remove(); iframe = null; frame = null;
    player = { state: null, time: 0, duration: 0, rate: player.rate };
    rateSettled = false;
    syncFocusNote();
  }

  function mount() {
    if (disposed || status === 'loading' || status === 'ready') return;
    bar.hidden = false;
    if (!navigator.onLine) { fail('offline'); return; }
    status = 'loading';
    target = embedTarget();
    const saved = readPosition(slug);
    savedT = saved ? saved.t : null;
    const start = resumeAt(saved);
    player = { state: null, time: start, duration: saved?.d || 0, rate: 1 };
    rateWanted = readRate();
    rateSettled = false;
    iframe = el('iframe', {
      class: 'video-player', title: `Video walkthrough: ${entry.title || slug}`,
      src: embedUrl(target, videoId, start),
      allow: 'fullscreen; picture-in-picture; encrypted-media',
      allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'eager',
    });
    frame = el('div', { class: 'video-frame is-loading' }, [el('span', { class: 'video-loading', text: 'Loading the player' }), iframe]);
    stage.replaceChildren(frame);
    updateMeta();
    // "listening" until the player answers; YouTube ignores it until its page has loaded.
    const hello = () => { try { iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), target.origin); } catch { /* not loaded yet */ } };
    iframe.addEventListener('load', hello);
    handshake = setInterval(hello, HANDSHAKE_MS);
    readyTimer = setTimeout(() => { if (status === 'loading') fail('timeout'); }, target.readyMs);
    fit();
  }

  // As large as the pane allows: the frame's width is capped so its 16:9 height fits in
  // the pane's visible height under the tab row. Stacked (the page scrolls), the viewport.
  function fit() {
    const pane = panel.closest('.pcol');
    if (!pane || !frame) return;
    const measure = () => {
      if (!frame || !shown) return;
      const scrolls = /auto|scroll/.test(getComputedStyle(pane).overflowY);
      const paneBox = pane.getBoundingClientRect();
      const top = frame.getBoundingClientRect().top - paneBox.top + (scrolls ? pane.scrollTop : 0);
      const below = bar.offsetHeight + parseFloat(getComputedStyle(body).paddingBottom || '0') + parseFloat(getComputedStyle(body).rowGap || '0');
      const room = (scrolls ? pane.clientHeight - top : innerHeight - 160) - below;
      panel.style.setProperty('--video-fit-h', `${Math.max(180, Math.floor(room))}px`);
    };
    sizer?.disconnect();
    sizer = new ResizeObserver(measure);
    sizer.observe(pane);
    measure();
  }

  function returnFocus() {
    // Back to the page, never into a text field: the selected tab if it is showing.
    const tab = document.querySelector('.problem-tabs [role=tab][aria-selected=true]');
    if (tab && tab.getClientRects().length) tab.focus({ preventScroll: true });
    else { iframe?.blur(); document.body.focus?.({ preventScroll: true }); }
  }

  function setShown(next) {
    if (disposed) return;
    next = Boolean(next);
    if (next === shown) return;
    shown = next;
    clearTimeout(pauseTimer);
    if (shown) {
      if (status === 'idle') mount();
      else if (status === 'ready') {
        fit();
        if (resumeOnShow) post('playVideo'); // only what we paused ourselves
      }
      resumeOnShow = false;
      return;
    }
    // Hidden: pause, remember, and take the keyboard back.
    if (iframe && document.activeElement === iframe) returnFocus();
    syncFocusNote();
    if (status !== 'ready') return;
    const playing = player.state === STATE.PLAYING || player.state === STATE.BUFFERING;
    resumeOnShow = playing;
    post('pauseVideo');
    save(true);
    if (playing) {
      pauseTimer = setTimeout(() => {
        if (shown || status !== 'ready' || player.state !== STATE.PLAYING) return;
        // The pause never took: unload rather than play out of sight.
        save(true); status = 'idle'; resumeOnShow = false; unloadFrame();
      }, PAUSE_CONFIRM_MS);
    }
  }

  const onPageHide = () => save(true);
  const onVisibility = () => { if (document.visibilityState === 'hidden') save(true); };
  // The problem pane collapsing (⌘B, its rail button) hides the player.
  let collapsed = document.body.classList.contains('hide-problem');
  const observer = new MutationObserver(() => {
    const now = document.body.classList.contains('hide-problem');
    if (now === collapsed) return;
    collapsed = now;
    onPaneChange?.();
  });
  let onPaneChange = null;
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('message', onMessage);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    panel,
    setShown,
    onPaneToggle(fn) { onPaneChange = fn; },
    get status() { return status; },
    whenReady() {
      if (status === 'ready') return Promise.resolve(true);
      if (status === 'failed') return Promise.resolve(false);
      return new Promise(resolve => readyWaiters.push(resolve));
    },
    dispose() {
      if (disposed) return;
      save(true);
      if (shown && iframe && document.activeElement === iframe) returnFocus();
      disposed = true; shown = false;
      clearInterval(handshake); clearTimeout(readyTimer); clearTimeout(pauseTimer); clearTimeout(settleTimer);
      observer.disconnect(); sizer?.disconnect();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      iframe?.remove(); iframe = null;
      settle(false);
    },
  };
}
