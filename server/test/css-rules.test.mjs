// A stylesheet rule, checked as a rule — not by rendering it and hoping.
//
// The coach panel dropped its own messages on top of each other three separate times.
// Each time I "fixed" it, verified it in headless Chrome, and shipped. Chrome was never
// the problem: in WebKit, flex items inside a scrolling flex column shrink below their
// content instead of letting the container scroll, so the text overflows its box and
// draws through its neighbours. The bug was only ever visible in the browser the user
// actually uses, and every measurement I took was in the one that hides it.
//
// So this does not measure anything. It asserts the shape of the CSS, which is the same
// in every engine: a container that scrolls must not also be a flex column.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_CSS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/css');

/** Every `selector { body }` pair. Good enough: this stylesheet has no nesting or @supports. */
function rules(css) {
  const out = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].split('\n').pop().trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selector, body: match[2].replace(/\s+/g, '') });
  }
  return out;
}

const scrolls = (b) => /overflow(-y)?:(auto|scroll)/.test(b);
const flexColumn = (b) => b.includes('display:flex') && b.includes('flex-direction:column');

for (const file of fs.readdirSync(WEB_CSS).filter((f) => f.endsWith('.css'))) {
  test(`${file}: nothing that scrolls is also a flex column`, () => {
    const offenders = rules(fs.readFileSync(path.join(WEB_CSS, file), 'utf8'))
      .filter((r) => scrolls(r.body) && flexColumn(r.body))
      .map((r) => r.selector);

    assert.deepEqual(
      offenders,
      [],
      `These scroll AND lay out as a flex column, which makes their children shrink below `
      + `their own content in WebKit instead of scrolling — the overlapping-messages bug:\n  `
      + offenders.join('\n  ')
      + `\nUse block flow with margins for a scrolling list of stacked children.`,
    );
  });
}

