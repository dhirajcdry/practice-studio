// Console: a terminal. Floating gives the gaps between panes; the frames, the titles on
// them and the status line are drawn by web/css/themes/console.css.
export default { id: 'console', name: 'Console', blurb: 'A terminal. Monospace, square frames, inverse-video selection.', layout: 'floating',
  preview: { gap: '3px', border: '1px solid var(--preview-ink)', frame: 'color-mix(in srgb,var(--preview-paper) 90%,var(--preview-ink))' },
  light: { paper: '#F1EFE4', ink: '#141C14', accent: '#9A4705',
    editor: ['#F1EFE4', '#141C14', '#E4E1D3', '#5F6759', '#9A4705', '#9A4705', '#1F6A6A', '#256030', '#7A3E8F', '#9A470533'] },
  dark: { paper: '#0B0E0C', ink: '#D3DCCD', accent: '#FFB454',
    editor: ['#0B0E0C', '#D3DCCD', '#182019', '#7B8A78', '#FFB454', '#FFB454', '#8FD6D0', '#8FD694', '#D6A0E0', '#FFB45440'] } };
