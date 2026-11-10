import { el, replace } from '../dom.js';
import { renderMarkdown, renderUserText } from '../markdown.js';

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
