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