// The second way the same panel ate its own text, and a subtler one.
//
// A coach message was `<div class="cmsg coach">`, and the panel it lives inside is
// `<div class="card coach">`. So every answer also matched `.coach` — `display:flex;
// height:100%; overflow:hidden` — which pinned each message to exactly the height of the
// log and clipped the rest. Nothing overflowed, so the log had nothing to scroll: the
// answer simply stopped mid-sentence and the wheel did nothing. Renaming the role fixed
// it; this keeps any future role from colliding the same way.
test('no message role shares a class name with a layout container', () => {
  const css = fs.readFileSync(path.join(WEB_CSS, 'app.css'), 'utf8');
  const js = fs.readFileSync(path.resolve(WEB_CSS, '../js/coach.js'), 'utf8');

  const roles = [...js.matchAll(/addMessage\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(roles.length >= 2, 'no addMessage roles found — was the panel rewritten?');

  // A rule that sizes or clips whatever it matches. Inheriting one of these by accident
  // is what does the damage; colour and font would be merely ugly.
  const structural = (b) => /height:100%/.test(b) || /overflow(-y)?:hidden/.test(b) || b.includes('position:fixed');

  const clashes = [];
  for (const role of roles) {
    for (const rule of rules(css)) {
      // `.role` used on its own, or as the whole compound — `.cmsg.role` is fine.
      const hits = rule.selector.split(',').some((s) => new RegExp(`(^|[\\s>+~])\\.${role}(?![\\w-])`).test(s.trim()));
      if (hits && structural(rule.body)) clashes.push(`${role} ← ${rule.selector}`);
    }
  }

  assert.deepEqual(
    clashes,
    [],
    'A message role class also matches a structural rule, so every message of that role '
    + 'gets that rule\'s height/clipping:\n  ' + clashes.join('\n  '),
  );
});

// Colour belongs to a theme, and nowhere else.
//
// Written after a sticky results header carrying `background:#F4F4F4` — a grey
// eyedropped off the Paper theme — turned into a white bar across every dark theme, so
// a passing run announced itself in a slab of white. The same mistake was in twenty
// other rules: `rgba(179,58,26,.35)` is the terracotta of ONE theme, hardcoded into a
// border that four other themes also use.
//
// The rule is mechanical, so it can be checked mechanically: a colour literal may
// appear in `:root` or inside a `body.theme-*` rule. Everywhere else, use a variable.
for (const file of fs.readdirSync(WEB_CSS).filter((f) => f.endsWith('.css'))) {
  test(`${file}: no colour is hardcoded outside a theme`, () => {
    const css = fs.readFileSync(path.join(WEB_CSS, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].split('\n').pop().trim();
      if (!selector || selector.startsWith('@')) continue;
      // `:root` holds the defaults; `body.theme-*` IS the definition of a theme.
      if (selector === ':root' || selector.startsWith('body.theme-')) continue;
      // rgba(var(--x), a) is the supported way to take a themed hue at partial alpha.
      for (const hit of match[2].matchAll(/#[0-9A-Fa-f]{3,8}\b|\brgba?\((?!var\()[^)]*\)|\bhsla?\([^)]*\)/g)) {
        offenders.push(`${hit[0]}  in  ${selector}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Colour literals outside a theme block — these cannot follow the theme, so they '
      + 'are whatever they were on the day they were typed:\n  ' + offenders.join('\n  ')
      + '\nUse a variable, and add it to every theme. For partial alpha use '
      + 'rgba(var(--hue-rgb), a).',
    );
  });
}

// The second half of "colour is themed": using the RIGHT KIND of token.
//
// The literals were only half the problem. `background: var(--ink-70)` has no literal in
// it and is still wrong — --ink-70 is the colour of TEXT, so a busy button painted with
// it came out as a pale slab on every dark theme, brighter while working than while
// idle. Same for the density fills, which used --ink itself as the top of a scale that
// starts at 5% ink.
//
// So: a foreground token may not be used as a background. The exceptions are real and
// few, and each is named here rather than left to judgement.
const FG_AS_BG_ALLOWED = new Set([
  // Inverted selection is the point — it must contrast with everything around it.
  '::selection',
  'body.theme-phosphor ::selection',
  // A focus ring and a live drag handle: 2px of deliberate maximum contrast.
  '.split:focus-visible::after',
  'body.is-splitting .split::after',
]);

for (const file of fs.readdirSync(WEB_CSS).filter((f) => f.endsWith('.css'))) {
  test(`${file}: no foreground token is used as a background`, () => {
    const offenders = [];
    for (const rule of rules(fs.readFileSync(path.join(WEB_CSS, file), 'utf8'))) {
      if (FG_AS_BG_ALLOWED.has(rule.selector)) continue;
      // Only the OPAQUE tokens. --ink-50 and --ink-35 are already rgba of --ink-rgb, so
      // they invert with the theme by construction and are the right way to draw a
      // muted dot or a 2px bar. It is the flat, full-strength fills that go wrong.
      const hit = rule.body.match(/background(-color)?:var\(--(ink|ink-70|on-ink)\)/);
      if (hit) offenders.push(`${hit[0]}  in  ${rule.selector}`);
    }
    assert.deepEqual(
      offenders,
      [],
      'A text colour is being used as a background. On a dark theme --ink is near-white, '
      + 'so these become pale slabs:\n  ' + offenders.join('\n  ')
      + '\nUse --solid-bg for an emphasised surface, or rgba(var(--ink-rgb), a) for a wash.',
    );
  });
}

test('the coach log is block flow, not a flex column', () => {
  const css = fs.readFileSync(path.join(WEB_CSS, 'app.css'), 'utf8');
  const rule = rules(css).find((r) => r.selector === '.coach-log');
  assert.ok(rule, '.coach-log rule not found — the selector was renamed without updating this test');
  assert.ok(rule.body.includes('display:block'), '.coach-log must be display:block');
  assert.ok(!rule.body.includes('flex-direction:column'), '.coach-log must not be a flex column');
});
