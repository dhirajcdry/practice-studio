import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/css/themes.css'), 'utf8');
const themes = ['studio', 'desk', 'editorial', 'ink', 'terminal', 'nebula', 'horizon', 'abyss', 'dunes'];
const declarations = (selector) => {
  const matches = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
    m[1].split(',').map((s) => s.trim().split('\n').pop().trim()).includes(selector));
  assert.ok(matches.length, `${selector}: theme block not found`);
  return Object.fromEntries(matches.flatMap((m) =>
    [...m[2].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((hit) => [hit[1], hit[2].trim()])));
};
const channel = (value) => {
  const n = parseInt(value, 16) / 255;
  return n <= .03928 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const clean = hex.slice(1);
  return .2126 * channel(clean.slice(0, 2)) + .7152 * channel(clean.slice(2, 4)) + .0722 * channel(clean.slice(4, 6));
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
};
const rgbHex = (value) => `#${value.split(',').map((part) => Number(part.trim()).toString(16).padStart(2, '0')).join('')}`;
const blend = (foreground, background, alpha) => {
  const fg = foreground.slice(1).match(/../g).map((part) => parseInt(part, 16));
  const bg = background.slice(1).match(/../g).map((part) => parseInt(part, 16));
  return `#${fg.map((part, i) => Math.round(part * alpha + bg[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
};

test('submission verdict tokens meet 4.5:1 against every theme card', () => {
  for (const theme of themes) {
    for (const mode of ['', '.is-dark']) {
      const palette = declarations(`body.theme-${theme}${mode}`);
      for (const token of ['verdict-easy', 'verdict-hard', 'verdict-med']) {
        assert.ok(palette[token], `${theme}${mode}: missing --${token}`);
        assert.ok(contrast(palette[token], palette.card) >= 4.5,
          `${theme}${mode}: --${token} ${palette[token]} against ${palette.card} is below 4.5:1`);
      }

      // The hero paints a 7% status wash over the card and fades to the card.
      // Check several points through that fade so a token cannot pass only at
      // the un-tinted edge of the gradient.
      const easyWash = rgbHex(palette['easy-rgb']);
      const hardWash = rgbHex(palette['hard-rgb']);
      for (const alpha of [.07, .05, .03, 0]) {
        for (const base of ['card', 'canvas']) {
          const easySurface = blend(easyWash, palette[base], alpha);
          const hardSurface = blend(hardWash, palette[base], alpha);
          assert.ok(contrast(palette['verdict-easy'], easySurface) >= 4.5,
            `${theme}${mode}: easy hero over ${base} at ${alpha} wash is below 4.5:1`);
          for (const token of ['verdict-hard', 'verdict-med']) {
            assert.ok(contrast(palette[token], hardSurface) >= 4.5,
              `${theme}${mode}: ${token} rejected hero over ${base} at ${alpha} wash is below 4.5:1`);
          }
        }
      }
    }
  }
});
