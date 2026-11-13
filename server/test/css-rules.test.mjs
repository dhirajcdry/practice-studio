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

const SHAPE_CSS = ['ui.css', 'sidebar.css', 'interview.css', 'report.css', 'submissions.css'];
const shapeDeclarations = (body) => body.split(';').map((part) => part.trim())
  .map((part) => part.match(/^(border(?:-(?!color)[a-z]+)?|border-radius|box-shadow):(.+)$/))
  .filter(Boolean);
const shapeValueOk = (property, value) => {
  if (property === 'border-radius') return /^(?:var\(--[\w-]+\)|0|50%)$/.test(value);
  if (property === 'box-shadow') return /^(?:var\(--[\w-]+\)|none)$/.test(value);
  return /^(?:var\(--[\w-]+\)|0|1px(?: |)solid(?: |)var\(--hair-[\w-]+\))$/.test(value);
};

for (const file of SHAPE_CSS) {
  test(`${file}: component shapes use tokens`, () => {
    const offenders = [];
    for (const rule of rules(fs.readFileSync(path.join(WEB_CSS, file), 'utf8'))) {
      for (const [, property, value] of shapeDeclarations(rule.body)) {
        if (!shapeValueOk(property, value)) offenders.push(`${property}:${value} in ${rule.selector}`);
      }
    }
    assert.deepEqual(offenders, [], 'Shape literals must use a whole token, 0/none/50%, or 1px solid var(--hair-*):\n  ' + offenders.join('\n  '));
  });
}

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

// A missing palette token must not silently inherit a different family's colour.
test('all core families define a complete light and dark palette', () => {
  const css = fs.readFileSync(path.join(WEB_CSS, 'themes.css'), 'utf8');
  const tokens = `ink-rgb on-ink-rgb on-ink canvas card ink ink-70 ink-50 ink-35
    hair-20 hair-10 hair-06 accent accent-rgb accent-soft solid-bg solid-fg solid-edge
    solid-hover easy easy-rgb easy-soft med med-rgb med-soft hard hard-rgb hard-soft
    tok-kw tok-def shadow shadow-lift texture`.split(/\s+/);
  for (const family of ['studio', 'desk', 'dunes']) {
    for (const mode of ['', '.is-dark']) {
      const selector = `body.theme-${family}${mode}`;
      const palette = rules(css).filter(rule => rule.selector === selector);
      assert.equal(palette.length, 1, `${selector}: exactly one palette block`);
      for (const token of tokens) assert.ok(palette[0].body.includes(`--${token}:`), `${selector}: missing ${token}`);
    }
  }
});

test('all theme families define the component shape token contract', () => {
  const css = fs.readFileSync(path.join(WEB_CSS, 'themes.css'), 'utf8');
  const contract = `surface-card-bg surface-card-border surface-card-radius surface-card-shadow surface-card-hover-bg surface-card-hover-shadow
    row-radius row-hover-bg row-gap row-border tab-radius tab-active-bg tab-active-fg tab-active-indicator tab-active-shadow
    chip-radius chip-border chip-font float-radius float-shadow float-border`.split(/\s+/);
  const families = ['studio', 'desk', 'dunes'];
  for (const family of families) {
    const base = rules(css).find(rule => rule.selector === `body.theme-${family}`);
    const dark = rules(css).find(rule => rule.selector === `body.theme-${family}.is-dark`);
    assert.ok(base, `body.theme-${family}: missing palette block`);
    assert.ok(dark, `body.theme-${family}.is-dark: missing palette block`);
    for (const token of contract) {
      assert.ok(base.body.includes(`--${token}:`), `body.theme-${family}: missing --${token}`);
      // Dark themes may inherit geometry, but must define their palette-relative values.
      assert.ok(dark.body.includes(`--${token}:`) || base.body.includes(`--${token}:`), `body.theme-${family}.is-dark: missing --${token}`);
    }
  }
});

test('theme tab selectors support aria-selected wherever they support aria-pressed', () => {
  const css = fs.readFileSync(path.join(WEB_CSS, 'themes.css'), 'utf8');
  const offenders = rules(css).filter(({ selector }) =>
    /\.(?:ui|rr|coach|tc)-tab/.test(selector) && selector.includes('[aria-pressed="true"]')
    && selector.replaceAll(':is([aria-pressed="true"],[aria-selected="true"])', '').includes('[aria-pressed="true"]')
  ).map(({ selector }) => selector);
  assert.deepEqual(offenders, []);
});

