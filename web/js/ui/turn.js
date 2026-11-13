import { el, replace } from '../dom.js';
import { button } from './button.js';
import { conversationText } from './conversation.js';
import { displayFor } from '../tool-display.js';


/**
 * Steps as the turn draws them. A live step arrives with its wording; a saved one carries
 * only the tool's name, resolved here. Durations are the gap to the next step when unknown.
 */
export function activitySteps(steps = [], endedAt = null) {
  return steps.map((step, index) => {
    const display = step.display?.doing && step.display?.done ? step.display : displayFor(step.tool || step.name);
    const start = Date.parse(step.at), end = Date.parse(steps[index + 1]?.at || endedAt);
    return { ...step, display, effect: step.effect || display.effect,
      ms: Number.isFinite(step.ms) ? Math.max(0, step.ms) : Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null };
  });
}
export function isNoteOnlyReply({ text = '', activity = [], actions = [], kind, finished = true } = {}) {
  const effects = [...activity, ...actions].map(item => item.effect || item.display?.effect || displayFor(item.tool || item.name).effect);
  return finished && kind !== 'attempt-review' && text.trim().length < 200
    && effects.includes('note') && !effects.some(effect => effect === 'change' || effect === 'handoff');
}
export function activitySummary(steps) {
  const reads = steps.filter(step => step.effect === 'read').length;
  const parts = [];
  if (reads) parts.push(`Looked at ${reads} ${reads === 1 ? 'thing' : 'things'}`);
  if (steps.some(step => step.effect === 'note')) parts.push('saved a private note');
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const clock = at => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const seconds = ms => `${Math.round(ms / 1000)}s`;
// An action that goes somewhere is a real link (new tab, copyable); one that does something is a button.
const actionButtons = actions => actions.map(action => action instanceof Node ? action : action.href
  ? el('a', { class: 'btn btn--quiet', href: action.href, target: '_blank', rel: 'noopener noreferrer', text: action.label })
  : button({ ...action, variant: 'quiet' }));

/** Independent slots: prose streaming never replaces activity, cards, or their controls. */
export function createReply({ speaker = 'Coach', meta = '', startedAt = null } = {}) {
  const body = conversationText('');
  body.classList.add('ui-turn-body');
  const activity = el('div', { class: 'ui-turn-activity', hidden: true });
  const changes = el('div', { class: 'ui-turn-changes', hidden: true });
  const notice = el('div', { class: 'ui-turn-notice', hidden: true });
  const foot = el('div', { class: 'ui-turn-foot', hidden: true });
  const headStamp = el('span', { text: meta || clock(startedAt) });
  const node = el('article', { class: 'ui-message ui-turn', dataset: { speaker }, tabindex: '0' }, [
    el('div', { class: 'ui-turn-head' }, [el('strong', { text: speaker }), headStamp]),
    activity, changes, body, notice,
  ]);
  let steps = [], live = false, expanded = false, timer = null, liveStartedAt = startedAt;
  function stopTimer() { clearInterval(timer); timer = null; }
  function paintActivity() {
    activity.hidden = !live && !activitySummary(steps);
    if (activity.hidden) { replace(activity, []); return; }
    if (live) {
      const current = steps.at(-1);
      const elapsed = Date.now() - Date.parse(liveStartedAt || steps[0]?.at);
      replace(activity, el('div', { class: 'ui-turn-activity-line', role: 'status' }, [
        el('i', { class: 'ui-turn-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'ui-turn-step-label', text: current?.display.doing || 'Thinking' }),
        el('span', { class: 'ui-turn-count', text: [`step ${steps.length || 1}`, Number.isFinite(elapsed) ? seconds(Math.max(0, elapsed)) : null].filter(Boolean).join(' · ') }),
      ]));
      return;
    }
    const toggle = button({ icon: expanded ? 'chevron' : 'forward', label: activitySummary(steps), className: 'ui-turn-activity-line', onClick: () => { expanded = !expanded; paintActivity(); } });
    toggle.setAttribute('aria-expanded', String(expanded));
    replace(activity, [toggle, expanded ? el('ul', { class: 'ui-turn-steps' }, steps.map(step => el('li', null, [
      el('span', null, [el('span', { text: step.display.done }), step.output != null ? el('details', { class: 'ui-turn-output', open: !!step.failed }, [el('summary', { text: 'Show output' }), el('pre', { text: step.output || 'No output.' })]) : null]), Number.isFinite(step.ms) ? el('span', { class: 'ui-turn-stamp', text: seconds(step.ms) }) : null,
    ]))) : null]);
  }
  return {
    node, body,
    setActivity(next, options = {}) {
      steps = activitySteps(next, options.endedAt); live = !!options.live;
      if (live && !liveStartedAt) liveStartedAt = new Date().toISOString();
      stopTimer(); paintActivity();
      if (live) timer = setInterval(() => { if (!node.isConnected) { stopTimer(); return; } paintActivity(); }, 1000);
    },
    setChanges(cards = []) {
      changes.hidden = !cards.length;
      replace(changes, cards.map(card => el('section', { class: `ui-turn-change is-${card.state || 'done'}`, dataset: { actionId: card.id || '', tool: card.tool || '', status: card.state || 'done' } }, [
        el('div', { class: 'ui-turn-change-head' }, [el('strong', { text: card.title }), card.tag ? el('span', { class: 'ui-turn-tag', text: card.tag }) : null]),
        card.detail ? el('p', { class: 'ui-turn-change-detail', text: card.detail }) : null,
        card.state && card.state !== 'done' ? el('span', { class: 'ui-turn-stamp', text: { pending: 'Working…', failed: 'Not done', undone: 'Undone' }[card.state] || card.state }) : null,
        card.error ? el('p', { text: card.error }) : null,
        card.actions?.length ? el('div', { class: 'ui-turn-change-actions' }, actionButtons(card.actions)) : null,
      ])));
    },
    setNotice(value) {
      notice.hidden = !value;
      notice.className = 'ui-turn-notice' + (value?.tone ? ` tone-${value.tone}` : '');
      notice.setAttribute('role', 'status');
      replace(notice, value ? [el('strong', { text: value.head }), value.body ? el('span', { text: value.body }) : null,
        value.actions?.length ? el('div', null, actionButtons(value.actions)) : null] : []);
    },
    finish({ at, stamp, durationMs, actions = [] } = {}) {
      stopTimer();
      const hasText = Boolean((body.dataset.markdown || body.textContent).trim());
      foot.hidden = !hasText;
      // A stamp the head already shows ("At the start") is not repeated under the reply.
      const footStamp = stamp ?? clock(at);
      if (hasText && foot.parentNode !== node) node.append(foot);
      else if (!hasText) foot.remove();
      replace(foot, hasText ? [button({ icon: 'copy', variant: 'icon', ariaLabel: 'Copy reply', onClick: async () => {
        try { await navigator.clipboard.writeText(body.dataset.markdown || body.textContent); } catch { /* Clipboard unavailable. */ }
      } }), ...actionButtons(actions), el('span', { class: 'ui-turn-stamp', text: [footStamp === headStamp.textContent ? null : footStamp, Number.isFinite(durationMs) ? seconds(durationMs) : null].filter(Boolean).join(' · ') })] : []);
    },
    dispose: stopTimer,
  };
}
export function questionNode({ text, at, stamp } = {}) {
  const body = conversationText(text, { user: true });
  return el('article', { class: 'ui-message ui-question', dataset: { speaker: 'You', question: text || '' }, tabindex: '0' }, [body, el('span', { class: 'ui-turn-stamp', text: stamp ?? clock(at) })]);
}
export function threadStrip({ title = '', startedAt, turns = 0 } = {}) {
  const date = startedAt && Number.isFinite(Date.parse(startedAt)) ? new Date(startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock(startedAt) : null;
  return el('div', { class: 'ui-thread-strip' }, [el('strong', { text: title || 'Conversation' }), el('span', { text: [date ? `Started ${date}` : null, `${turns} ${turns === 1 ? 'turn' : 'turns'}`].filter(Boolean).join(' · ') })]);
}
/**
 * The latest question, pinned while it is scrolled out of view.
 *
 * It hangs from a zero-height anchor placed before the log, so showing or hiding it never
 * changes the transcript's layout or the reader's scroll position.
 */
export function bindPinnedQuestion(log) {
  const pin = el('div', { class: 'ui-pinned-question', hidden: true });
  const anchor = el('div', { class: 'ui-pinned-anchor' }, pin);
  let frame = null;
  function paint() {
    frame = null;
    if (!log.isConnected) return;
    if (anchor.nextSibling !== log) log.before(anchor);
    const question = [...log.querySelectorAll('.ui-question')].at(-1);
    const text = question?.dataset.question || '';
    pin.hidden = log.hidden || !text || question.getBoundingClientRect().bottom > log.getBoundingClientRect().top;
    if (pin.dataset.question !== text) { pin.dataset.question = text; replace(pin, [el('b', { text: 'You asked' }), el('span', { text })]); }
  }
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(paint); };
  const observer = new MutationObserver(schedule);
  observer.observe(log, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  log.addEventListener('scroll', schedule, { passive: true });
  const resize = new ResizeObserver(schedule); resize.observe(log);
  schedule();
  return { refresh: schedule, dispose() { observer.disconnect(); resize.disconnect(); log.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); anchor.remove(); } };
}
