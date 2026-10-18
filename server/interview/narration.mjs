import { PHASES } from './state.mjs';
// Hold from the FIRST possible opener, including a single '['. Tags are a control
// channel sharing speech; even one leaked prefix is too late to strip on completion.
export function createTagStripper() {
  let held = '', phase = null;
  const hints = [];
  const possible = tail => {
    const compact = tail.toLowerCase().replace(/\s/g, '');
    return ['[[phase:', '[[hint:'].some(opener => opener.startsWith(compact) || (compact.startsWith(opener) && !compact.includes(']]')));
  };
  return {
    push(chunk) {
      held += String(chunk ?? '');
      held = held.replace(/\[\[\s*(phase|hint)\s*:\s*([a-z]+)\s*\]\]/gi, (_, kind, value) => {
        value = value.toLowerCase();
        if (kind.toLowerCase() === 'phase' && PHASES.includes(value)) phase = value;
        if (kind.toLowerCase() === 'hint' && ['nudge', 'narrow', 'explicit'].includes(value)) hints.push(value);
        return '';
      });
      let at = held.indexOf('[');
      while (at !== -1 && !possible(held.slice(at))) at = held.indexOf('[', at + 1);
      const out = at === -1 ? held : held.slice(0, at);
      held = at === -1 ? '' : held.slice(at);
      return out;
    },
    flush() { const out = possible(held) ? '' : held; held = ''; return out; },
    get phase() { return phase; },
    get hints() { return [...hints]; },
  };
}
