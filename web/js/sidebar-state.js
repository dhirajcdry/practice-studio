// View preferences only. Interview evidence and lifecycle stay on the server.
const key = slug => `studio.sidebar.v1:${slug}`;
export function readSidebar(slug) {
  try { return JSON.parse(localStorage.getItem(key(slug))) || {}; } catch { return {}; }
}
export function saveSidebar(slug, change) {
  try { localStorage.setItem(key(slug), JSON.stringify({ ...readSidebar(slug), ...change })); } catch { /* usable without storage */ }
}
