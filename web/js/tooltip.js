// A body-level tooltip escapes scrolling panels. One shared node avoids orphaned tips.
let tip;
let timer;
let owner;
let listening = false;
function hide() {
  clearTimeout(timer);
  tip?.remove();
  tip = null;
  owner = null;
}
export function tooltip(button, label) {
  if (!listening) {
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    listening = true;
  }
  function show() {
    hide();
    owner = button;
    timer = setTimeout(() => {
      if (!button.isConnected || owner !== button) return;
      tip = document.createElement('div');
      tip.className = 'control-tooltip';
      tip.textContent = typeof label === 'function' ? label() : label;
      tip.setAttribute('role', 'tooltip');
      document.body.append(tip);
      const box = button.getBoundingClientRect();
      const width = tip.getBoundingClientRect().width;
      tip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.left + (box.width - width) / 2))}px`;
      tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 8, box.bottom + 6)}px`;
    }, 400);
  }
  button.addEventListener('pointerenter', show);
  button.addEventListener('focus', show);
  for (const event of ['pointerleave', 'blur', 'click']) button.addEventListener(event, hide);
}
