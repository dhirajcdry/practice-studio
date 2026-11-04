import assert from 'node:assert/strict';

// Measure relationships, not just viewport overflow: an inset summary and a
// differently inset detail can both fit on screen and still be visibly wrong.
export async function checkSidebar(evaluate) {
  for (const width of [300, 340, 380, 460, 600, 800]) {
    const issues = await evaluate(`(() => {
      const panel = document.querySelector('.coach');
      const previous = panel.style.cssText;
      panel.style.width = panel.style.minWidth = panel.style.maxWidth = '${width}px';
      const issues = [];
      const box = n => n.getBoundingClientRect();
      const visible = n => n.getClientRects().length && !n.closest('[hidden]');
      const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1;
      try {
        const tabs = [...panel.querySelectorAll('.coach-tab')];
        const bar = box(panel.querySelector('.coach-bar'));
        if (tabs.some(n => !inside(box(n), bar) || n.scrollWidth > n.clientWidth + 1)) issues.push('tabs overflow');
        if (tabs.some(n => Math.abs(box(n).top - box(tabs[0]).top) > 1)) issues.push('tabs wrap');
        if (bar.height > 88) issues.push('sidebar header taller than 88px');
        for (const button of panel.querySelectorAll('.coach-bar button')) {
          if (visible(button) && box(button).height > 32.5) issues.push('sidebar header control taller than 32px');
        }
        for (const select of document.querySelectorAll('select')) {
          if (visible(select)) issues.push('visible native select');
        }
        const detail = panel.querySelector('.interview-detail');
        const overview = panel.querySelector('.interviews-overview');
        if (detail && overview && visible(detail) && visible(overview)) issues.push('detail and list shown together');
        for (const card of panel.querySelectorAll('.sidebar-record')) {
          if (!visible(card)) continue;
          if (!inside(box(card), box(card.parentElement))) issues.push('card escapes list');
          if (card.scrollWidth > card.clientWidth + 1) issues.push('card content overflows');
          const summary = card.querySelector('.interview-row-summary');
          // The open button is the card's hit area; a smaller one paints its own box inside the card.
          if (summary && visible(summary)) {
            const resume = card.querySelector('.interview-row-resume');
            const right = resume && visible(resume) ? box(resume).left : box(card).right - card.clientLeft;
            if (Math.abs(box(summary).left - box(card).left - card.clientLeft) > 1 || Math.abs(box(summary).top - box(card).top - card.clientTop) > 1
              || box(summary).right < right - parseFloat(getComputedStyle(card.querySelector('.interview-row-heading')).columnGap || 0) - 1) issues.push('interview summary does not fill its card');
          }
          const detail = card.querySelector('.ci-embedded');
          if (summary && detail && visible(detail)) {
            if (Math.abs(box(summary).left - box(detail).left) > 1 || Math.abs(box(summary).right - box(detail).right) > 1) issues.push('summary/detail edges differ');
            if (Math.abs(box(summary).bottom - box(detail).top) > 1) issues.push('summary/detail are detached');
          }
          if (card.matches('.submission-row')) {
            const style = getComputedStyle(card);
            if (style.borderLeftWidth !== style.borderRightWidth || style.borderLeftColor !== style.borderRightColor) issues.push('submission accent stripe');
          }
        }
        for (const list of panel.querySelectorAll('.ci-debrief ul,.ci-debrief ol')) {
          if (!visible(list)) continue;
          const style = getComputedStyle(list);
          const indent = parseFloat(style.paddingInlineStart);
          if (indent < 2 * parseFloat(style.fontSize) - 1) issues.push('feedback list has no room for markers');
          for (const item of list.children) {
            if (!inside(box(item), box(list))) issues.push('feedback list item escapes its list');
          }
        }
        return issues;
      } finally { panel.style.cssText = previous; }
    })()`);
    assert.deepEqual(issues, [], `Sidebar geometry at ${width}px`);
  }
}
