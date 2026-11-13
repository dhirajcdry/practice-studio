// Broadsheet: a printed newspaper page. Ink on paper with one red; the editor is set on the same sheet.
export default { id: 'broadsheet', name: 'Broadsheet', blurb: 'A printed page. Columns, rules and serif type; no boxes.', layout: 'docked',
  preview: { frame: 'color-mix(in srgb,var(--preview-paper) 90%,var(--preview-ink))', gap: '4px', border: '0 none', shadow: '2px 0 0 -1px var(--preview-ink)',
    bar: 'linear-gradient(var(--preview-ink) 0 33%,transparent 33% 50%,var(--preview-ink) 50% 67%,transparent 67% 83%,var(--preview-ink) 83%)' },
  light: { paper: '#FAF8F2', ink: '#161512', accent: '#C4102A',
    editor: ['#FAF8F2', '#161512', '#F1EEE4', '#6B665B', '#C4102A', '#C4102A', '#4A3F2A', '#1E5236', '#6B4E00', '#C4102A26'] },
  dark: { paper: '#131210', ink: '#EEE9DF', accent: '#FF5F52',
    editor: ['#131210', '#EEE9DF', '#1E1C19', '#A39D90', '#FF5F52', '#FF5F52', '#D8CDB6', '#A8D5B5', '#D9C48A', '#FF5F5233'] } };
