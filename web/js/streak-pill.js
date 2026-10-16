// The streak pill in the top bar: a flame and the current streak, linking to the
// progress report. It reads the same /api/stats as everything else through streak.js,
// so it can never disagree with the catalog overview. When stats can't be read it hides
// rather than showing a zero it doesn't know to be true.

import { el } from './dom.js';
import { computeStreak, loadStats } from './streak.js';

const NS = 'http://www.w3.org/2000/svg';
const FOCUS_REFRESH_MS = 60_000;

/** A drawn flame: an outer tongue and a hotter core. `lit` false draws it as an outline. */
export function flameIcon({ lit = true, className = 'flame' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className + (lit ? ' lit' : ''));
  const outer = document.createElementNS(NS, 'path');
  outer.setAttribute('class', 'flame-outer');
  outer.setAttribute('d', 'M12.6 2.2c.5 3 2.4 4.8 4.1 6.7 1.6 1.8 2.9 3.8 2.9 6.4A7.6 7.6 0 0 1 12 22.8a7.6 7.6 0 0 1-7.6-7.3c-.1-2.6 1-4.6 2.6-6.1.3 1.7 1.2 2.9 2.5 3.5-.4-4.1.9-7.9 3.1-10.7Z');
  const inner = document.createElementNS(NS, 'path');
  inner.setAttribute('class', 'flame-core');
  inner.setAttribute('d', 'M12.3 12.6c1.5 1.4 2.9 2.9 2.9 4.9a3.2 3.2 0 0 1-6.4.1c0-1.2.5-2.2 1.3-3 .2.7.7 1.2 1.3 1.4-.1-1.2.2-2.4.9-3.4Z');
  svg.append(outer, inner);
  return svg;
}

export function installStreakPill(mount) {
  if (!mount) return;
  let lastFetch = 0;

  async function refresh(fresh) {
    lastFetch = Date.now();
    show(await loadStats({ fresh }));
  }

  function show(stats) {
    if (!stats || !Array.isArray(stats.activity)) { mount.replaceChildren(); mount.hidden = true; return; }
    const streak = computeStreak(stats.activity);
    const label = `${streak.current}-day streak · best ${streak.best}`;
    const pill = el('a', {
      class: 'streakpill' + (streak.activeToday ? ' active' : '') + (streak.current ? '' : ' cold'),
      href: '#/progress', title: label, 'aria-label': label,
    }, [flameIcon({ lit: streak.current > 0 }), el('span', { class: 'streakpill-n', text: String(streak.current) })]);
    mount.replaceChildren(pill);
    mount.hidden = false;
  }

  mount.hidden = true;
  refresh(false);
  // announceStatsChanged() already dropped the shared cache, so a plain load is fresh.
  window.addEventListener('studio:stats-changed', () => refresh(false));
  // Coming back to the tab after a while (a new day, practice elsewhere) re-reads,
  // but at most once a minute so alt-tabbing doesn't hammer the server.
  window.addEventListener('focus', () => { if (Date.now() - lastFetch > FOCUS_REFRESH_MS) refresh(true); });
  // Whoever else reads fresh stats (the catalog) can hand them over instead of re-asking.
  return { update: (stats) => { lastFetch = Date.now(); show(stats); } };
}
