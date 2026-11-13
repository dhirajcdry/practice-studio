// Sheet: a coloured frame carries the navigation; each screen is one rounded sheet inside it.
export default { id: 'sheet', name: 'Sheet', blurb: 'A colour frame carries the navigation; the workspace is one sheet inside it.', layout: 'docked',
  preview: { frame: 'var(--preview-accent)', gap: '1px', radius: '3px', border: '0 none' },
  light: { paper: '#256B57', ink: '#FCFDFB', accent: '#A6F0D2',
    editor: ['#FCFDFB', '#17201D', '#F0F4F1', '#62706B', '#1B7A5B', '#1B7A5B', '#1F5F8F', '#7A4A12', '#8A5A00', '#1B7A5B2E'] },
  dark: { paper: '#1E4A3F', ink: '#E4F2EC', accent: '#6FE0B5',
    editor: ['#101514', '#E7ECE9', '#182120', '#8E9995', '#6FE0B5', '#6FE0B5', '#8CC7F0', '#E7B98A', '#F0C27A', '#6FE0B533'] } };
