import { el, replace } from '../dom.js';
import { renderMarkdown, renderUserText } from '../markdown.js';
import { icon } from './icon.js';
import { tooltip } from '../tooltip.js';

// Keep source text separate from rendered text: streaming and replay must never
// concatenate textContent, which loses Markdown delimiters and block boundaries.
export function conversationText(text = '', { user = false, className = '' } = {}) {
  const node = el('div', { class: `rich ui-conversation-text${user ? ' ui-conversation-text--user' : ''}${className ? ' ' + className : ''}` });
  setConversationText(node, text);
  return node;
}

export function setConversationText(node, text) {
  node.dataset.markdown = text;
  replace(node, node.classList.contains('ui-conversation-text--user') ? renderUserText(text) : renderMarkdown(text));
}

export function appendConversationText(node, chunk) {
  setConversationText(node, (node.dataset.markdown || '') + chunk);
}


// Message chrome has no knowledge of providers or persistence. Callers retain the
// source, streaming renderer, timestamps and action handlers they already own.
export function conversationMessage({ speaker = 'Coach', user = false, body = null, text = '', stamp = '', elapsedMs, className = '', actions = [], dataset = {} } = {}) {
  if (!stamp && Number.isFinite(elapsedMs)) stamp = elapsedMs < 60000 ? 'At the start' : `${Math.floor(elapsedMs / 60000)} min in`;
  const content = body || conversationText(text, { user });
  content.classList.add('ui-conversation-text', 'rich');
  if (user) content.classList.add('ui-conversation-text--user');
  if (!user) actions = [...actions, messageAction(el('button', { onclick: async () => {
    try { await navigator.clipboard.writeText(content.dataset.markdown || content.textContent); } catch { /* Clipboard may be unavailable. */ }
  } }), 'copy', 'Copy reply')];
  const node = el('article', { class: `ui-message ${user ? 'ui-message--user' : 'ui-message--coach'} ${className}`, dataset: { ...dataset, speaker }, tabindex: '0' }, [
    el('div', { class: 'ui-message-head' }, [
      el('span', { class: `ui-speaker${user ? ' sr-only' : ''}`, text: speaker }),
      stamp ? el('span', { class: 'ui-message-time', text: stamp }) : null,
    ]), content, el('div', { class: 'ui-message-actions' }, actions),
  ]);
  return node;
}

export function messageAction(button, name = 'report', label = button.getAttribute('aria-label') || button.textContent) {
  button.classList.remove('btn--quiet', 'btn--secondary', 'btn--lg');
  button.classList.add('btn', 'btn--icon', 'ui-message-action');
  button.type = 'button'; button.removeAttribute('title');
  button.setAttribute('aria-label', label);
  button.replaceChildren(icon(name, 15));
  tooltip(button, label);
  return button;
}

export function thinkingRow() {
  return el('div', { class: 'ui-thinking', role: 'status' }, [
    el('span', { text: 'Thinking' }), el('span', { class: 'ui-thinking-dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
  ]);
}

export function conversationSeparator(label, { phase = false, value } = {}) {
  return el('div', { class: `ui-conversation-separator${phase ? ' ui-phase-divider' : ''}`, text: label, dataset: value ? { phase: value } : {} });
}

export function decorateConversationCode(root) {
  for (const pre of root.querySelectorAll('.ui-conversation-text pre')) {
    if (pre.parentElement.classList.contains('ui-code-block')) continue;
    const source = pre.textContent;
    const wrap = el('div', { class: 'ui-code-block' });
    pre.replaceWith(wrap); wrap.append(pre);
    const copy = messageAction(el('button', { onclick: async () => {
      try { await navigator.clipboard.writeText(source); copy.setAttribute('aria-label', 'Copied code'); }
      catch { copy.setAttribute('aria-label', 'Could not copy code'); }
    } }), 'copy', 'Copy code');
    wrap.append(copy);
  }
}

// Observe only presentation. Following remains owned by the existing screen;
// scrolling up alone never claims that unread content has arrived.
export function bindConversation(log, { composer = null, viewport = () => log, onJump = null } = {}) {
  let unread = false, initialized = false, frame = 0, regroup = true;
  const dirty = new Set();
  const jump = el('button', { class: 'btn btn--secondary ui-jump-latest', text: 'Jump to latest', type: 'button', hidden: true, onclick: () => {
    const view = viewport(); if (!view) return;
    onJump?.(); view.scrollTop = view.scrollHeight; unread = false; jump.hidden = true;
  } });
  // A zero-height anchor keeps unread controls out of the transcript's layout.
  // Hiding an in-flow pill used to grow the viewport and clamp scrollTop by 36px.
  const jumpAnchor = el('div', { class: 'ui-jump-anchor' }, jump);
  if (composer) composer.before(jumpAnchor);
  const atBottom = () => { const view = viewport(); return !view || view.scrollHeight - view.scrollTop - view.clientHeight <= 1; };
  function scroll() { if (atBottom()) unread = false; jump.hidden = !unread; }
  function paint() {
    frame = 0;
    const bottom = atBottom();
    if (regroup) {
    const messages = [...log.querySelectorAll('.ui-message')];
    let prior = null;
    for (const message of messages) {
      const same = prior?.dataset.speaker === message.dataset.speaker && !message.previousElementSibling?.matches('.ui-phase-divider,.ui-conversation-separator');
      message.classList.toggle('ui-message--continuation', Boolean(same));
      message.classList.remove('ui-message--latest'); prior = message;
    }
    messages.filter(m => m.classList.contains('ui-message--coach')).at(-1)?.classList.add('ui-message--latest');
    regroup = false;
    }
    for (const node of dirty) if (node.isConnected) decorateConversationCode(node);
    if (initialized && dirty.size && !bottom) unread = true;
    dirty.clear(); initialized = true; scroll();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const message = target.closest?.('.ui-message');
      if (message) dirty.add(message);
      else { regroup = true; dirty.add(log); }
    }
    schedule();
  });
  observer.observe(log, { childList: true, subtree: true, characterData: true });
  // Capture also catches an outer coding-pane scroll owner.
  const onScroll = event => { if (event.target === viewport()) scroll(); };
  log.ownerDocument.addEventListener('scroll', onScroll, true);
  dirty.add(log); paint();
  return { jump, refresh() { regroup = true; dirty.add(log); schedule(); }, dispose() { observer.disconnect(); cancelAnimationFrame(frame); log.ownerDocument.removeEventListener('scroll', onScroll, true); jumpAnchor.remove(); } };
}
