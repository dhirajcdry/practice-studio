export default { id: 'dock', name: 'Dock', blurb: 'The chrome floats. The title bar is a dock; the work sits on open ground.', layout: 'docked',
  preview: { gap: '4px', radius: '3px', border: '0 none', bar: 'transparent',
    frame: 'linear-gradient(var(--preview-ink),var(--preview-ink)) 50% calc(100% - 2px)/30% 3px no-repeat,var(--preview-paper)' },
  light: { paper: '#F5F5F2', ink: '#17181A', accent: '#F2C200',
    editor: ['#EAEAE6', '#17181A', '#E1E1DC', '#5F6369', '#735600', '#735600', '#1F5FB8', '#2A6B33', '#A83D27', '#F2C20055'] },
  dark: { paper: '#0F1012', ink: '#EEEFF1', accent: '#FFD84A',
    editor: ['#1B1D21', '#EEEFF1', '#23262B', '#8E929A', '#FFD84A', '#FFD84A', '#9CC8FF', '#9BE28F', '#FF9E8A', '#FFD84A33'] } };
