// The one list of theme families. Pure data: the page, the editor, the tests and the
// browser checks all read it. A family is added by one import line here, one @import line
// in web/css/themes.css, and its two files: web/js/themes/<id>.js and web/css/themes/<id>.css.
//
// A row (web/js/themes/<id>.js):
// layout  how panes sit: 'docked' (edge to edge, hairline dividers), 'floating' (rounded
//         panes with gaps on the page), or 'boards' (bordered boards with hard shadows).
// art     true when a painting sits behind the panes; the editor then draws on a clear ground.
// light / dark
//         paper, ink, accent  the swatch in Settings
//         editor              Monaco cannot read CSS variables. In order: ground, text, current
//                             line, dim, accent, keyword, type, string, number, selection.
//         raised              art families only: the solid colour for the editor's own popups.
// Studio's editor themes are written out by hand in python-editor.js, so it has no `editor`.
import studio from './themes/studio.js';
import desk from './themes/desk.js';
import dunes from './themes/dunes.js';
import console_ from './themes/console.js';
import sheet from './themes/sheet.js';
import broadsheet from './themes/broadsheet.js';
import dock from './themes/dock.js';

export const THEMES = [studio, desk, dunes, console_, sheet, broadsheet, dock];

export const themeById = id => THEMES.find(theme => theme.id === id) || THEMES[0];
export const LAYOUTS = ['docked', 'floating', 'boards'];
/** The editor theme names Monaco knows, one per family and appearance. */
export const editorThemeName = (id, dark = false) => `ps-${id}-${dark ? 'dark' : 'light'}`;
export const EDITOR_THEMES = THEMES.flatMap(theme => [editorThemeName(theme.id), editorThemeName(theme.id, true)]);
