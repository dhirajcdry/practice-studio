// A local stand-in for YouTube's embed player, for browser checks and the visual audit.
//
// It speaks the same postMessage protocol as https://www.youtube-nocookie.com/embed/<id>
// with enablejsapi=1 (verified against the real player): the page says
// {"event":"listening"} and the player answers with "initialDelivery" and "onReady", then
// "infoDelivery" updates (currentTime about every 250 ms while playing, playerState on a
// change, playbackRate) and "onError" with YouTube's codes. Commands arrive as
// {"event":"command","func":"playVideo"|"pauseVideo"|"seekTo"|"setPlaybackRate",...}.
//
// Paths choose a behaviour, so a check can exercise every branch without the network:
//   /embed/<id>         a playable 5-minute video
//   /error/<code>/<id>  says hello, then reports that error (YouTube does the same for 150)
//   /silent/<id>        loads but never answers, like a blocked or broken embed
//   /stubborn/<id>      plays but ignores pauseVideo
//   /refuse/<id>        drops the connection, as when offline or blocked (an error page)
// Its Play button and Shift+. / Shift+, (speed) stand in for the learner using the player.
// It is served on its own loopback port so the player is a real cross-origin frame.

import http from 'node:http';

const PAGE = String.raw`<!doctype html><meta charset="utf-8"><title>Demo player</title>
<style>
  html,body{margin:0;height:100%;background:#15171a;color:#e8e8e8;font:14px/1.4 system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
  button{font:600 15px system-ui,sans-serif;padding:10px 22px;border-radius:999px;border:0;background:#e8e8e8;color:#15171a;cursor:pointer}
  #time{font-variant-numeric:tabular-nums;opacity:.8}
</style>
<div id="title">Demo walkthrough</div>
<button id="toggle" type="button">Play</button>
<div id="time">0:00 / 5:00</div>
<script>
const params = new URLSearchParams(location.search);
const parentOrigin = params.get('origin');
const parts = location.pathname.split('/').filter(Boolean);
const mode = parts[0], errorCode = mode === 'error' ? Number(parts[1]) : null;
const videoId = parts[parts.length - 1];
const DURATION = 300;
const player = { state: 5, time: Number(params.get('start')) || 0, rate: 1 };
let listening = false, ticker = 0;
window.__fake = { player, commands: [] };
const send = (event, info) => parent.postMessage(JSON.stringify({ event, info, id: 1, channel: 'widget' }), parentOrigin);
const clock = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function paint() {
  document.getElementById('toggle').textContent = player.state === 1 ? 'Pause' : 'Play';
  document.getElementById('time').textContent = clock(player.time) + ' / ' + clock(DURATION);
}
function setState(state) {
  if (player.state === state) return;
  player.state = state;
  clearInterval(ticker);
  if (state === 1) ticker = setInterval(() => {
    player.time = Math.min(DURATION, player.time + 0.25 * player.rate);
    if (player.time >= DURATION) { setState(0); return; }
    send('infoDelivery', { currentTime: player.time, playbackRate: player.rate });
    paint();
  }, 250);
  send('infoDelivery', { playerState: state, currentTime: player.time, duration: DURATION, playbackRate: player.rate });
  paint();
}
document.getElementById('toggle').addEventListener('click', () => setState(player.state === 1 ? 2 : 1));
// Shift+. / Shift+, change the speed, as in YouTube's own player.
addEventListener('keydown', event => {
  if (event.key !== '>' && event.key !== '<') return;
  player.rate = Math.max(0.25, Math.min(2, player.rate + (event.key === '>' ? 0.25 : -0.25)));
  send('infoDelivery', { playbackRate: player.rate });
});
addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin) return;
  let data; try { data = JSON.parse(event.data); } catch { return; }
  if (mode === 'silent') return;
  if (data.event === 'listening') {
    if (listening) return;
    listening = true;
    send('initialDelivery', { playerState: player.state, currentTime: player.time, duration: DURATION, playbackRate: player.rate,
      availablePlaybackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], videoData: { video_id: videoId, title: 'Demo walkthrough' } });
    send('onReady', null);
    if (errorCode) setTimeout(() => send('onError', errorCode), 50);
    return;
  }
  if (data.event !== 'command' || errorCode) return;
  window.__fake.commands.push(data.func);
  if (data.func === 'playVideo') setState(1);
  else if (data.func === 'pauseVideo' && mode !== 'stubborn') setState(2);
  else if (data.func === 'seekTo') { player.time = Number(data.args?.[0]) || 0; send('infoDelivery', { currentTime: player.time }); paint(); }
  else if (data.func === 'setPlaybackRate') { player.rate = Number(data.args?.[0]) || 1; send('infoDelivery', { playbackRate: player.rate }); }
});
paint();
</script>`;

/** Start the fake player on an ephemeral loopback port. `requests` lists every path asked for. */
export async function startFakeYouTube() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    if (url.pathname.startsWith('/refuse/')) { request.socket.destroy(); return; }
    if (!/^\/(embed|silent|stubborn|error\/\d+)\/[\w-]+$/.test(url.pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(PAGE);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    /** The page script that points Studio's player adapter at this fake. */
    inject: (extra = {}) => `window.__STUDIO_VIDEO_EMBED__ = ${JSON.stringify({ origin, ...extra })};`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
