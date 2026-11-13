export function visualLint() {
  // In-page visual lint. Returns findings about what is actually rendered.
  // Catches the shipped defects this audit is intended to expose:
  // controls that sit on different baselines, accidental toolbar gaps/overlaps,
  // labels touching compact chips, clipped drawer text, unreadable muted text,
  // and a flush child escaping the inset shared by a stacked pane.
  const out = [];
  const modal = document.querySelector('dialog:modal');
  const visible = (node) => {
    // Content behind a modal is inert and covered by its backdrop, not a reading surface.
    if (modal && !modal.contains(node)) return false;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (!node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
  };
  const name = n => {
    const parts = []; let x = n;
    for (let i = 0; x && i < 3 && x !== document.body; i++, x = x.parentElement) {
      const cls = typeof x.className === 'string' ? x.className : (x.className?.baseVal || '');
      parts.unshift(x.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).slice(0, 3).join('.') : ''));
    }
    return parts.join(' > ');
  };
  const label = (node) => (node.getAttribute?.('aria-label') || node.textContent || '')
    .trim().replace(/\s+/g, ' ').slice(0, 24);
  const CONTROL = 'button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], .codicon, .chip, .tag, kbd, a.ws-mini, .matchesCount, .monaco-inputbox';
  const vw = innerWidth, vh = innerHeight;
  const onScreen = (rect) => rect.width > 0 && rect.height > 0
    && rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;

  // Parsing Markdown does not style it. Check every rendered consumer, including
  // saved feedback that is not part of the live conversation component.
  for (const block of document.querySelectorAll('[data-markdown-block]')) {
    if (visible(block) && !block.closest('.rich'))
      out.push({kind:'markdown-surface',where:name(block),detail:'Markdown bypasses the shared typography surface'});
  }

  // Shared content contracts: every adopted surface gets these checks in every
  // visual state, not only in a screenshot-specific assertion.
  for (const node of document.querySelectorAll('.ui-inset')) {
    if (!visible(node)) continue;
    const box=node.getBoundingClientRect(), style=getComputedStyle(node);
    if (!onScreen(box)) continue;
    const inset=parseFloat(style.getPropertyValue('--content-inset'));
    if (!Number.isFinite(inset) || inset < 8) {
      out.push({kind:'content-inset',where:name(node),detail:'Missing or undersized content inset'}); continue;
    }
    for (const edge of ['Top','Right','Bottom','Left']) {
      if (parseFloat(style['padding'+edge]) < inset-0.5)
        out.push({kind:'content-inset',where:name(node),detail:`${edge} padding bypasses shared inset`});
    }
    const bounds={left:box.left+parseFloat(style.borderLeftWidth)+inset,
      right:box.right-parseFloat(style.borderRightWidth)-inset,
      top:box.top+parseFloat(style.borderTopWidth)+inset,
      bottom:box.bottom-parseFloat(style.borderBottomWidth)-inset};
    for (const child of node.children) {
      if (!visible(child)) continue;
      const r=child.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if ((!(/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) && (r.left < bounds.left-1 || r.right > bounds.right+1)) || (!(/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) && (r.top < bounds.top-1 || r.bottom > bounds.bottom+1)))
        out.push({kind:'content-inset',where:name(child),detail:`Child escapes ${inset}px content inset`});
    }
  }
  for (const node of document.querySelectorAll('.ui-row,.ui-cluster')) {
    if (!visible(node)) continue;
    const items=[...node.children].filter(visible).map(n=>({n,r:n.getBoundingClientRect()})).filter(x=>x.r.width&&x.r.height);
    const gap=parseFloat(getComputedStyle(node).columnGap);
    for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) {
      const a=items[i],b=items[j];
      const horizontal=Math.max(b.r.left-a.r.right,a.r.left-b.r.right);
      const vertical=Math.max(b.r.top-a.r.bottom,a.r.top-b.r.bottom);
      if (horizontal < gap-1 && vertical < gap-1)
        out.push({kind:'content-gap',where:name(node),detail:`Children ${label(a.n)} / ${label(b.n)} lack ${gap}px separation`});
    }
  }

  // 1 + 2: catch a misaligned HIDE button or an accidental extra toolbar gap.
  // A row contains controls under one parent whose vertical ranges overlap.
  const parents = new Map();
  for (const n of document.querySelectorAll(CONTROL)) {
    if (!visible(n) || n.closest('.ui-turn-body, .hist-answer, pre, .view-lines')) continue;
    const r = n.getBoundingClientRect();
    if (!onScreen(r) || r.height > 48) continue;
    // Walk up past single-child wrappers so a button in a <span> still meets its siblings.
    let p = n.parentElement;
    while (p && p.children.length === 1 && p.parentElement) p = p.parentElement;
    if (!p) continue;
    if (!parents.has(p)) parents.set(p, []);
    parents.get(p).push({ n, r });
  }
  for (const [p, items] of parents) {
    // Ignore nested controls (an input inside a control we already have).
    const flat = items.filter(a => !items.some(b => b !== a && b.n.contains(a.n)));
    const rows = [];
    for (const it of flat.sort((a, b) => a.r.top - b.r.top)) {
      let row = rows.find(rw => it.r.top < rw.bottom - 2 && it.r.bottom > rw.top + 2);
      if (!row) rows.push(row = { top: it.r.top, bottom: it.r.bottom, items: [] });
      row.top = Math.min(row.top, it.r.top); row.bottom = Math.max(row.bottom, it.r.bottom);
      row.items.push(it);
    }
    for (const row of rows) {
      if (row.items.length < 2) continue;
      const cys = row.items.map(i => i.r.top + i.r.height / 2).sort((a, b) => a - b);
      const median = cys[Math.floor(cys.length / 2)];
      for (const it of row.items) {
        const d = it.r.top + it.r.height / 2 - median;
        if (Math.abs(d) > 1.5) out.push({ kind: 'misaligned', where: name(it.n), what: label(it.n), detail: `centre ${d > 0 ? '+' : ''}${d.toFixed(1)}px vs row (${row.items.length} controls in ${name(p)})` });
      }
      const xs = row.items.map(i => i.r).sort((a, b) => a.left - b.left);
      if (xs.length >= 3) {
        const gaps = xs.slice(1).map((r, i) => r.left - xs[i].right);
        const sorted = [...gaps].sort((a, b) => a - b); const mg = sorted[Math.floor(sorted.length / 2)];
        gaps.forEach((g, i) => {
          if (g < -0.5) out.push({ kind: 'overlap', where: name(p), what: `${label(row.items.find(t => t.r === xs[i]).n)} / ${label(row.items.find(t => t.r === xs[i + 1]).n)}`, detail: `controls overlap by ${(-g).toFixed(1)}px` });
          else if (mg >= 0 && mg <= 12 && g > mg + 6 && g < 40) out.push({ kind: 'gap-outlier', where: name(p), what: `before ${label(row.items.find(t => t.r === xs[i + 1]).n)}`, detail: `gap ${g.toFixed(1)}px vs typical ${mg.toFixed(1)}px` });
        });
      }
    }
  }

  // 3: catch labels pressed against a pill or button edge after theme font changes.
  // Only test elements with a visible background or border.
  const hasBox = (style) => (style.backgroundColor
    && !/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor))
    || parseFloat(style.borderLeftWidth) > 0 || parseFloat(style.borderTopWidth) > 0;
  for (const n of document.querySelectorAll('button, .chip, .tag, input, select, .ws-mini, .card, [class*="pill"], [class*="badge"], [class*="notice"], [class*="toast"], .submission-stat, .hover-surface')) {
    if (!visible(n) || n.closest('.monaco-editor .view-lines')) continue;
    const s = getComputedStyle(n); const r = n.getBoundingClientRect();
    if (!onScreen(r) || r.height > 90 || !hasBox(s)) continue;
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let t; const range = document.createRange();
    while ((t = walker.nextNode())) {
      if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (!visible(el)) continue;
      range.selectNodeContents(t);
      const tr = range.getBoundingClientRect(); if (!tr.width) continue;
      const bl = parseFloat(s.borderLeftWidth) || 0, br = parseFloat(s.borderRightWidth) || 0;
      const left = tr.left - r.left - bl, right = r.right - br - tr.right;
      if ((left < 3 || right < 3) && r.width > tr.width + 0.5 && tr.width > 8) {
        out.push({ kind: 'edge-tight', where: name(n), what: label(n), detail: `text ${left.toFixed(1)}px from left / ${right.toFixed(1)}px from right edge` });
        break;
      }
    }
  }

  // 4: catch labels cut off by fixed widths; deliberate ellipsis and line-clamp are allowed.
  for (const n of document.querySelectorAll('body *')) {
    if (n.children.length > 3 || !visible(n)) continue;
    const s = getComputedStyle(n);
    if (!/hidden|clip/.test(s.overflowX) || s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') continue;
    if (n.closest('.monaco-editor, .excalidraw, svg')) continue;
    const r = n.getBoundingClientRect(); if (!onScreen(r)) continue;
    if (n.scrollWidth > n.clientWidth + 2 && (n.textContent || '').trim().length > 2 && n.clientWidth > 20) out.push({ kind: 'clipped', where: name(n), what: label(n), detail: `content ${n.scrollWidth}px in ${n.clientWidth}px` });
  }

  // 5: catch a verdict or control label that disappears into a solid theme surface.
  // Painted backgrounds need visual review; guessing their contrast would mislead.
  const rgb = (color) => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const channel = (value) => {
      value /= 255;
      return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    };
    return .2126 * channel(r) + .7152 * channel(g) + .0722 * channel(b);
  };
  const seen = new Set();
  for (const n of document.querySelectorAll('button, a, p, span, label, h1, h2, h3, h4, small, strong, td, li, .tag, .chip')) {
    if (!visible(n) || ![...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;
    if (n.closest('.monaco-editor .view-lines, .excalidraw, [disabled], [aria-disabled=true]')) continue;
    const r = n.getBoundingClientRect(); if (!onScreen(r)) continue;
    const s = getComputedStyle(n); const fg = rgb(s.color); if (!fg || fg.a < .99 && parseFloat(s.opacity) < 1) continue;
    let bg = null, x = n, painted = false;
    while (x) { const xs = getComputedStyle(x); if (xs.backgroundImage !== 'none') { painted = true; break; } const c = rgb(xs.backgroundColor); if (c && c.a > .95) { bg = c; break; } x = x.parentElement; }
    if (painted || !bg) continue;
    const report = n.closest('.rp-body');
    const over = (front, back) => ({ r: front.r * front.a + back.r * (1 - front.a), g: front.g * front.a + back.g * (1 - front.a), b: front.b * front.a + back.b * (1 - front.a), a: 1 });
    if (report) {
      // Report text uses translucent ink tokens and selected-row washes. Measure
      // their painted colour, not the uncomposited RGB channels of rgba().
      const layers = []; let ancestor = n;
      while (ancestor) { const color = rgb(getComputedStyle(ancestor).backgroundColor); if (color) layers.push(color); if (color?.a >= .99) break; ancestor = ancestor.parentElement; }
      bg = layers.reverse().reduce((back, front) => over(front, back), bg);
    }
    const L1 = lum(report ? over(fg, bg) : fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
    const size = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight) >= 600;
    const need = report ? 4.5 : size >= 24 || (size >= 18.6 && bold) ? 3 : 4.5;
    const key = name(n) + s.color;
    if (ratio < need - .05 && !seen.has(key)) { seen.add(key); out.push({ kind: 'contrast', where: name(n), what: label(n), detail: `${ratio.toFixed(2)}:1 (needs ${need}) ${s.color} on rgb(${bg.r},${bg.g},${bg.b}) at ${size}px` }); }
  }

  // 6: a child that starts at a different inset from its stacked siblings (the "button flush
  // with the pane edge while everything above it is inset 16px" defect). Full-bleed children
  // (as wide as the container) are deliberate and skipped.
  for (const c of document.querySelectorAll('body *')) {
    if (!visible(c) || c.closest('.monaco-editor, .excalidraw, svg, pre')) continue;
    const cs = getComputedStyle(c);
    if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection)) continue; // a row, not a stack
    if (/grid/.test(cs.display)) continue;
    const cr = c.getBoundingClientRect(); if (!onScreen(cr) || cr.width < 120) continue;
    const kids = [...c.children].filter(k => {
      if (!visible(k) || /^(UL|OL|BLOCKQUOTE|FIGURE|DD)$/.test(k.tagName)) return false; const ks = getComputedStyle(k);
      if (/absolute|fixed/.test(ks.position) || ks.float !== 'none') return false;
      const r = k.getBoundingClientRect(); return r.width > 8 && r.height > 6;
    });
    if (kids.length < 3) continue;
    // Where each child's content visibly starts: a full-width child insets through its own
    // padding, a narrower one (a button) through its position.
    const full = k => k.getBoundingClientRect().width >= cr.width - 1.5;
    const offs = kids.map(k => { const ks = getComputedStyle(k); const r = k.getBoundingClientRect();
      return Math.round(r.left - cr.left + (full(k) ? parseFloat(ks.paddingLeft) + parseFloat(ks.borderLeftWidth) : 0)); });
    const counts = new Map(); offs.forEach(o => counts.set(o, (counts.get(o) || 0) + 1));
    const [mode, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < 2) continue;
    kids.forEach((k, i) => {
      const d = offs[i] - mode;
      // Centred children (e.g. an empty-state block) are deliberate; only flag left-anchored strays.
      const kr = k.getBoundingClientRect(); const centred = Math.abs((kr.left + kr.right) / 2 - (cr.left + cr.right) / 2) < 2;
      if (!full(k) && Math.abs(d) >= 4 && Math.abs(d) <= 40 && !centred) out.push({ kind: 'inset-mismatch', where: name(k), what: label(k), detail: `starts ${d > 0 ? '+' : ''}${d}px from its ${n} siblings' inset in ${name(c)}` });
    });
  }

  // 7: boxes pressed together. Two drawn edges (a border, or a fill that differs from
  // what is behind it) closer than the smallest block gap read as one muddled line:
  // a card a pixel under a tab rule, bordered rows stacked inside a bordered card.
  // A shared hairline (exactly flush, square corners) is a divider and is allowed.
  const MIN_BOX_GAP = 8;
  const painted = (color) => { const c = rgb(color); return !!c && c.a > .04; };
  const backdrop = (node) => {
    for (let x = node.parentElement; x; x = x.parentElement) {
      const c = getComputedStyle(x).backgroundColor;
      if (painted(c)) return c;
    }
    return '';
  };
  const boxes = [];
  const topbarNode = document.querySelector('.topbar');
  const topbarRect = topbarNode && visible(topbarNode) && getComputedStyle(topbarNode).position === 'sticky' ? topbarNode.getBoundingClientRect() : null;
  for (const n of document.querySelectorAll('body *')) {
    if (boxes.length > 600) break;
    if (n.closest('.monaco-editor, .excalidraw, svg, pre, .ui-turn-body, .rich, dialog:not(:modal)') || !visible(n)) continue;
    const r = n.getBoundingClientRect();
    if (!onScreen(r) || r.width < 120 || r.height < 24) continue;
    // Compact controls sit in bars by design; their spacing has its own rules above.
    if (r.height < 40 && n.matches('.segmented, .segmented *, ' + CONTROL)) continue;
    const s = getComputedStyle(n);
    if (/absolute|fixed/.test(s.position)) continue;
    // Content scrolled behind the pinned app bar is covered by it, not beside it.
    if (topbarRect && !n.closest('.topbar') && r.top < topbarRect.bottom - 1 && r.bottom > topbarRect.top) continue;
    const filled = painted(s.backgroundColor) && s.backgroundColor !== backdrop(n);
    const edges = {};
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      edges[side] = filled || (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none' && painted(s[`border${side}Color`]));
    if (!Object.values(edges).some(Boolean)) continue;
    // A menu, dialog or drawer floats over the page; it is not the page's neighbour.
    const layer = n.closest('dialog, [popover], .settings, .drawer, .ui-menu, .ui-popover');
    boxes.push({ n, r, edges, layer, roundTop: parseFloat(s.borderTopLeftRadius) > 0 || parseFloat(s.borderTopRightRadius) > 0,
      roundBottom: parseFloat(s.borderBottomLeftRadius) > 0 || parseFloat(s.borderBottomRightRadius) > 0,
      roundLeft: parseFloat(s.borderTopLeftRadius) > 0 || parseFloat(s.borderBottomLeftRadius) > 0,
      roundRight: parseFloat(s.borderTopRightRadius) > 0 || parseFloat(s.borderBottomRightRadius) > 0 });
  }
  const crowded = new Map();
  const crowd = (a, b, gap, how) => {
    const key = name(a.n) + ' | ' + name(b.n) + ' | ' + how;
    const prior = crowded.get(key);
    if (prior) { prior.count++; return; }
    crowded.set(key, { count: 1, where: name(b.n), what: label(b.n), gap, how, against: name(a.n) });
  };
  // Flush is a shared edge unless a rounded corner meets it, which leaves two notches.
  // Up to a hairline apart is one divider drawn by whichever side owns it.
  const tight = (gap, rounded) => (gap > 1.5 && gap < MIN_BOX_GAP - .5) || (Math.abs(gap) <= 1.5 && rounded);
  for (let i = 0; i < boxes.length; i++) for (let j = 0; j < boxes.length; j++) {
    if (i === j) continue;
    const a = boxes[i], b = boxes[j];
    if (a.layer !== b.layer) continue;
    if (a.n.contains(b.n)) {
      // A box nearly, but not exactly, flush inside a drawn container. Control tracks
      // (a segmented switch and its raised option) are deliberately tight.
      if (a.r.height < 56) continue;
      for (const [side, d] of [['Top', b.r.top - a.r.top], ['Bottom', a.r.bottom - b.r.bottom], ['Left', b.r.left - a.r.left], ['Right', a.r.right - b.r.right]])
        if (a.edges[side] && b.edges[side] && d > 1.5 && d < MIN_BOX_GAP - .5) crowd(a, b, d, `inside, ${side.toLowerCase()} edges`);
      continue;
    }
    if (b.n.contains(a.n)) continue;
    const overlapX = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const overlapY = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    const below = b.r.top - a.r.bottom, beside = b.r.left - a.r.right;
    if (overlapX > 40 && a.edges.Bottom && b.edges.Top && tight(below, a.roundBottom || b.roundTop)) crowd(a, b, below, 'stacked');
    // Side by side applies to blocks; chips and buttons in a toolbar have their own rules.
    else if (overlapY > 16 && Math.max(a.r.height, b.r.height) >= 56 && a.edges.Right && b.edges.Left && tight(beside, a.roundRight || b.roundLeft)) crowd(a, b, beside, 'side by side');
  }
  for (const c of crowded.values())
    out.push({ kind: 'crowded', where: c.where, what: c.what, detail: `${c.gap.toFixed(1)}px from ${c.against} (${c.how}${c.count > 1 ? `, ×${c.count}` : ''}); blocks need ${MIN_BOX_GAP}px or a shared edge` });

  // 8: a bar pinned a little below the app bar leaves a slot the page scrolls through.
  // Measured for real: scroll, see where the bar sticks, and ask what is painted above it.
  const page = document.scrollingElement;
  if (page && page.scrollHeight > innerHeight + 400) {
    const restore = page.scrollTop;
    page.scrollTo({ top: restore + 360, behavior: 'instant' });
    const appBar = document.querySelector('.topbar');
    const barRect = appBar && visible(appBar) ? appBar.getBoundingClientRect() : null;
    const appFloor = barRect && barRect.bottom > 0 ? barRect.bottom : 0;
    const stuck = [];
    for (const n of document.querySelectorAll('body *')) {
      const s = getComputedStyle(n);
      if (s.position !== 'sticky' || s.zIndex === 'auto' || n === appBar || !visible(n)) continue;
      const r = n.getBoundingClientRect();
      if (Math.abs(r.top - parseFloat(s.top)) > 1 || r.width < 200) continue; // not stuck
      stuck.push({ n, r });
    }
    for (const { n, r } of stuck) {
      // A bar may dock beneath another pinned bar; that bar is then its floor.
      const floor = Math.max(appFloor, ...stuck.filter(o => o.n !== n && o.r.bottom <= r.top + 1.5
        && o.r.left < r.right && o.r.right > r.left).map(o => o.r.bottom));
      const slot = r.top - floor;
      if (slot < 1.5) continue;
      // A bar may fill its own slot with a strip of page colour drawn just above itself.
      const masked = ['::before', '::after'].some(pseudo => {
        const p = getComputedStyle(n, pseudo);
        return p.content !== 'none' && p.position === 'absolute' && painted(p.backgroundColor)
          && parseFloat(p.height) >= slot - .5 && Math.abs(parseFloat(p.bottom) - r.height) < 4;
      });
      if (masked) continue;
      out.push({ kind: 'sticky-slot', where: name(n), detail: `Pins ${slot.toFixed(0)}px below ${floor ? 'the bar above it' : 'the window edge'}; scrolled content shows through the slot` });
    }
    page.scrollTo({ top: restore, behavior: 'instant' });
  }

  // 9: the same slot inside a scrolling pane. A scroller's padding sits outside what
  // sticky measures, so a header or action bar pinned with top:0 / bottom:0 stops one
  // padding short of the pane edge and the content shows through the strip.
  for (const n of document.querySelectorAll('body *')) {
    const s = getComputedStyle(n);
    if (s.position !== 'sticky' || !visible(n) || !painted(s.backgroundColor)) continue;
    let scroller = n.parentElement;
    while (scroller && scroller !== document.body && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller || scroller === document.body || scroller.scrollHeight <= scroller.clientHeight + 40) continue;
    const ss = getComputedStyle(scroller), restore = scroller.scrollTop;
    for (const [side, pad] of [['top', parseFloat(ss.paddingTop)], ['bottom', parseFloat(ss.paddingBottom)]]) {
      if (s[side] === 'auto' || pad < 1.5) continue;
      scroller.scrollTop = side === 'top' ? scroller.scrollHeight : 0;
      const r = n.getBoundingClientRect(), box = scroller.getBoundingClientRect();
      const edge = side === 'top' ? box.top + scroller.clientTop : box.top + scroller.clientTop + scroller.clientHeight;
      const slot = side === 'top' ? r.top - edge : edge - r.bottom;
      // Only a bar that is actually pinned (not resting at its natural place) counts.
      const natural = side === 'top' ? scroller.scrollTop < 2 : scroller.scrollTop > scroller.scrollHeight - scroller.clientHeight - 2;
      if (!natural && slot > 1.5 && slot <= pad + 1.5) out.push({ kind: 'sticky-slot', where: name(n), detail: `Pins ${slot.toFixed(0)}px short of its pane's ${side} edge; scrolled content shows through the strip` });
    }
    scroller.scrollTop = restore;
  }

  // 10: data cut in the middle of a value. Unspaced test data ("[1,2],[3]") is one word
  // to the browser, so overflow-wrap:anywhere slices numbers and names at the box edge
  // unless the markup offers a break after each comma.
  for (const n of document.querySelectorAll('pre, .mono')) {
    if (!visible(n) || n.closest('.monaco-editor, .submission-code, .solutioncode, .rich, .ui-turn-body')) continue;
    const s = getComputedStyle(n);
    if (!/anywhere|break-word/.test(s.overflowWrap) && s.wordBreak !== 'break-all') continue;
    if (!onScreen(n.getBoundingClientRect()) || !n.textContent.includes(',')) continue;
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    const range = document.createRange(); let t, checked = 0, split = null;
    while (!split && (t = walker.nextNode()) && checked < 4000) {
      const text = t.textContent;
      for (let i = 1; i < text.length && checked < 4000; i++, checked++) {
        if (!/[\w"'.-]/.test(text[i]) || !/[\w"'.-]/.test(text[i - 1])) continue;
        range.setStart(t, i - 1); range.setEnd(t, i); const a = range.getBoundingClientRect();
        range.setStart(t, i); range.setEnd(t, i + 1); const b = range.getBoundingClientRect();
        if (a.height && b.height && b.top > a.top + a.height / 2) { split = text.slice(Math.max(0, i - 6), i) + '⏎' + text.slice(i, i + 6); break; }
      }
    }
    // A single value longer than the line has nowhere better to break.
    if (split && n.querySelector('wbr') === null) out.push({ kind: 'token-split', where: name(n), what: split, detail: 'Line breaks inside a value; offer breaks between values (dataText)' });
    else if (split) {
      const widest = Math.max(...n.textContent.split(/[,\n]/).map(part => part.length));
      const columns = Math.floor((n.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) / (parseFloat(s.fontSize) * .6));
      if (widest < columns - 1) out.push({ kind: 'token-split', where: name(n), what: split, detail: 'Line breaks inside a value that would fit on its own line' });
    }
  }

  // Monaco's gutter width grows with digit count; it must not own pane spacing.
  for (const frame of document.querySelectorAll('.python-editor-frame')) {
    if (!visible(frame)) continue;
    const f=frame.getBoundingClientRect(), viewport=frame.querySelector('.python-editor-viewport');
    if (!onScreen(f) || !viewport) continue;
    const v=viewport.getBoundingClientRect(), inset=parseFloat(getComputedStyle(frame).getPropertyValue('--python-editor-edge-inset'));
    if (!Number.isFinite(inset) || inset<8 || v.left-f.left<inset-1 || f.right-v.right<inset-1)
      out.push({kind:'editor-edge',where:name(frame),detail:'Editor viewport bypasses its shared edge inset'});
    for(const number of frame.querySelectorAll('.line-numbers')) {
      if(!number.textContent.trim() || !visible(number))continue;
      const range=document.createRange();range.selectNodeContents(number);
      if(range.getBoundingClientRect().left<f.left+inset-1)
        out.push({kind:'editor-gutter',where:name(frame),detail:'Line-number ink touches the pane edge'});
    }
  }

  // Bounded workspace panes: one scroll owner, controls inside the pane, and no
  // sticky-overlay overlap. Completed cards and off-screen mobile states are not
  // live workspace surfaces and are intentionally excluded.
  for (const pane of document.querySelectorAll('.ui-pane')) {
    if (!visible(pane) || pane.closest('.is-complete')) continue;
    const pr = pane.getBoundingClientRect();
    if (innerWidth < 901 && !onScreen(pr)) continue;
    const scrolls = [...pane.children].filter(n => n.matches('.ui-pane-scroll'));
    const controls = [...pane.children].filter(n => !n.matches('.ui-pane-scroll') && visible(n));
    if (scrolls.length !== 1) out.push({ kind: 'pane-structure', where: name(pane), detail: 'Expected exactly one direct .ui-pane-scroll owner' });
    const sr = scrolls[0]?.getBoundingClientRect();
    if (sr && visible(scrolls[0])) {
      if (innerWidth >= 901 && sr.height < 80) out.push({ kind: 'pane-height', where: name(scrolls[0]), detail: `Scroll pane is only ${sr.height.toFixed(1)}px tall` });
      for (const control of controls) {
        const cr = control.getBoundingClientRect();
        if (cr.left < pr.left - 1 || cr.right > pr.right + 1 || cr.top < pr.top - 1 || cr.bottom > pr.bottom + 1)
          out.push({ kind: 'pane-controls', where: name(control), detail: 'Controls escape pane edges' });
        if (cr.top < sr.bottom - 1 && cr.bottom > sr.top + 1)
          out.push({ kind: 'pane-overlap', where: name(control), detail: 'Controls overlap scroll owner' });
      }
    }
  }
  for (const workspace of document.querySelectorAll('.ui-workspace')) {
    if (!visible(workspace) || innerWidth < 901) continue;
    const wr = workspace.getBoundingClientRect();
    if (wr.top < -1 || wr.bottom > innerHeight + 1) out.push({ kind: 'workspace-viewport', where: name(workspace), detail: 'Workspace does not fit viewport' });
    if (document.scrollingElement.scrollHeight > innerHeight + 1) out.push({ kind: 'workspace-overflow', where: name(workspace), detail: 'Document has vertical overflow' });
  }
  for (const header of document.querySelectorAll('.ui-dialog-header')) {
    if (!visible(header)) continue;
    const close = header.querySelector('.ui-dialog-close'), h = header.getBoundingClientRect(), c = close?.getBoundingClientRect(), s = getComputedStyle(header);
    if (!c || Math.abs(h.right - c.right - parseFloat(s.paddingRight)) > 2 || Math.abs((c.top + c.bottom) / 2 - (h.top + h.bottom) / 2) > 2)
      out.push({ kind: 'dialog-close', where: name(header), detail: 'Close must occupy the top-right header rail' });
  }
  // Input can grow or scroll; the send/mode rail must always remain reachable.
  for (const composer of document.querySelectorAll('.ui-composer')) {
    if (!visible(composer)) continue;
    const rail = composer.querySelector('.ui-composer-footer');
    const box = composer.getBoundingClientRect(), footer = rail && visible(rail) ? rail.getBoundingClientRect() : null;
    if (footer && (footer.left < box.left - 1 || footer.right > box.right + 1 || footer.bottom > box.bottom + 1))
      out.push({ kind: 'composer-controls', where: name(composer), detail: 'Input growth clips the control rail' });
    if (composer.scrollWidth > composer.clientWidth + 1)
      out.push({ kind: 'composer-width', where: name(composer), detail: 'Composer requires horizontal scrolling' });
  }
  for (const header of document.querySelectorAll('.ui-workspace-header')) {
    if (!visible(header)) continue;
    const identity = header.querySelector('.ui-workspace-identity').getBoundingClientRect(), actions = header.querySelector('.ui-header-actions').getBoundingClientRect();
    if (identity.right > actions.left && identity.bottom > actions.top && actions.bottom > identity.top && actions.width)
      out.push({ kind: 'header-overlap', where: name(header), detail: 'Title and actions overlap' });
  }
  return out;
}
