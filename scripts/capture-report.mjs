// Reuse the audit's offline scratch server, fixture and disposable headless Chrome.
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function captureReport({ send, evaluate, until, origin, output }) {
  await fsp.mkdir(output, { recursive: true });
  const views = [
    ['dunes', 'light', 1280, 'desktop'], ['dunes', 'dark', 1280, 'desktop'],
    ['dunes', 'light', 390, 'phone'], ['studio', 'light', 1280, 'desktop'],
    ['studio', 'dark', 1280, 'desktop'], ['dunes', 'light', 1280, 'problem'],
  ];
  for (const [theme, mode, width, view] of views) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'about:blank' });
    await until("location.href === 'about:blank'", 'blank');
    await send('Page.navigate', { url: `${origin}/?motion=0#/p/jump-game` });
    await until("document.querySelector('.ws-bar')", 'problem workspace');
    await until("window.monaco?.editor.getEditors().length && document.querySelector('.tc-tab')", 'problem editor');
    await evaluate(`const settings = await import('/js/settings.js'); settings.setSetting('motion', false); settings.setSetting('theme', '${theme}'); settings.setSetting('mode', '${mode}'); await sleep(400);`);
    if (view !== 'problem') {
      await evaluate(`(await import('/js/interview.js')).openInterviewRecord('jump-game', '1760000000000-00000003');`);
      await until("document.querySelector('.ci-open-report')", 'finished mock');
      await evaluate("document.querySelector('.ci-open-report').click();");
      await until("document.querySelector('.rp-sheet[open] .rp-signal')", 'report');
      // Expand only the outer reading viewport for a full-sheet screenshot. Internal
      // code and transcript scrollers retain their production width/overflow behavior.
      await evaluate(`const style = document.createElement('style'); style.textContent = '.rp-sheet{position:absolute;inset:0 auto auto 0;width:100%;height:auto;max-height:none;margin:0;overflow:visible}.rp-main{display:block}.rp-scroll{overflow:visible}.rp-sheet .ui-dialog-header{position:relative}'; document.head.append(style); await document.fonts.ready; await sleep(300);`);
      const height = await evaluate("return Math.ceil(document.querySelector('.rp-sheet').getBoundingClientRect().height);");
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      await fsp.writeFile(path.join(output, `${theme}-${mode}-${view}.png`), Buffer.from(shot.data, 'base64'));
    } else {
      await evaluate('await document.fonts.ready; await sleep(300);');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await fsp.writeFile(path.join(output, `${theme}-${mode}-problem.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  console.log(`Report review screenshots: ${output}`);
}
