// Saved verdicts beside their exact code. Reads never submit; loading a snapshot
// goes through the editor's save and undo path, and asking attaches only its id.
import { tooltip } from './tooltip.js';
import { el, replace } from './dom.js';
import { when, verdictLine } from './history.js';
import { loadSubmissions, fetchSubmissionDetails } from './api.js';
import { highlightPython } from './highlight.js';
import { lineDiff } from './line-diff.js';
import { submissionEditor } from './editor.js';
import { submissionPresentation, firstDifference } from './submission-presentation.js';

const idOf = submission => String(submission.submissionId);
const button = (text, onclick) => el('button', { class: 'ws-mini', type: 'button', text, onclick });
function tone(submission) {
  if (submission.accepted) return 'easy';
  return /Limit Exceeded/i.test(submission.verdict) ? 'medium' : 'hard';
}
function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}
// Clamp incomplete metrics so a partial result cannot overfill its track.
function meter(value, total = 100, color = 'easy') {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return el('span', { class: `meter tone-${color}` }, [el('i', { style: `--to:${ratio}` })]);
}
function tile(name, value, percentile) {
  return el('div', { class: 'submission-stat', 'data-metric': name }, [
    el('span', { class: 'submission-label', text: name }),
    el('strong', { text: value }),
    Number.isFinite(percentile) ? el('small', { text: `beats ${Math.round(percentile)}%` }) : null,
    Number.isFinite(percentile) ? meter(percentile) : null,
  ]);
}

/** Histogram buckets stay raw unless the server could reconcile their units. */
export function histogram(metric, name) {
  const points = metric?.distribution || [];
  if (!points.length) return null;
  const unit = metric.unit ?? (name === 'Runtime' ? 'ms' : null);
  let value = name === 'Runtime' ? metric.ms : null;
  if (name === 'Memory' && unit === 'KB') value = metric.mb * 1024;
  if (name === 'Memory' && unit === 'MB') value = metric.mb;
  const closest = Number.isFinite(value) ? points.reduce((a, b) =>
    Math.abs(a.bucket - value) <= Math.abs(b.bucket - value) ? a : b) : null;
  const max = Math.max(...points.map(point => point.pct), 1);
  const width = 300 / points.length;
  const chart = svg('svg', {
    viewBox: '0 0 320 125', role: 'group', 'aria-label': `${name} distribution`, class: 'submission-chart',
  });
  const tooltip = el('div', {
    class: 'chart-caption', text: unit ? 'Distribution of submissions' : 'units unverified',
  });
  points.forEach((point, index) => {
    const label = `${point.label}${unit ? ` ${unit}` : ''} · ${point.pct}% of submissions`;
    const bar = svg('rect', {
      x: 10 + index * width, y: 98 - point.pct / max * 65, rx: 1.5,
      width: Math.max(.5, width - 1), height: Math.max(1, point.pct / max * 65),
      tabindex: index === 0 ? '0' : '-1', 'aria-label': label,
      class: point === closest ? 'you' : point.bucket < value ? 'faster' : '',
    });
    bar.addEventListener('mouseenter', () => { tooltip.textContent = label; });
    bar.addEventListener('focus', () => { tooltip.textContent = label; });
    bar.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const bars = [...chart.querySelectorAll('rect')];
      const next = Math.max(0, Math.min(bars.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      bar.setAttribute('tabindex', '-1');
      bars[next].setAttribute('tabindex', '0');
      bars[next].focus();
    });
    chart.append(bar);
  });
  const ticks = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  for (const index of ticks) {
    const label = svg('text', {
      x: 10 + index * width, y: 119,
      'text-anchor': index === points.length - 1 ? 'end' : index ? 'middle' : 'start',
    });
    label.textContent = `${points[index].label}${unit ? ` ${unit}` : ''}`;
    chart.append(label);
  }
  if (closest) {
    const x = 10 + (points.indexOf(closest) + .5) * width;
    chart.append(svg('line', { x1: x, x2: x, y1: 26, y2: 98, class: 'chart-guide' }));
    const label = svg('text', { x: Math.max(65, Math.min(255, x)), y: 16, 'text-anchor': 'middle' });
    label.textContent = `You · ${metric.display || `${value} ${unit}`}`;
    chart.append(label);
  }
  return el('div', {}, [chart, tooltip]);
}

