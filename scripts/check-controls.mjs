// Uses the submissions check's disposable server, fixtures and browser. Never real data.
import { checkSidebar } from './check-sidebar.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function checkControls({ call, evaluate, wait }, origin) {
  const themes = await evaluate(`import('/js/settings.js').then(m => m.THEMES.map(t => t.id))`);
  const failures = [];
  async function measure(area, theme, mode) {
    const rows = await evaluate(`(() => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const path = node => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '')
        + [...node.classList].map(c => '.' + c).join('');
      return [...document.querySelectorAll('body *')].flatMap(row => {
        const style = getComputedStyle(row);
        if (!visible(row) || !/flex|grid/.test(style.display)) return [];
        // Compare controls sharing a visual row, including a voice button in its wrapper.
        // Content cards and list rows are not controls; their height follows their content.
        const buttons = [...row.children].flatMap(child => child.matches('button') ? [child]
          : child.querySelectorAll('button').length === 1 ? [...child.querySelectorAll('button')] : [])
          .filter(button => visible(button)
          && !button.matches('.hover-surface,.set-card,.roadmap-node,.tree-root,.tree-pattern,.phead,.rr-casehead'));
        const groups = [];
        for (const button of buttons) {
          const box = button.getBoundingClientRect();
          let group = groups.find(g => box.top < g.bottom - .5 && box.bottom > g.top + .5);
          if (!group) groups.push(group = { top: box.top, bottom: box.bottom, controls: [] });
          group.controls.push({ selector: path(button), height: box.height });
        }
        return groups.filter(g => g.controls.length >= 2
          && Math.max(...g.controls.map(c => c.height)) - Math.min(...g.controls.map(c => c.height)) > .5)
          .map(g => ({ row: path(row), controls: g.controls }));
      });
    })()`);
    for (const row of rows) failures.push({ area, theme, mode, ...row });
  }
  for (const theme of themes) for (const mode of ['light', 'dark']) {
    await evaluate(`(async () => {
      const m = await import('/js/settings.js');
      m.setSetting('motion', false); m.setSetting('theme', ${JSON.stringify(theme)});
      m.setSetting('mode', ${JSON.stringify(mode)});
      await document.fonts.ready;
    })()`);
    await measure('problem', theme, mode);
    await checkSidebar(evaluate);
    const geometry = await evaluate(`(() => {
      const row = document.querySelector('.recent-chat');
      const text = row?.querySelector('.recent-title');
      const icons = [...document.querySelectorAll('.coach-chat-tools .icon-btn')].filter(n => !n.hidden);
      const tab = document.querySelector('.coach-tab').getBoundingClientRect();
      const model = tab;
      const bar = document.querySelector('.coach-bar');
      const style = getComputedStyle(bar);
      return {
        inset: text ? text.getBoundingClientRect().left - row.getBoundingClientRect().left : null,
        overflow: row ? Math.max(...[row.parentElement, document.querySelector('.coach-log')]
          .filter(Boolean).map(n => n.scrollWidth - n.clientWidth)) : null,
        icons: icons.map(n => { const r = n.getBoundingClientRect(); return [r.width, r.height,
          Math.abs(r.top + r.height / 2 - model.top - model.height / 2)]; }),
        bar: bar.getBoundingClientRect().height,
        limit: tab.height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
          + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
      };
    })()`);
    assert.ok(geometry.inset >= 6, `${theme}/${mode}: hover inset ${JSON.stringify(geometry)}`);
    assert.ok(geometry.overflow <= 1, `${theme}/${mode}: horizontal overflow`);
    assert.ok(geometry.icons.length >= 1 && geometry.icons.length <= 3 && geometry.icons.every(([w, h, delta]) =>
      w >= 28 && w <= 32 && w === h && delta <= 1), `${theme}/${mode}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bar <= 88 && geometry.bar <= geometry.limit + 1, `${theme}/${mode}: bar grew`);
    const point = await evaluate(`(() => { const r = document.querySelector('.recent-chat').getBoundingClientRect();
      return {x:r.left + 12,y:r.top + 12}; })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    // :hover lands on the next frame after the synthetic move, not synchronously.
    await wait(`document.querySelector('.recent-chat').matches(':hover')`);
    const clearance = await evaluate(`(() => {
      const row=document.querySelector('.recent-chat'), box=row.getBoundingClientRect();
      const arrow=row.querySelector('.recent-chevron').getBoundingClientRect();
      const copy=row.querySelector('.ui-row-content').getBoundingClientRect();
      return { edge:box.right-arrow.right, gap:arrow.left-copy.right, left:copy.left-box.left,
        positioned:getComputedStyle(row.querySelector('.recent-chevron')).position };
    })()`);
    assert.ok(clearance.edge >= 12 && clearance.gap >= 12 && clearance.left >= 12
      && clearance.positioned === 'static', `${theme}/${mode}: saved-row spacing ${JSON.stringify(clearance)}`);
    await evaluate(`import('/js/settings.js').then(m => m.openSettings())`);
    await measure('settings', theme, mode);
    await evaluate(`import('/js/settings.js').then(m => m.closeSettings())`);
  }
  await call('Page.navigate', { url: origin + '/#/' });
  await wait(`document.querySelector('.catalog')`);
  for (const theme of themes) for (const mode of ['light', 'dark']) {
    await evaluate(`import('/js/settings.js').then(m => {
      m.setSetting('theme', ${JSON.stringify(theme)}); m.setSetting('mode', ${JSON.stringify(mode)});
    })`);
    await measure('catalog', theme, mode);
  }
  assert.deepEqual(failures, [], 'Sibling control heights (theme, row, selectors and measured heights)');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync(process.execPath, ['scripts/check-submissions.mjs'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
