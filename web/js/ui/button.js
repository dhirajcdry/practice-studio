import { el } from '../dom.js';
import { icon as drawIcon } from './icon.js';

export function button({ label, icon, kbd, variant = 'quiet', size = 'md', pressed, disabled, danger, ariaLabel, title, onClick, className = '' } = {}) {
  if (!['primary', 'secondary', 'quiet', 'icon'].includes(variant)) throw new Error('Unknown button variant');
  if (variant === 'icon' && !ariaLabel) throw new Error('Icon buttons need an ariaLabel');
  return el('button', {
    type: 'button', class: `btn btn--${variant}${size === 'lg' ? ' btn--lg' : ''} ${className}`.trim(),
    'aria-label': ariaLabel, 'aria-pressed': pressed === undefined ? undefined : String(pressed),
    'data-danger': danger ? 'true' : undefined, disabled, title, onclick: onClick,
  }, [typeof icon === 'string' ? drawIcon(icon, 15) : icon,
    label ? el('span', { text: label }) : null, kbd ? el('kbd', { text: kbd }) : null]);
}

export const practiseFromMock = options => button({ ...options, label: 'Practise from this mock', variant: options?.variant || 'secondary' });