test('component defaults exist and no shape token refers to itself', () => {
  const ui = rules(fs.readFileSync(path.join(WEB_CSS, 'ui.css'), 'utf8'));
  const defaults = ui.filter(({ selector }) => selector.includes(':root')).map(({ body }) => body).join(';');
  const theme = rules(fs.readFileSync(path.join(WEB_CSS, 'themes.css'), 'utf8'));
  for (const { body } of [...ui, ...theme]) {
    for (const [, token, value] of body.matchAll(/(?:^|;)(--[\w-]+):([^;]+)/g)) {
      assert.ok(!value.includes(`var(${token})`), `${token} cannot refer to itself`);
      if (/^--(?:surface-card|row|tab|chip|float)-/.test(token)) {
        assert.ok(defaults.includes(`${token}:`), `${token} needs a deliberate default in ui.css`);
      }
    }
  }
});

// These surfaces share one spacing owner. Reintroducing feature-level padding or
// positioned trailing actions recreates the repeated cramped-card regressions.
test('content surfaces do not override shared inset geometry', () => {
  const surfaces = new Set(['.recent-chat', '.submission-row', '.sidebar-record-summary',
    '.submission-card', '.rr-tutor', '.state', '.ws-notice', '.ci-setup', '.ci-live-header',
    '.ci-notice', '.ci-paused', '.ci-score-hero', '.ci-empty-session', '.set-card',
    '.set-themes .set-card', '.th-item', '.cmsg-receipt', '.detail-problem']);
  const offenders=[];
  for (const file of fs.readdirSync(WEB_CSS).filter(f=>f.endsWith('.css') && f!=='ui.css')) {
    const css=fs.readFileSync(path.join(WEB_CSS,file),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
    for (const rule of rules(css)) {
      const selectors=rule.selector.split(',').map(s=>s.trim().replace(/^body(?:\[class\])?\s+/,''));
      if (selectors.some(s=>surfaces.has(s)) && /(?:^|;)padding(?:-[\w-]+)?:/.test(rule.body))
        offenders.push(`${file}: ${rule.selector}`);
      if (selectors.some(s=>/^\.(?:recent-chevron|submission-chevron|interview-row-resume)$/.test(s)) && /position:absolute|(?:^|;)(?:right|left):/.test(rule.body))
        offenders.push(`${file}: positioned trailing control ${rule.selector}`);
      if (selectors.some(s=>s==='.hover-surface') && /(?:^|;)(?:padding|margin)(?:-[\w-]+)?:/.test(rule.body))
        offenders.push(`${file}: hover treatment owns spacing`);
    }
  }
  assert.deepEqual(offenders, [], 'Use the ui-inset/row/cluster contract instead of a competing geometry rule');
});


test('styles never reintroduce backdrop filtering or retired theme selectors', () => {
  for (const file of fs.readdirSync(WEB_CSS).filter(file => file.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(WEB_CSS, file), 'utf8');
    assert.doesNotMatch(css, /backdrop-filter\s*:/, file);
    assert.doesNotMatch(css, /theme-(?:editorial|ink|terminal|scoreboard|nebula|horizon|abyss)\b/, file);
  }
});


test('feature button class literals use shared variants or content rows', () => {
  const dir = path.resolve(WEB_CSS, '../js');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/el\('button',\s*\{(?:(?!el\(|\}).){0,300}?class:\s*(['"`])([^'"`]*)\1/gs)) {
      const classes = match[2].split(/\s+/);
      if (classes.includes('ui-action-row')) continue;
      assert.ok(classes.includes('btn'), `${file}: ${match[2]}`);
      if (!classes.some(name => ['btn--primary', 'btn--secondary', 'btn--quiet', 'btn--icon'].includes(name))) offenders.push(`${file}: ${match[2]}`);
      if (classes.some(name => name.startsWith('btn--') && !['btn--primary', 'btn--secondary', 'btn--quiet', 'btn--icon', 'btn--lg'].includes(name))) offenders.push(`${file}: ${match[2]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// An unclosed `:is(` does not fail loudly: the parser swallows that rule and every rule
// after it in the file. themes.css shipped that way and lost its last ten rules.
test('every selector closes its parentheses', () => {
  for (const file of fs.readdirSync(WEB_CSS).filter(name => name.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(WEB_CSS, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{};]+)\{/g)) {
      const selector = match[1].trim();
      const open = (selector.match(/\(/g) || []).length, close = (selector.match(/\)/g) || []).length;
      assert.equal(open, close, `${file}: unbalanced parentheses in "${selector.slice(0, 120)}"`);
    }
  }
});
