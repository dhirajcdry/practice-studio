const themes = [
  ['paper', 'Paper', '#f7f7f7', 'a quiet desk, warm paper, understated detail'],
  ['editorial', 'Editorial', '#f4efe6', 'journal typography, double rules, oxblood accents'],
  ['ink', 'Ink', '#1b49f5', 'electric blue, bold contrast, hard edges'],
  ['slate', 'Slate', '#353b44', 'graphite surfaces, warm orange details'],
  ['blueprint', 'Blueprint', '#17395a', 'a midnight drafting table with cyan instrument marks'],
  ['phosphor', 'Phosphor', '#7effa8', 'terminal green, amber signals, crisp outlines'],
];
const controls = document.querySelector('.theme-controls');
for (const [id, name, color, description] of themes) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(id === 'slate'));
  button.setAttribute('aria-controls', 'theme-image');
  const swatch = document.createElement('i');
  swatch.style.setProperty('--swatch', color);
  swatch.setAttribute('aria-hidden', 'true');
  button.append(swatch, name);
  button.addEventListener('click', () => {
    for (const peer of controls.children) peer.setAttribute('aria-pressed', String(peer === button));
    const image = document.getElementById('theme-image');
    image.src = `images/theme-${id}.png`;
    image.alt = `${name} theme: ${description}`;
    document.getElementById('theme-caption').textContent = `${name} — ${description}.`;
  });
  controls.append(button);
}
// A static illustration, not a microphone meter or a claim of live recording.
for (let n = 0; n < 48; n++) {
  const bar = document.createElement('i');
  bar.style.height = `${8 + Math.abs(Math.sin(n * 1.7) * Math.sin(n * .24)) * 52}px`;
  document.querySelector('.wave').append(bar);
}

// Playback follows the actual recognizer's word timestamps. No mic permission,
// network speech service, fabricated recognition, or automatic playback.
const audio = document.getElementById('voice-sample');
fetch('media/reasoning.json').then(response => {
  if (!response.ok) throw new Error('Sample unavailable');
  return response.json();
}).then(sample => {
  const transcript = document.getElementById('voice-transcript');
  const words = sample.words.map(word => {
    const span = document.createElement('span');
    span.textContent = word.word + ' ';
    return span;
  });
  transcript.replaceChildren(...words);
  audio.addEventListener('timeupdate', () => {
    words.forEach((span, index) => span.classList.toggle('is-current',
      audio.currentTime >= sample.words[index].start && audio.currentTime < sample.words[index].end));
  });
}).catch(() => {
  // The recognized text remains readable when viewing the HTML directly from disk.
});
