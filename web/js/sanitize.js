// Allowlist HTML sanitizer for LeetCode problem descriptions.
//
// Threat model (see docs/API-CONTRACT.md, "Untrusted content"): descriptionHtml is
// third-party HTML relayed byte-for-byte by our server. It is never trusted.
//
// Strategy: parse into an INERT document (DOMParser never runs scripts and never
// loads subresources), then REBUILD a fresh tree in the live document, copying only
// tags and attributes that appear on an explicit allowlist. Nothing is copied by
// default, so an attribute or element we have never heard of cannot survive.
//
//   - forbidden tags -> element AND its subtree are dropped
//   - allowed tags   -> rebuilt, with allowed attributes only
//   - anything else  -> unwrapped (tag dropped, text children kept)
//
// No library. Small enough to read in full and covered by web/tests.html.

/** Elements whose entire subtree is discarded — they carry behaviour, not text. */
const FORBIDDEN = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'title',
  'noscript', 'template', 'form', 'input', 'button', 'select', 'option', 'textarea',
  'svg', 'math', 'frame', 'frameset', 'applet', 'audio', 'video', 'source', 'track',
  'canvas', 'portal', 'dialog', 'slot',
]);

/** tag -> attributes we are willing to carry over. Everything else is dropped. */
const ALLOWED = {
  p: [], pre: [], code: [], ul: [], ol: [], li: [],
  strong: [], em: [], b: [], i: [], sup: [], sub: [], br: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], td: [], th: [],
  img: ['src', 'alt'],
  a: ['href'],
};

const VOID_TAGS = new Set(['br', 'img']);

/** Only absolute https URLs survive. Kills javascript:, data:, vbscript:, //host. */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  // Strip characters browsers ignore when resolving a scheme (tab/newline/NUL/spaces).
  const cleaned = raw.replace(/[\u0000-\u0020\u007f]/g, '');
  if (!/^https:\/\//i.test(cleaned)) return null;
  try {
    const url = new URL(cleaned);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const MAX_DEPTH = 100;

function convert(source, target, depth) {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments, PIs, doctype

    const tag = child.tagName.toLowerCase();
    if (FORBIDDEN.has(tag)) continue;

    if (depth >= MAX_DEPTH || !Object.hasOwn(ALLOWED, tag)) {
      // Unwrap: keep the readable content, throw away the unknown wrapper.
      convert(child, target, depth + 1);
      continue;
    }

    const clean = document.createElement(tag);
    for (const name of ALLOWED[tag]) {
      if (!child.hasAttribute(name)) continue;
      const value = child.getAttribute(name);
      if (/^on/i.test(name)) continue; // belt and braces; no on* is on any allowlist
      if (name === 'href' || name === 'src') {
        const url = safeUrl(value);
        if (url) clean.setAttribute(name, url);
      } else {
        clean.setAttribute(name, value);
      }
    }
    if (tag === 'a') {
      if (!clean.hasAttribute('href')) {
        // A link we refused to trust is not a link. Keep the text, drop the anchor.
        convert(child, target, depth + 1);
        continue;
      }
      clean.setAttribute('rel', 'noopener noreferrer nofollow');
      clean.setAttribute('target', '_blank');
    }
    if (tag === 'img') {
      if (!clean.hasAttribute('src')) continue;
      clean.setAttribute('loading', 'lazy');
      clean.setAttribute('referrerpolicy', 'no-referrer');
    }
    if (!VOID_TAGS.has(tag)) convert(child, clean, depth + 1);
    target.append(clean);
  }
  return target;
}

/**
 * @param {string} html untrusted HTML
 * @returns {DocumentFragment} nodes safe to insert into the live document
 */
export function sanitizeHtml(html) {
  const out = document.createDocumentFragment();
  if (typeof html !== 'string' || html.trim() === '') return out;
  const inert = new DOMParser().parseFromString(html, 'text/html');
  return convert(inert.body, out, 0);
}

/** True when the HTML has no rendered text and no image once sanitized. */
export function isBlankHtml(html) {
  const nodes = sanitizeHtml(html);
  const probe = document.createElement('div');
  probe.append(nodes.cloneNode(true));
  return probe.textContent.trim() === '' && !probe.querySelector('img');
}