// Long diagnostics start collapsed, but copying always preserves the full saved text.
function failureBlock(label, text, range) {
  if (typeof text !== 'string' || !text.length) return null;
  const lines = text.split('\n');
  const pre = el('pre');
  function paint(expanded) {
    const visible = expanded ? text : lines.slice(0, 8).join('\n');
    if (range) replace(pre, [visible.slice(0, range[0]), el('mark', {
      text: visible.slice(range[0], range[1]),
    }), visible.slice(range[1])]);
    else pre.textContent = visible;
  }
  paint(false);
  const copy = button('⧉', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '✓';
      copy.setAttribute('aria-label', 'Copied');
    }
    catch { copy.textContent = '!'; copy.setAttribute('aria-label', 'Copy failed'); }
  });
  copy.className = 'icon-btn';
  copy.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  tooltip(copy, `Copy ${label.toLowerCase()}`);
  const section = el('section', { class: 'failure-block' }, [
    el('div', { class: 'failure-label' }, [el('h4', { text: label }), copy]), pre,
  ]);
  if (lines.length > 8) section.append(button(`Show all ${lines.length} lines`, event => {
    paint(true);
    event.currentTarget.remove();
  }));
  return section;
}
// Keep unchanged context near edits; the rest remains available on demand.
function diffView(before, after) {
  const lines = lineDiff(before, after);
  const nodes = [];
  const render = row => el('div', { class: `diff-${row.type}` }, [
    el('span', { class: 'code-gutter', text: row.type === 'same' ? ' ' : row.type === 'added' ? '+' : '−' }),
    el('span', { text: row.text || ' ' }),
  ]);
  for (let index = 0; index < lines.length;) {
    if (lines[index].type !== 'same') {
      nodes.push(render(lines[index++]));
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].type === 'same') end++;
    const run = lines.slice(index, end);
    if (run.length > 6) {
      nodes.push(...run.slice(0, 3).map(render), el('details', {}, [
        el('summary', { text: `⋯ ${run.length - 6} unchanged lines` }), ...run.slice(3, -3).map(render),
      ]), ...run.slice(-3).map(render));
    } else nodes.push(...run.map(render));
    index = end;
  }
  const added = lines.filter(line => line.type === 'added').length;
  const removed = lines.filter(line => line.type === 'removed').length;
  return el('div', {}, [
    el('div', { class: 'diff-counts', text: `+${added} −${removed}` }),
    el('pre', { class: 'submission-diff' }, nodes),
  ]);
}
// Keep one selected view without remounting the surrounding detail card.
function segmented(labels, onSelect) {
  const controls = el('div', { class: 'submission-segments', role: 'group', 'aria-label': 'View' });
  labels.forEach((label, index) => {
    const control = button(label, () => {
      for (const child of controls.children) child.setAttribute('aria-pressed', String(child === control));
      onSelect(index);
    });
    control.setAttribute('aria-pressed', String(index === 0));
    controls.append(control);
  });
  return controls;
}

