// Real browser checks for roadmap interaction, data integrity, themes, and narrow screens.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const profile = await mkdtemp(path.join(os.tmpdir(), 'studio-map-check-'));
const origin = process.env.STUDIO_ORIGIN || 'http://127.0.0.1:4196';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9352', `--user-data-dir=${profile}`,
  '--window-size=1600,1000', 'about:blank',
], {stdio: 'ignore'});
let ws;
try {
  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9352/json')).json(); break; }
    catch { await sleep(100); }
  }
  const page = targets?.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome remote debugging page did not start');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, {once: true}));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id; pending.set(requestId, resolve);
    ws.send(JSON.stringify({id: requestId, method, params}));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.result?.exceptionDetails) throw Error(result.result.exceptionDetails.exception?.description);
    return result.result?.result?.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw Error(`Timed out: ${expression}`);
  };
  const navigateRoadmap = async () => {
    await send('Page.navigate', {url: `${origin}/#/roadmap`});
    await until(`document.querySelectorAll('.roadmap-node').length===18`);
    await until(`!document.querySelector('.roadmap').innerText.includes('Loading saved activity')`);
  };

  await send('Page.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});
  await send('Page.navigate', {url: `${origin}/#/`});
  await until(`Boolean(document.querySelector('.tree-pattern'))`);
  await evaluate(`(async()=>{const {setSetting}=await import('/js/settings.js');setSetting('theme','slate');})()`);
  const flash = await evaluate(`(async()=>{let min=1;document.querySelector('.tree-pattern').click();for(let i=0;i<18;i++){await new Promise(requestAnimationFrame);min=Math.min(min,Number(getComputedStyle(document.querySelector('.view')).opacity));}return min;})()`);
  if (flash !== 1) throw Error(`Catalog fades out after click: ${flash}`);

  await navigateRoadmap();
  await until(`document.querySelector('.graph-percentage').textContent.length > 0`);
  const integrity = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.roadmap-node')];const text=document.body.innerText;const sums=[...document.querySelectorAll('.node-meta')].map(n=>Number.parseInt(n.textContent,10));return {nodes:nodes.length,sums:sums.reduce((a,b)=>a+b,0),nullText:/\\bnull\\b/i.test(text),empty:[...document.querySelectorAll('.roadmap *')].some(n=>n.childNodes.length===1&&n.textContent.trim()==='null')};})()`);
  if (integrity.nodes !== 18 || integrity.sums !== 250 || integrity.nullText || integrity.empty) throw Error(`Roadmap data integrity failed: ${JSON.stringify(integrity)}`);
  await evaluate(`[...document.querySelectorAll('.roadmap-chips .chip')].find(button=>button.textContent.trim()==='NeetCode 150').click()`); await sleep(120);
  const n150 = await evaluate(`[...document.querySelectorAll('.node-meta')].reduce((sum,node)=>sum+Number.parseInt(node.textContent,10),0)`);
  if (n150 !== 150) throw Error(`NeetCode 150 total is ${n150}`);
  await evaluate(`[...document.querySelectorAll('.roadmap-chips .chip')].find(button=>button.textContent.trim()==='NeetCode 250').click()`); await sleep(120);
  const n250 = await evaluate(`[...document.querySelectorAll('.node-meta')].reduce((sum,node)=>sum+Number.parseInt(node.textContent,10),0)`);
  if (n250 !== 250) throw Error(`NeetCode 250 total after return is ${n250}`);
  const first = await evaluate(`(()=>{const node=document.querySelectorAll('.roadmap-node')[4];node.click();return {connected:node.isConnected,selected:document.querySelectorAll('.roadmap-node.selected').length,detail:document.querySelector('.roadmap-detail h2')?.textContent.trim(),label:node.querySelector('.node-title')?.textContent.trim()};})()`);
  if (!first.connected || first.selected !== 1 || !first.detail || first.detail !== first.label) throw Error(`Selection/detail mismatch: ${JSON.stringify(first)}`);
  const transform = await evaluate(`(()=>{const c=document.querySelector('.roadmap-canvas');const before=c.style.transform;document.querySelector('[aria-label="Zoom in"]').click();return [before,c.style.transform];})()`);
  if (!transform[1] || transform[0] === transform[1]) throw Error('Zoom in did not change canvas transform');

  for (const theme of ['paper', 'editorial', 'ink', 'slate', 'blueprint', 'phosphor']) {
    await evaluate(`(async()=>{const {setSetting}=await import('/js/settings.js');setSetting('theme',${JSON.stringify(theme)});})()`);
    await until(`document.querySelectorAll('.roadmap-node').length===18`);
    for (const width of [390, 768, 1140, 1600]) {
      await send('Emulation.setDeviceMetricsOverride', {width, height: 1000, deviceScaleFactor: 2, mobile: false});
      await sleep(80);
      if (await evaluate('document.documentElement.scrollWidth > innerWidth')) throw Error(`Document overflow at ${theme}/${width}`);
    }
    await evaluate(`document.querySelector('.graph-btn.fit').click()`); await sleep(250);
    const fitted = await evaluate(`(()=>{const v=document.querySelector('.roadmap-viewport').getBoundingClientRect();return [...document.querySelectorAll('.roadmap-node')].every(n=>{const r=n.getBoundingClientRect();return r.left>=v.left-1&&r.right<=v.right+1&&r.top>=v.top-1&&r.bottom<=v.bottom+1;});})()`);
    if (!fitted) throw Error(`Fit clips nodes in ${theme}`);
  }
  await send('Page.navigate',{url:origin+'/#/p/binary-search'});
  await until(`Boolean(document.querySelector('.ws-run') && window.monaco?.editor.getModels().length && document.querySelector('.desc')?.innerText.includes('sorted'))`);
  const emptyRun=await evaluate(`(()=>{return !document.querySelector('.attempt-evidence')&&!document.querySelector('.desc .state.err');})()`);
  if(!emptyRun)throw Error('Empty run takes height or cached description did not load');
  await navigateRoadmap();
  await evaluate(`window.originalMapFetch=window.fetch;window.fetch=(input,options)=>String(input)==='/api/problems/binary-search'?Promise.resolve(new Response(JSON.stringify({error:{code:'DEMO_CONTENT_UNAVAILABLE',message:'No cached statement.'}}),{status:503,headers:{'content-type':'application/json'}})):window.originalMapFetch(input,options);location.hash='#/p/binary-search'`);
  await until(`document.querySelector('.desc .state h3')?.textContent==='Description unavailable'`);
  const concise=await evaluate(`(()=>{const state=document.querySelector('.desc .state');return !state.innerText.includes('Everything else')&&state.querySelectorAll('.act').length===1&&state.querySelector('.act').textContent.includes('LeetCode');})()`);
  if(!concise)throw Error('Demo fallback repeats error prose or offers a useless retry');
  await evaluate(`window.fetch=window.originalMapFetch;delete window.originalMapFetch`);
  await navigateRoadmap();
  await evaluate(`(async()=>{const {setSetting}=await import('/js/settings.js');setSetting('theme','slate');})()`);
  await evaluate(`document.querySelector('.detail-close')?.click();window.scrollTo({top:0,behavior:'instant'});document.querySelector('.graph-btn.fit').click()`);

  const screenshot = await send('Page.captureScreenshot', {format: 'png'});
  await writeFile('docs/images/roadmap.png', Buffer.from(screenshot.result.data, 'base64'));
  console.log('Roadmap checks passed: integrity, selection, zoom, fit, six themes, and 390/768/1140/1600 widths.');
} finally {
  ws?.close(); chrome.kill(); await sleep(200);
  await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
