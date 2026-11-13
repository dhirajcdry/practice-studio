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


export function messageAction(button, name = 'report', label = button.getAttribute('aria-label') || button.textContent) {
  button.classList.remove('btn--quiet', 'btn--secondary', 'btn--lg');
  button.classList.add('btn', 'btn--icon', 'ui-message-action');
  button.type = 'button'; button.removeAttribute('title');
  button.setAttribute('aria-label', label);
  button.replaceChildren(icon(name, 15));
  tooltip(button, label);
  return button;
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
  const jump = el('button', { class: 'ui-jump-latest', type: 'button', hidden: true, onclick: () => {
    const view = viewport(); if (!view) return;
    onJump?.(); view.scrollTop = view.scrollHeight; unread = false; jump.hidden = true;
  } }, [icon('chevron', 14), el('span', { text: 'Jump to latest' })]);
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
    messages.filter(m => m.classList.contains('ui-turn')).at(-1)?.classList.add('ui-message--latest');
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
  // Screens that build their layout after binding place `anchor`, never the bare button.
  return { jump, anchor: jumpAnchor, refresh() { regroup = true; dirty.add(log); schedule(); }, dispose() { observer.disconnect(); cancelAnimationFrame(frame); log.ownerDocument.removeEventListener('scroll', onScroll, true); jumpAnchor.remove(); } };
}