export function createSubmissions({ slug, onCount = () => {}, onAsk = () => {} }) {
  const root = el('div', { class: 'submissions', tabindex: '-1' });
  let rows = [];
  let selected = null;
  let serial = 0;
  let listScroll = 0;
  const status = el('p', { class: 'submission-status', role: 'status' });

  // Rebuild from saved facts; missing measurements never become zeroes.
  function list() {
    if (!selected) listScroll = root.scrollTop;
    selected = null;
    const accepted = rows.filter(row => row.accepted);
    const timed = accepted.filter(row => Number.isFinite(row.runtimeMs));
    const memory = accepted.filter(row => Number.isFinite(row.memoryMb));
    const best = timed.length ? timed.reduce((a, b) => a.runtimeMs <= b.runtimeMs ? a : b) : null;
    const bestMemory = memory.length ? memory.reduce((a, b) => a.memoryMb <= b.memoryMb ? a : b) : null;
    const parts = [];
    if (rows.length) parts.push(el('div', { class: 'submission-overview' }, [
      best ? tile('Best runtime', `${best.runtimeMs} ms`, best.beatsRuntimePct) : null,
      tile('Accepted', `${accepted.length} / ${rows.length}`),
      bestMemory ? tile('Best memory', `${bestMemory.memoryMb} MB`, bestMemory.beatsMemoryPct) : null,
    ]));
    if (timed.length >= 2) {
      const chronological = [...timed].reverse();
      const max = Math.max(...timed.map(row => row.runtimeMs), 1);
      const points = chronological.map((row, index) => [
        5 + index * 310 / (timed.length - 1), 25 - row.runtimeMs / max * 20,
      ]);
      parts.push(svg('svg', {
        viewBox: '0 0 320 28', class: 'submission-trend', role: 'img', 'aria-label': 'Runtime trend',
      }, [
        svg('polyline', { points: points.map(point => point.join(',')).join(' ') }),
        ...points.map(([cx, cy], index) => svg('circle', {
          cx, cy, r: 2.5, class: chronological[index] === best ? 'best' : '',
        })),
      ]));
    }
    if (!rows.length) parts.push(el('div', { class: 'submission-empty' }, [
      el('span', { class: 'empty-icon', text: '↗', 'aria-hidden': 'true' }),
      el('h3', { text: 'No submissions yet' }),
    ]));
    rows.forEach((submission, index) => {
      const previous = rows.slice(index + 1).find(row => row.accepted && Number.isFinite(row.runtimeMs));
      const delta = submission.accepted && Number.isFinite(submission.runtimeMs) && previous
        ? submission.runtimeMs - previous.runtimeMs : null;
      const rowTone = tone(submission);
      parts.push(el('button', {
        type: 'button', class: `submission-row hover-surface hover-divided tone-${rowTone}`,
        onclick: () => detail(submission),
      }, [
        el('span', { class: 'submission-row-top' }, [
          el('strong', { text: submission.verdict || 'Verdict unavailable' }),
          el('time', { text: when(submission.at) }),
        ]),
        el('span', { class: 'submission-row-bottom' }, [
          el('span', { class: 'submission-metric', text: verdictLine(submission).replace(' of ', ' / ') }),
          delta !== null ? el('span', {
            class: `submission-delta ${delta <= 0 ? 'diff-good' : 'diff-bad'}`,
            text: `${delta < 0 ? '−' : '+'}${Math.abs(delta)} ms`,
          }) : null,
          submission === best ? el('span', { class: 'submission-best', text: '★ best' }) : null,
          submission.source === 'neetcode' ? el('span', { class: 'submission-tag', text: 'NeetCode' }) : null,
        ]),
        !submission.accepted && submission.testsTotal > 0
          ? meter(submission.testsPassed, submission.testsTotal, rowTone) : null,
        el('span', { class: 'submission-chevron', text: '›', 'aria-hidden': 'true' }),
      ]));
    });
    replace(root, parts);
    root.scrollTop = listScroll;
  }

  function fetchDetailsButton(submission) {
    if (submission.source === 'neetcode' || !/^[1-9]\d*$/.test(idOf(submission))) return null;
    return button('Fetch details from LeetCode', async event => {
      const control = event.currentTarget;
      control.disabled = true;
      control.classList.add('is-loading');
      control.textContent = 'Reading details…';
      const result = await fetchSubmissionDetails(slug, idOf(submission));
      if (result.ok) await refresh(selected);
      else {
        status.textContent = result.message || 'Details could not be read.';
        control.disabled = false;
        control.classList.remove('is-loading');
        control.textContent = 'Fetch details from LeetCode';
      }
    });
  }

  function distributionCard(submission) {
    const chart = el('div');
    const card = el('section', { class: 'submission-card' });
    function show(index) {
      const name = index ? 'Memory' : 'Runtime';
      const drawing = histogram(submission.details?.[name.toLowerCase()], name);
      replace(chart, drawing || el('p', { class: 'dim', text: "Charts weren't kept for this submission." }));
      if (!drawing) chart.append(fetchDetailsButton(submission) || '');
    }
    if (submission.details?.runtime?.distribution?.length || submission.details?.memory?.distribution?.length) {
      card.append(el('header', { class: 'submission-card-head' }, [
        segmented(['Runtime', 'Memory'], show),
      ]));
    }
    card.append(chart);
    show(0);
    return card;
  }

  function failureCard(submission) {
    const failure = submission.failure || {};
    const details = submission.details || {};
    const input = failure.lastTestcase ?? failure.input ?? details.lastTestcase;
    const expected = failure.expectedOutput ?? failure.expected ?? details.expectedOutput;
    const output = failure.output ?? failure.actual ?? details.codeOutput;
    const error = failure.compileError || failure.fullRuntimeError || failure.runtimeError
      || failure.traceback || failure.error || failure.message || details.runtimeError || details.compileError;
    const short = typeof expected === 'string' && typeof output === 'string'
      && !expected.includes('\n') && !output.includes('\n') && expected.length < 100 && output.length < 100;
    const difference = short ? firstDifference(expected, output) : null;
    const comparison = el('div', { class: short ? 'failure-comparison' : '' }, [
      failureBlock('Expected', expected, difference && [difference.start, difference.endExpected]),
      failureBlock('Your output', output, difference && [difference.start, difference.endActual]),
    ]);
    const card = el('section', { class: 'submission-card' }, [
      el('h4', { text: 'Where it failed' }), failureBlock('Input', input), comparison,
      failureBlock('Stdout', failure.stdout ?? failure.consoleOutput ?? details.stdOutput),
      failureBlock('Error', error),
    ]);
    if (!card.querySelector('.failure-block')) card.append(
      el('p', { class: 'dim', text: "The failing case wasn't kept for this submission." }),
      fetchDetailsButton(submission) || '',
    );
    if (input) card.append(button('Add as test case', () =>
      submissionEditor(slug)?.addFailingCase({ input, expected: expected ?? null })));
    const lines = new Set([...String(error || '').matchAll(/line\s+(\d+)/gi)].map(match => Number(match[1])));
    for (const line of lines) card.append(button(`Line ${line} ↗`, () => submissionEditor(slug)?.jumpToLine(line)));
    return card;
  }

  function codeCard(submission) {
    const content = el('div', { class: 'submission-code' });
    const previous = rows[rows.indexOf(submission) + 1];
    function show(index) {
      if (index === 0) {
        replace(content, el('pre', {}, submission.code.split('\n').map((line, number) =>
          el('div', { class: 'code-line' }, [
            el('span', { class: 'code-gutter', text: number + 1 }),
            el('span', {}, highlightPython(line || ' ')),
          ]))));
        return;
      }
      const before = index === 1 ? previous?.code : submission.code;
      const after = index === 1 ? submission.code : submissionEditor(slug)?.getCode();
      replace(content, typeof before === 'string' && typeof after === 'string'
        ? diffView(before, after) : el('p', {
          text: index === 1 ? 'Previous code is unavailable.' : 'The editor is not open.',
        }));
    }
    show(0);
    return el('section', { class: 'submission-card' }, [
      el('header', { class: 'submission-card-head' }, [
        segmented(previous ? ['Code', 'vs previous', 'vs editor'] : ['Code', 'vs editor'],
          index => show(!previous && index === 1 ? 2 : index)),
      ]), content,
    ]);
  }

  function detail(submission) {
    if (!selected) listScroll = root.scrollTop;
    selected = idOf(submission);
    status.textContent = '';
    const index = rows.indexOf(submission);
    const previous = button('↑', () => detail(rows[index - 1]));
    const next = button('↓', () => detail(rows[index + 1]));
    previous.className = next.className = 'icon-btn';
    tooltip(previous, 'Newer submission');
    tooltip(next, 'Older submission');
    previous.disabled = index === 0;
    next.disabled = index === rows.length - 1;
    previous.setAttribute('aria-label', 'Newer submission');
    next.setAttribute('aria-label', 'Older submission');
    const presentation = submissionPresentation(submission);
    const source = submission.source === 'neetcode' ? 'NeetCode' : 'LeetCode';
    const date = submission.at ? new Date(submission.at).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : 'Time unavailable';
    const sourceNode = /^https:\/\/(leetcode\.com|neetcode\.io)\//.test(submission.submissionUrl || '')
      ? el('a', { href: submission.submissionUrl, target: '_blank', rel: 'noopener noreferrer', text: `${source} ↗` })
      : el('span', { text: source });
    const parts = [el('div', { class: 'submission-navigation' }, [
      button('‹ All', list), el('span', { class: 'spacer' }),
      el('span', { text: `${index + 1} of ${rows.length}` }), previous, next,
    ]), el('div', {
      class: `submission-hero tone-${tone(submission)} ${submission.accepted ? 'accepted' : 'rejected'}`,
    }, [
      el('h3', { text: submission.verdict || 'Verdict unavailable' }),
      el('div', { class: 'submission-date' }, [when(submission.at) || date, ' · ', sourceNode]),
    ]), el('div', { class: 'submission-metrics' }, presentation.metrics.map(metric =>
      tile(metric.name, metric.value, metric.percentile)))];
    if (presentation.tests) {
      const tests = `${submission.testsPassed} / ${submission.testsTotal} tests`;
      if (submission.accepted) parts.push(el('p', { class: 'submission-tests', text: tests }));
      else parts.push(el('div', { class: 'submission-stat tests-stat' }, [
        el('strong', { text: `${tests} passed` }),
        meter(submission.testsPassed, submission.testsTotal, tone(submission)),
        submission.testsTotal > 0 ? el('small', {
          text: `${Math.round(submission.testsPassed / submission.testsTotal * 100)}% of tests`,
        }) : null,
      ]));
    }
    parts.push(submission.accepted ? distributionCard(submission) : failureCard(submission));
    const lead = submission.leadUp;
    const facts = [];
    if (Number.isFinite(lead?.minutes)) facts.push(`◷ ${lead.minutes} min in`);
    if (Number.isFinite(lead?.localRuns)) facts.push(`▷ ${lead.localRuns} runs`);
    if (Number.isFinite(lead?.coachAsks)) facts.push(`◇ asked coach ${lead.coachAsks}×`);
    if (facts.length) parts.push(el('p', { class: 'submission-lead', text: facts.join(' · ') }));
    if (typeof submission.code === 'string') parts.push(codeCard(submission));
    const load = button('Load into editor', async () => {
      const editor = submissionEditor(slug);
      status.textContent = editor ? await editor.loadSubmission(submission.code)
        || `Submission loaded · ⌘Z to undo`
        : 'The editor is not open.';
      const toast = el('div', { class: 'submission-toast', role: 'status', text: status.textContent });
      root.parentElement.append(toast);
      setTimeout(() => toast.remove(), 4000);
    });
    load.classList.add('ws-run');
    load.disabled = typeof submission.code !== 'string';
    parts.push(status, el('div', { class: 'submission-action-bar' }, [
      load, button('Ask coach', () => onAsk(submission)), button('Copy', async () => {
        try {
          await navigator.clipboard.writeText(submission.code || '');
          status.textContent = 'Code copied.';
        }
        catch { status.textContent = 'Code could not be copied.'; }
      }),
    ]));
    replace(root, parts);
    root.scrollTop = 0;
    root.focus({ preventScroll: true });
  }

  // Ignore an older response when navigation has already requested another record.
  async function refresh(openId = selected) {
    const request = ++serial;
    const data = await loadSubmissions(slug);
    if (request !== serial) return;
    if (!data.ok) {
      replace(root, el('p', { text: 'Submissions could not be loaded.' }));
      return;
    }
    rows = data.submissions;
    onCount(rows.length);
    const item = rows.find(submission => idOf(submission) === String(openId));
    if (item) detail(item);
    else list();
  }
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) {
      event.preventDefault();
      event.stopPropagation();
      list();
    }
    if (selected && ['[', ']', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const index = rows.findIndex(row => idOf(row) === selected);
      const direction = ['[', 'ArrowLeft'].includes(event.key) ? -1 : 1;
      if (rows[index + direction]) detail(rows[index + direction]);
      event.preventDefault();
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      const buttons = [...root.querySelectorAll('.submission-row')];
      const index = buttons.indexOf(document.activeElement);
      if (buttons.length) {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        buttons[(index + direction + buttons.length) % buttons.length].focus();
      }
    }
  });
  return { root, refresh, showList: () => { ++serial; list(); }, open: refresh, render: data => { rows = data; list(); } };
}
