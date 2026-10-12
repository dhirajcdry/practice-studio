// Actual app screenshots with original fixtures, real Python runs, and scripted coaching.
// --serve keeps a disposable demo open for manual exploration. Default captures and exits.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { SLUG, WRONG_CODE, CODE, EXPLANATION, seedDemo } from './demo/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.STUDIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const serve = process.argv.includes('--serve');
const port = Number(process.env.STUDIO_DEMO_PORT || 4196);
let debugPort = Number(process.env.STUDIO_DEMO_CDP_PORT || 0);
const demoToken = crypto.randomUUID();
const origin = `http://127.0.0.1:${port}`;
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-demo-'));
const demoRoot = path.join(work, 'workspace');
const output = path.join(ROOT, 'docs', 'images');
let server, chrome, ws;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(message);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(2000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
async function cleanup() {
  ws?.close();
  await stop(chrome);
  await stop(server);
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; cleanup().then(() => process.exit(0)); });

try {
  const { id } = await seedDemo(demoRoot);
  server = spawn(process.execPath, ['scripts/demo/server.mjs'], {
    cwd: ROOT, env: { ...process.env, STUDIO_HOME: demoRoot, STUDIO_PORT: String(port),
      STUDIO_COACH_BINARY: path.join(ROOT, 'scripts', 'demo', 'coach.mjs'), STUDIO_MIRROR_DIR: '', STUDIO_DEMO_TOKEN: demoToken },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError = (serverError + chunk).slice(-3000); });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(serverError || 'Demo server exited');
    try { return (await (await fetch(`${origin}/api/demo`)).json()).token === demoToken; } catch { return false; }
  }, 'Demo server did not start');
  if (serve) {
    console.log(`Illustrative demo · scripted coach · disposable workspace\n${origin}/showcase/showcase.html\n${origin}/#/p/${SLUG}\n${origin}/#/design/${id}\nPress Ctrl-C to stop and remove demo data.`);
    await once(server, 'exit');
    if (!interrupted) throw new Error('Demo server stopped unexpectedly');
  } else {
    await fsp.access(CHROME);
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(work, 'chrome')}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
    chrome.on('error', (error) => console.error(error.message));
    // Trust only the DevTools endpoint written by our fresh, unique Chrome profile.
    await until(async () => {
      try {
        const active = await fsp.readFile(path.join(work, 'chrome', 'DevToolsActivePort'), 'utf8');
        debugPort = Number(active.split('\n')[0]);
        return debugPort > 0;
      } catch { return false; }
    }, 'Our Chrome profile did not expose a DevTools endpoint');
    let target;
    await until(async () => {
      try {
        target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page');
        return Boolean(target);
      } catch { return false; }
    }, 'Chrome did not expose a capture target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer); pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.exceptionDetails));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    // Demo capture must not fetch live content, submit, or transcribe. Browser fixture
    // navigation is confined to this server; the scripted CLI never uses the network.
    await send('Network.setBlockedURLs', { urls: ['https://*', 'http://leetcode.com/*',
      `${origin}/api/submit*`, `${origin}/api/asr*`] });
    // Retina master images for the checked-in showcase screenshots.
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      if (!localStorage.getItem('studio.settings.v1')) localStorage.setItem('studio.settings.v1', JSON.stringify({ theme:'slate', codeSize:16, motion:false }));
    ` });
    await send('Page.navigate', { url: `${origin}/#/p/${SLUG}` });
    await until(() => evaluate(`Boolean(window.monaco?.editor.getModels().length && document.querySelector('.ws-run'))`), 'Editor did not mount');
    await evaluate(`document.body.classList.add('coach-open'); document.body.classList.remove('hide-problem');`);
    if (!await evaluate(`(() => {
      const host=document.querySelector('.ws-host').getBoundingClientRect();
      const bar=document.querySelector('.ws>.ws-bar').getBoundingClientRect();
      const summary=document.querySelector('.attempt-evidence');
      return bar.top >= host.bottom - 1 && summary.hidden && summary.getBoundingClientRect().height === 0
        && !document.querySelector('.prail a[href*="youtube.com"]');
    })()`)) throw new Error('Run controls must follow the editor; walkthrough link must be absent');

    await fsp.mkdir(output, { recursive: true });
    async function shot(name) {
      await evaluate('document.fonts.ready'); await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(output, name);
      await fsp.writeFile(file, Buffer.from(data, 'base64'));
      return file;
    }
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(WRONG_CODE)})`);
    await evaluate(`document.querySelector('.ws-run').click()`);
    await until(() => evaluate(`!document.querySelector('.ws-run').disabled && document.querySelectorAll('.rr-case').length === 2 && document.querySelectorAll('.rr-case')[0].classList.contains('k-pass') && document.querySelectorAll('.rr-case')[1].classList.contains('k-fail')`), 'First run did not report the intended failure');
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(CODE)})`);
    await evaluate(`document.querySelector('.ws-run').click()`);
    await until(() => evaluate(`!document.querySelector('.ws-run').disabled && /All 2 cases passed/.test(document.body.innerText)`), 'Corrected code did not pass both actual local cases');
    if (!await evaluate(`document.querySelectorAll('.evidence-case.pass').length === 2 && !document.querySelector('.attempt-evidence').classList.contains('is-stale')`)) throw new Error('Live evidence did not reflect the real run');
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(CODE + '\n# edit after run')})`);
    if (!await evaluate(`document.querySelector('.attempt-evidence').classList.contains('is-stale')`)) throw new Error('Edited code presented old evidence as current');
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(CODE)})`);
    if (!await evaluate(`!document.querySelector('.attempt-evidence').classList.contains('is-stale')`)) throw new Error('Restored code did not match its run evidence');
    await shot('local-run.png');
    await until(() => evaluate(`Boolean(document.querySelector('.coach-compose textarea'))`), 'Coach composer did not mount');
    // Check the untouched starter state before the scripted conversation replaces it.
    await send('Emulation.setDeviceMetricsOverride', { width:1140, height:800, deviceScaleFactor:2, mobile:false });
    await evaluate(`document.querySelector('[data-workspace="focus"]').click()`); await sleep(100);
    const emptyCoach = await evaluate(`(() => {
      const rect = selector => { const node=document.querySelector(selector); if (!node) return null; const r=node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const first=document.querySelector('.coach-empty')?.firstElementChild?.getBoundingClientRect();
      return {log:rect('.coach-log'),compose:rect('.coach-compose'),actions:rect('.coach-actions'),firstTop:first?.top ?? null};
    })()`);
    if (!emptyCoach.log || emptyCoach.log.height < 80 || !emptyCoach.compose || !emptyCoach.actions || emptyCoach.compose.bottom > 800 || emptyCoach.actions.bottom > emptyCoach.compose.bottom + 1 || (emptyCoach.firstTop !== null && emptyCoach.firstTop < emptyCoach.log.top - 1)) {
      throw new Error(`Empty coach state is clipped or unusable: ${JSON.stringify(emptyCoach)}`);
    }
    await shot('coach-empty.png');
    await send('Emulation.setDeviceMetricsOverride', { width:1600, height:1000, deviceScaleFactor:2, mobile:false });
    await evaluate(`document.querySelector('[data-workspace="workbench"]').click()`); await sleep(100);
    await evaluate(`(() => {
      const input = document.querySelector('.coach-compose textarea');
      input.value = ${JSON.stringify(EXPLANATION)};
      input.dispatchEvent(new Event('input', { bubbles:true }));
    })()`);
    await evaluate(`document.querySelector('.coach-send').click()`);
    await until(() => evaluate(`/Your next explanation/.test(document.querySelector('.coach-log')?.innerText || '') && !document.querySelector('.coach-send').disabled`), 'Scripted coach did not finish');
    const asks = await evaluate(`document.querySelectorAll('.coach-log .cmsg.you').length`);
    if (asks !== 1) throw new Error(`One submitted question rendered ${asks} times`);
    await evaluate(`document.body.classList.add('hide-problem'); document.querySelector('.coach-log').scrollTop = 0`);
    await shot('coach.png');
    // The same attempt in every built-in theme: only appearance changes.
    const themes = await evaluate(`(async () => {
      const { THEMES } = await import('/js/settings.js');
      return THEMES.map(({ id, name }) => ({ id, name }));
    })()`);
    for (const theme of themes) {
      await evaluate(`(async () => {
        const { setSetting } = await import('/js/settings.js');
        setSetting('theme', ${JSON.stringify(theme.id)});
      })()`);
      await until(() => evaluate(`document.body.classList.contains('theme-${theme.id}') && window.monaco.editor.getModels().length > 0`), `${theme.name} did not apply`);
      await shot(`theme-${theme.id}.png`);
    }
    // Put a real edit on Monaco's undo stack before rearranging the panes.
    await evaluate(`(() => {
      const m = window.monaco.editor.getModels()[0];
      m.pushStackElement();
      m.pushEditOperations([], [{range:new window.monaco.Range(1,1,1,1),text:'# layout check\\n'}], () => []);
      m.pushStackElement();
    })()`);
    // Change views through the actual controls. A rearrangement must preserve the
    // editor's identity, undo history, code, and the existing conversation.
    await evaluate(`(async () => { const { setSetting } = await import('/js/settings.js'); setSetting('theme', 'slate'); })()`);
    const chosenTheme = await evaluate(`document.body.className.match(/theme-([\\w-]+)/)?.[1]`);
    const beforeView = await evaluate(`({id:window.monaco.editor.getModels()[0].id,code:window.monaco.editor.getModels()[0].getValue(),chat:document.querySelector('.coach-log').textContent})`);
    for (const view of ['focus', 'review', 'workbench']) {
      await evaluate(`document.querySelector('[data-workspace="${view}"]').click()`);
      await sleep(200);
      const state = await evaluate(`(() => {
        const model=window.monaco.editor.getModels()[0];
        const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
        return {id:model.id,code:model.getValue(),chat:document.querySelector('.coach-log').textContent,
          view:document.body.classList.contains('workspace-${view}'), editor:bounds('.ws'), problem:bounds('.pcol'),coach:bounds('.coach'),host:bounds('.ws-host'),
          overflow:document.documentElement.scrollWidth>innerWidth,hidden:document.body.classList.contains('hide-problem')};
      })()`);
      if (state.id!==beforeView.id || state.code!==beforeView.code || state.chat!==beforeView.chat || !state.view || state.overflow || state.host.height<150) throw new Error(`View lost state or overflows: ${view} ${JSON.stringify(state)}`);
      if (!await evaluate(`document.body.classList.contains('theme-${chosenTheme}')`)) throw new Error(`${view} changed the chosen theme`);
      if (view==='focus' && !state.hidden) throw new Error('Focus did not hide the problem');
      const spacing = await evaluate(`(() => {
        const summary=document.querySelector('.attempt-evidence').getBoundingClientRect();
        const bar=document.querySelector('.ws>.ws-bar').getBoundingClientRect();
        const editor=document.querySelector('.ws').getBoundingClientRect();
        return {top:summary.top-bar.bottom,left:summary.left-editor.left,right:editor.right-summary.right};
      })()`);
      if (spacing.top<8 || spacing.left<12 || spacing.right<12) throw new Error(`Cramped ${view} footer: ${JSON.stringify(spacing)}`);

      if (view==='review' && !(state.editor.x<state.problem.x && state.coach.y>state.problem.y && Math.abs(state.coach.x-state.problem.x)<2)) throw new Error('Review did not create a stacked evidence column');
      // Screenshots use the original code; a genuine undo must survive each switch.
      await evaluate(`window.monaco.editor.getModels()[0].undo()`);
      if (await evaluate(`window.monaco.editor.getModels()[0].getValue()`) !== CODE) throw new Error(`${view} lost undo history`);
      await shot(`workspace-${view}.png`);
      await evaluate(`window.monaco.editor.getModels()[0].redo()`);
    }
    await evaluate(`(async () => { const { setSetting } = await import('/js/settings.js'); setSetting('theme', 'slate'); })()`);
    await evaluate(`window.monaco.editor.getModels()[0].undo()`);
    for (const width of [1081, 1140, 1180, 1280, 768, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height:800, deviceScaleFactor:2, mobile:false });
      for (const view of ['focus','review','workbench']) {
        await evaluate(`document.querySelector('[data-workspace="${view}"]').click()`);
        await sleep(100);
        const measure=await evaluate(`(() => {
          const rect = selector => { const node=document.querySelector(selector); if (!node) return null; const r=node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
          const coach=rect('.coach'), compose=rect('.coach-compose'), actions=rect('.coach-actions'), log=rect('.coach-log');
          const starter=document.querySelector('.coach-empty')?.firstElementChild;
          const starterRect=starter?.getBoundingClientRect();
          const settings=document.querySelector('button[aria-label="Settings"]'), gear=settings?.querySelector('svg');
          return {overflow:document.documentElement.scrollWidth>innerWidth, host:rect('.ws-host'), coach,compose,actions,log,
            starterTop:starterRect?.top ?? null, logTop:log?.top ?? null,
            settings:rect('button[aria-label="Settings"]'), gear:gear?.getBoundingClientRect().toJSON() ?? null};
        })()`);
        const desktop = width > 1080;
        const coachUsable = measure.coach && measure.compose && measure.actions && (!desktop || measure.coach.bottom <= 800) && measure.compose.bottom <= measure.coach.bottom + 1 && measure.actions.bottom <= measure.compose.bottom + 1 && measure.coach.width > 0 && measure.compose.width > 0 && (!desktop || measure.log?.height >= 80);
        const starterVisible = measure.starterTop === null || measure.starterTop >= measure.logTop - 1;
        const settingsSized = measure.settings?.width >= 36 && measure.settings?.height >= 36 && measure.gear?.width >= 20 && measure.gear?.height >= 20;
        if(measure.overflow || measure.host.height<150 || measure.host.width<250 || !coachUsable || !starterVisible || !settingsSized) throw new Error(`${view} at ${width}px: ${JSON.stringify(measure)}`);
      }
    }
    for (const height of [650]) {
      await send('Emulation.setDeviceMetricsOverride', { width:1280, height, deviceScaleFactor:2, mobile:false });
      for (const view of ['focus','review','workbench']) {
        await evaluate(`document.querySelector('[data-workspace="${view}"]').click()`); await sleep(100);
        const measure = await evaluate(`(() => { const r=document.querySelector('.coach')?.getBoundingClientRect(); const c=document.querySelector('.coach-compose')?.getBoundingClientRect(); const a=document.querySelector('.coach-actions')?.getBoundingClientRect(); const l=document.querySelector('.coach-log')?.getBoundingClientRect(); return {overflow:document.documentElement.scrollWidth>innerWidth,coach:r&&{top:r.top,bottom:r.bottom,width:r.width},compose:c&&{top:c.top,bottom:c.bottom},actions:a&&{top:a.top,bottom:a.bottom},log:l&&{height:l.height}}; })()`);
        if (measure.overflow || !measure.coach?.width || measure.coach.bottom > height || measure.compose.bottom > measure.coach.bottom + 1 || measure.actions.bottom > measure.compose.bottom + 1 || measure.log?.height < 80) throw new Error(`${view} at 1280×${height}: ${JSON.stringify(measure)}`);
      }
    }
    await evaluate(`document.querySelector('[data-workspace="focus"]').click()`);
    await send('Page.reload');
    await until(() => evaluate(`Boolean(document.querySelector('.ws-run') && window.monaco?.editor.getModels().length)`), 'Reload lost the editor');
    if (!await evaluate(`document.body.classList.contains('theme-${chosenTheme}')`)) throw new Error('Reload lost the global theme');
    if(!await evaluate(`document.body.classList.contains('workspace-focus') && document.body.classList.contains('hide-problem') && document.body.classList.contains('hide-results')`)) throw new Error('Focus did not persist after reload');
    await send('Emulation.setDeviceMetricsOverride', {width:1600,height:1000,deviceScaleFactor:2,mobile:false});
    await evaluate(`document.querySelector('[data-workspace="workbench"]').click()`);
    await send('Page.navigate', { url: `${origin}/#/` });
    await until(() => evaluate(`Boolean(document.querySelector('.catalog-overview') && document.querySelector('.catalog .tree-pattern'))`), 'Catalog explorer did not mount');
    await until(() => evaluate(`!document.querySelector('.catalog-overview').innerText.includes('Loading saved activity')`), 'Catalog progress did not load');
    const explorerState = await evaluate(`(() => {
      const first = document.querySelector('.catalog .tree-pattern');
      const pattern = first?.querySelector('span:not(.tree-count)')?.textContent?.trim();
      first?.click();
      const rows = [...document.querySelectorAll('.catalog .prow')];
      const filtered = rows.length > 0 && [...document.querySelectorAll('.catalog .psec')].every(section => section.querySelector('.pname')?.textContent === pattern ? section.querySelectorAll('.prow').length > 0 : section.querySelectorAll('.prow').length === 0);
      const overview = document.querySelector('.catalog-overview')?.innerText || '';
      return { pattern, filtered, overview, rows: rows.length };
    })()`);
    if (!explorerState.filtered || explorerState.rows === 0 || /Loading saved activity/.test(explorerState.overview)) throw new Error(`Catalog pattern filter/progress failed: ${JSON.stringify(explorerState)}`);
    await evaluate(`(() => { const q=document.querySelector('#q'); q.value='duplicate'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    if (!await evaluate(`document.querySelectorAll('.catalog .prow').length > 0 && document.querySelector('.catalog-path')?.innerText.includes('All patterns')`)) throw new Error('Catalog search did not clear the pattern filter or match a problem');
    await evaluate(`(() => { const q=document.querySelector('#q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    if (!await evaluate(`document.querySelectorAll('.catalog .prow').length > 0 && document.querySelector('.catalog-path')?.innerText.includes('All patterns')`)) throw new Error('Clearing catalog search did not clear the pattern filter');
    await shot('explorer.png');
    for (const width of [390,768,1140,1600]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height:800, deviceScaleFactor:2, mobile:false });
      const overflow = await evaluate(`document.documentElement.scrollWidth > innerWidth`);
      if (overflow) throw new Error(`Catalog explorer overflows at ${width}px`);
      if (width === 390) await shot('explorer-mobile.png');
    }
    await send('Emulation.setDeviceMetricsOverride', {width:1600,height:1000,deviceScaleFactor:2,mobile:false});
    await send('Page.navigate', { url: `${origin}/#/roadmap` });
    await until(() => evaluate(`document.querySelectorAll('.roadmap-node').length === 18`), 'Roadmap did not mount');
    await evaluate(`document.querySelector('.graph-btn.fit').click()`);
    await sleep(250);
    await shot('roadmap.png');
    await send('Page.navigate', { url: `${origin}/#/design/${id}` });
    await until(() => evaluate(`Boolean(document.querySelector('.dz-canvas canvas') && /Where does that cache write/.test(document.querySelector('.dz-log')?.innerText || ''))`), 'Design replay did not mount');
    await sleep(1200);
    await shot('system-design.png');
    await send('Page.navigate', { url: `${origin}/showcase/showcase.html#voice` });
    await until(() => evaluate(`document.querySelector('#voice-transcript')?.children.length > 0`), 'Actual speech transcript did not load');
    await evaluate(`document.getElementById('voice').scrollIntoView({behavior:'instant', block:'start'})`);
    await shot('transcription.png');
    await send('Page.navigate', { url: `${origin}/showcase/showcase.html` });
    await until(() => evaluate(`document.querySelector('.product-stage img')?.complete && document.querySelector('.theme-controls')?.children.length === 6`), 'Showcase did not load');
    await shot('showcase.png');
    await until(() => evaluate(`document.querySelector('#voice-sample').readyState >= 1 && document.querySelector('#voice-transcript').children.length > 0`), 'Audio sample did not decode');
    await evaluate(`document.querySelector('#voice-sample').currentTime = 1.2`);
    await until(() => evaluate(`Boolean(document.querySelector('#voice-transcript .is-current'))`), 'Transcript did not track audio time');
    await evaluate(`document.getElementById('themes').scrollIntoView({behavior:'instant'})`);
    for (const theme of themes) {
      await evaluate(`Array.from(document.querySelectorAll('.theme-controls button')).find(button => button.textContent === ${JSON.stringify(theme.name)}).click()`);
      await until(() => evaluate(`document.getElementById('theme-image').complete && document.getElementById('theme-image').naturalWidth === 3200 && document.getElementById('theme-image').src.endsWith('theme-${theme.id}.png')`), `Showcase preview failed: ${theme.name}`);
    }
    for (const width of [390, 768, 1600]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 2, mobile: false });
      await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
      const overflow = await evaluate(`document.documentElement.scrollWidth > innerWidth`);
      if (width === 390) await shot('showcase-mobile.png');
      if (overflow) {
        const offenders = await evaluate(`Array.from(document.querySelectorAll('body *')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.className || node.tagName).slice(0,12)`);
        throw new Error(`Showcase overflows at ${width}px: ${offenders.join(', ')}`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Captured 3200×2000 PNG masters, six themes, showcase.png, and validated the audio transcript. Both corrected local cases passed. Coaching is scripted.');
  }
} finally {
  await cleanup();
}
