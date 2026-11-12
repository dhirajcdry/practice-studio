import { el } from './dom.js';

// The three ways to look at LeetCode practice. The top bar has one LeetCode link;
// Explorer, Roadmap and Progress are views inside it, so the same switch sits in the
// header of all three. They are real links: the hash decides which view renders, and
// only Explorer/Roadmap are remembered as the place the LeetCode link returns to.
const VIEWS = [
  ['explorer', 'Explorer', '#/'],
  ['roadmap', 'Roadmap', '#/roadmap'],
  ['progress', 'Progress', '#/progress'],
];

export function leetcodeViews(current) {
  return el('nav', { class: 'segmented leetcode-views', 'aria-label': 'LeetCode views' }, VIEWS.map(([id, label, href]) =>
    el('a', { class: 'btn btn--quiet', href, 'data-view': id, text: label, ...(id === current ? { 'aria-current': 'page' } : {}) })));
}
