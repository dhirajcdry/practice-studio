// Tiny DOM helpers. Everything here builds nodes and sets text via textContent,
// so no caller can accidentally inject markup. The only two places in this app
// that ever produce rich nodes are sanitize.js and markdown.js.

export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  parent.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

export function frag(children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Swap a node's contents in one mutation.
 *
 * This used to empty the node and then refill it. Between those two steps the node is
 * genuinely empty, and the browser is free to paint it — so every filter click, every
 * navigation, every re-render flashed the page blank for a frame and dropped the
 * scroll position with it. Building the new children off-document first and handing
 * them over with replaceChildren makes it a single mutation with nothing to see.
 */
export function replace(node, children) {
  node.replaceChildren(frag(children));
  return node;
}

/** Boxed-digit numeral, the design language's signature stat treatment. */
export function digits(value) {
  const wrap = el('span', { class: 'digits' });
  for (const ch of String(value)) wrap.append(el('b', { text: ch }));
  return wrap;
}
