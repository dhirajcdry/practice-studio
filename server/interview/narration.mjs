import { PHASES } from './state.mjs';
// Hold from the FIRST possible opener, including a single '['. Tags are a control
// channel sharing speech; even one leaked prefix is too late to strip on completion.
export function createTagStripper(phases = PHASES) {
  let held = '', phase = null;
  const hints = [];
  let gap = null, curveball = false;
  const possible = tail => {
    const compact = tail.toLowerCase().replace(/\s/g, '');
    return ['[[phase:', '[[hint:', '[[gap:', '[[curveball:'].some(opener => opener.startsWith(compact) || (compact.startsWith(opener) && !compact.includes(']]')));
  };
  return {
    push(chunk) {
      held += String(chunk ?? '');
      held = held.replace(/\[\[\s*(phase|hint|gap|curveball)\s*:\s*([a-z0-9-]+)\s*\]\]/gi, (_, kind, value) => {
        value = value.toLowerCase();
        if (kind.toLowerCase() === 'phase' && phases.includes(value)) phase = value;
        if (kind.toLowerCase() === 'hint' && ['nudge', 'narrow', 'explicit'].includes(value)) hints.push(value);
        if (kind.toLowerCase() === 'gap') gap = value.slice(0, 80);
        if (kind.toLowerCase() === 'curveball' && value === 'delivered') curveball = true;
        return '';
      });
      let at = held.indexOf('[');
      while (at !== -1 && !possible(held.slice(at))) at = held.indexOf('[', at + 1);
      const out = at === -1 ? held : held.slice(0, at);
      held = at === -1 ? '' : held.slice(at);
      return out;
    },
    flush() { const out = possible(held) ? '' : held; held = ''; return out; },
    get gap() { return gap; },
    get curveball() { return curveball; },
    get phase() { return phase; },
    get hints() { return [...hints]; },
  };
}
