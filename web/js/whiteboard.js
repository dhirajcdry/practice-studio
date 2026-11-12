import { el } from './dom.js';
const VENDOR = new URL('../vendor/excalidraw/', import.meta.url).href;

let excalidrawPromise = null;

/** Resolves to the Excalidraw namespace, or rejects — callers must handle both. */
export function loadExcalidraw() {
  if (excalidrawPromise) return excalidrawPromise;
  excalidrawPromise = (async () => {
    // Excalidraw fetches its handwriting fonts at runtime rather than importing them,
    // so it has to be told where they are before the component mounts.
    window.EXCALIDRAW_ASSET_PATH = VENDOR;
    if (!document.querySelector('link[data-excalidraw]')) {
      const link = el('link', { rel: 'stylesheet', href: `${VENDOR}excalidraw.css` });
      link.dataset.excalidraw = '1';
      document.head.append(link);
    }
    return import(`${VENDOR}excalidraw.mjs`);
  })().catch((error) => { excalidrawPromise = null; throw error; });
  return excalidrawPromise;
}


/** The vendored API exposes zoom and fit without changing the recorded elements. */
export function boardTools(getApi) {
  const level = el('span', { class: 'dim', text: '100%', 'aria-label': 'Zoom level' });
  const zoom = delta => {
    const api = getApi(); if (!api) return;
    const value = Math.max(.1, Math.min(3, api.getAppState().zoom.value + delta));
    api.updateScene({ appState: { zoom: { value } } });
    level.textContent = `${Math.round(value * 100)}%`;
  };
  const tools = [
    { variant: 'icon', icon: 'minus', ariaLabel: 'Zoom out', onClick: () => zoom(-.1) }, level,
    { variant: 'icon', icon: 'plus', ariaLabel: 'Zoom in', onClick: () => zoom(.1) },
    { variant: 'icon', icon: 'fit', ariaLabel: 'Fit to pane', onClick: () => {
      const api = getApi(); if (!api) return;
      api.scrollToContent(api.getSceneElements(), { fitToContent: true });
      requestAnimationFrame(() => { level.textContent = `${Math.round(api.getAppState().zoom.value * 100)}%`; });
    } },
  ];
  tools.sync = value => { if (Number.isFinite(value)) level.textContent = `${Math.round(value * 100)}%`; };
  return tools;
}
