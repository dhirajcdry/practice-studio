// Browser half of check:visual. Every setup has a visible-state assertion: a missing
// menu or an unopened detail must fail the audit instead of producing a clean screenshot.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { visualLint } from './visual-lint.js';
import { setTimeout as sleep } from 'node:timers/promises';

export async function runVisualAudit({ origin, target, output }) {
  const lint = `return (${visualLint.toString()})();`;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message));
      else request.resolve(message.result);
    }
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request: paused } = message.params;
      const allowed = paused.url.startsWith(`${origin}/`) || /^(data:|blob:|about:)/.test(paused.url);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
      }).catch(() => {}); // Closing the browser may cancel an outstanding request.
    }
  });
  const evaluate = async body => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden]');
        const need = selector => { const node = document.querySelector(selector); if (!visible(node)) throw Error('Missing visible state: ' + selector); return node; };
        // A tab's text includes its count badge ("Submissions2"); match the label, not the badge.
        // No backslashes: this runs from inside a template literal, which would eat them.
        const clickText = (selector, text) => { const node = [...document.querySelectorAll(selector)].find(n => visible(n) && n.textContent.trim().replace(/[ 0-9]+$/, '') === text); if (!node) throw Error('Missing control: ' + text); node.click(); };
        ${body}
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`return !!(${expression});`)) return;
      await sleep(100);
    }
    throw Error(`Timed out waiting for ${label}`);
  };
  // In the wide workspace the floating launcher is intentionally hidden; the rail
  // owns the same toggle. Preserve the open state when a route restores it.
  const coach = `if (!document.querySelector('.coach-bar')?.getClientRects().length) {
    let toggle = null;
    for (let attempt = 0; attempt < 20 && !toggle; attempt++) {
      const selector = document.body.classList.contains('ws-wide') ? '[data-pane="coach"]' : '.coach-launch';
      const candidate = document.querySelector(selector);
      if (visible(candidate)) toggle = candidate;
      else await sleep(100);
    }
    if (!toggle) throw Error('Missing visible coach toggle');
    toggle.click();
  }
  await sleep(300); need('.coach-bar');`;
  const submissions = `${coach} clickText('.coach-tab', 'Submissions'); await sleep(400); need('.submission-row');`;
  const editor = `const inst = window.monaco.editor.getEditors()[0]; if (!inst) throw Error('No editor'); inst.focus();`;
  const problem = '/#/p/jump-game';
  const states = {
    catalog: { url: '/#/', ready: '.catalog' },
    roadmap: { url: '/#/roadmap', ready: '.roadmap' },
    progress: { url: '/#/progress', ready: '.dash-card' },
    design: { url: '/#/design', ready: '.dzl-list' },
    problem: { url: problem, ready: '.ws-bar', setup: `if (document.body.classList.contains('coach-open')) need('.coach-hide').click();` },
    chat: { url: problem, setup: coach, ready: '.recent-chat' },
    chatActive: { url: problem, setup: `${coach} need('.recent-chat').click(); await sleep(300); need('.coach-bar [aria-label="History"]').click();`, ready: '.chat-history-popover .recent-chat' },
    subsList: { url: problem, setup: submissions, ready: '.submission-row' },
    subsAccepted: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Accepted')); if (!row) throw Error('No accepted fixture'); row.click();`, ready: '.submission-hero.accepted', assert: `need('.submission-chart');` },
    subsTle: { url: problem, setup: `${submissions} const row = [...document.querySelectorAll('.submission-row')].find(n => n.textContent.includes('Time Limit Exceeded')); if (!row) throw Error('No TLE fixture'); row.click();`, ready: '.submission-hero.rejected' },
    find: { url: problem, setup: `${editor} await inst.getAction('actions.find').run();`, ready: '.find-widget.visible' },
    suggest: { url: problem, setup: `${editor}
      // Insert on a real method-body line, not past the model's last line.
      const model = inst.getModel();
      if (model.getLineCount() < 3) throw Error('Suggestion fixture needs a method body');
      window.visualOriginalCode = model.getValue();
      inst.executeEdits('visual-check', [{ range: new window.monaco.Range(3, 1, 3, model.getLineMaxColumn(3)), text: '        ' }]);
      inst.setPosition({ lineNumber: 3, column: 9 });
      inst.trigger('keyboard', 'type', { text: 'num' });
      await inst.getAction('editor.action.triggerSuggest').run();`, ready: '.suggest-widget.visible' },
    runResult: { url: '/?simrun=pass#/p/jump-game', setup: `need('.ws-bar .ws-run').click();`, ready: '.rr-case' },
    verdictWrong: { url: '/?simsubmit=wrong#/p/jump-game', setup: `need('.ws-bar .ws-submit').click();`, ready: '.sub-verdict.v-rejected', assert: `
      const expected = [...document.querySelectorAll('.sub-detail')].find(n => n.firstElementChild.textContent === 'Expected output');
      const actual = document.querySelector('.sub-detail.bad');
      const pane = need('.ws-results').getBoundingClientRect();
      for (const node of [expected, actual]) {
        if (!node) throw Error('Missing failure comparison');
        const box = node.getBoundingClientRect();
        if (box.top < pane.top - 1 || box.bottom > pane.bottom + 1) throw Error('Failure comparison is below the results fold');
      }` },
    verdictAccepted: { url: '/?simsubmit=accepted&motion=0#/p/jump-game', setup: `need('.ws-bar .ws-submit').click();`, ready: '.sub-verdict.v-accepted' },
    cases: { url: '/#/p/cheapest-flights-within-k-stops', setup: `need('.tc-tab.is-mine').click();`, ready: '.tc-panel' },
    settings: { url: problem, setup: `await import('/js/settings.js').then(m => m.openSettings());`, ready: '.settings', assert: `
      const background = getComputedStyle(need('.settings')).backgroundColor;
      if (background.startsWith('rgba(') && !background.endsWith(', 1)')) throw Error('Reading overlay is translucent: ' + background);` },
  };
  const findings = [];
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    // Only this scratch origin may load resources, including plain-HTTP requests.
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${origin}/` });
    await until("document.querySelector('.catalog')", 'catalog');
    const themes = await evaluate("return (await import('/js/settings.js')).THEMES.map(theme => theme.id);");
    for (const theme of themes) for (const mode of ['light', 'dark']) {
      for (const [state, config] of Object.entries(states)) {
        try {
          // A full document reset prevents a prior popover/widget from satisfying
          // the next state's readiness check while a same-route navigation settles.
          await send('Page.navigate', { url: 'about:blank' });
          await until("location.href === 'about:blank' && document.readyState === 'complete'", 'blank page');
          await send('Page.navigate', { url: `${origin}${config.url}` });
          await until("document.readyState === 'complete' && document.querySelector('.catalog,.ws-bar,.roadmap,.dash-card,.dzl-list')", 'view');
          await evaluate(`const settings = await import('/js/settings.js');
            settings.setSetting('theme', ${JSON.stringify(theme)}); settings.setSetting('mode', ${JSON.stringify(mode)});
            settings.setSetting('motion', false); settings.setSetting('celebrations', false);`);
          if (config.url.includes('/p/')) {
            await until("window.monaco?.editor.getEditors().length && document.querySelector('.tc-tab')", 'editor and cases');
          }
          if (config.setup) await evaluate(config.setup);
          await until(`(() => { const n = document.querySelector(${JSON.stringify(config.ready)}); return n && n.getClientRects().length && !n.closest('[hidden]') && getComputedStyle(n).visibility !== 'hidden'; })()`, config.ready);
          await evaluate('await document.fonts.ready; await sleep(250);');
          if (config.assert) await evaluate(config.assert);
          const rows = await evaluate(lint);
          if (!Array.isArray(rows)) throw Error('Visual lint did not return findings');
          findings.push(...rows.map(row => ({ theme, mode, state, ...row })));
        } catch (error) {
          findings.push({ theme, mode, state, kind: 'audit-error', where: config.ready, detail: error.message });
        }
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        await fsp.writeFile(path.join(output, `${state}-${theme}-${mode}.png`), Buffer.from(screenshot.data, 'base64'));
        await fsp.writeFile(path.join(output, 'findings.json'), JSON.stringify(findings, null, 2));
        if (state === 'suggest') await evaluate(`if (typeof window.visualOriginalCode === 'string') { window.monaco.editor.getEditors()[0].setValue(window.visualOriginalCode); await sleep(500); }`);
      }
      console.log(`Visual audit: ${theme}/${mode}, ${Object.keys(states).length} states`);
    }
    return findings;
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Audit closed')); }
    pending.clear();
    socket.close();
  }
}
