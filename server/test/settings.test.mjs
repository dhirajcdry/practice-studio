import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
async function setup(seed = {}, matches = false, listen = false) {
  const data = new Map([['studio.settings.v1', JSON.stringify(seed)]]);
  const classes = new Set(['theme-obsolete', 'ws-wide']);
  let change;
  const media = { matches };
  if (listen) media.addEventListener = (name, fn) => { assert.equal(name, 'change'); change = fn; };
  globalThis.localStorage = { getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
  globalThis.window = { matchMedia: () => media };
  globalThis.document = {
    documentElement: { style: { setProperty() {} } },
    body: { classList: {
      [Symbol.iterator]: () => classes[Symbol.iterator](),
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
    } },
    addEventListener() {},
  };
  const settings = await import(`../../web/js/settings.js?instance=${++instance}`);
  return { settings, data, classes, changeDark(value) { media.matches = value; change?.({ matches: value }); } };
}

test.afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
});

test('legacy ids migrate to a family and explicit mode', async () => {
  for (const [legacy, theme, mode] of [
    ['phosphor', 'terminal', 'dark'], ['paper', 'studio', 'light'],
    ['slate', 'studio', 'dark'], ['blueprint', 'studio', 'dark'],
  ]) {
    const { settings, classes } = await setup({ theme: legacy });
    assert.equal(settings.getSettings().theme, theme);
    assert.equal(settings.getSettings().mode, mode);
    assert.deepEqual([...classes].filter(c => c.startsWith('theme-')), [`theme-${theme}`]);
    assert.ok(classes.has('ws-wide'));
  }
});

test('valid family ids default to system and unknown ids fall back to Studio', async () => {
  for (const theme of ['editorial', 'ink', 'desk', 'studio', 'terminal', 'unknown']) {
    const { settings } = await setup({ theme }, true);
    assert.equal(settings.getSettings().theme, theme === 'unknown' ? 'studio' : theme);
    assert.equal(settings.getSettings().mode, 'system');
    assert.equal(settings.isDark(), true);
  }
});

test('system appearance follows media changes and notifies only in system mode', async () => {
  const { settings, classes, changeDark } = await setup({}, false, true);
  let notifications = 0;
  const off = settings.onSettingsChange(value => { notifications++; assert.equal(value.dark, settings.isDark()); });
  assert.equal(settings.isDark(), false);
  changeDark(true);
  assert.equal(settings.getSettings().dark, true);
  assert.ok(classes.has('is-dark'));
  assert.equal(notifications, 1);
  settings.setSetting('mode', 'light');
  changeDark(false);
  changeDark(true);
  assert.equal(settings.isDark(), false);
  assert.equal(notifications, 2);
  settings.setSetting('mode', 'system');
  assert.ok(classes.has('is-dark'));
  off();
});

test('toggle pins the opposite effective mode and preserves the family', async () => {
  const { settings } = await setup({ theme: 'desk', mode: 'system' }, true);
  settings.toggleDark();
  assert.equal(settings.getSettings().mode, 'light');
  assert.equal(settings.getSettings().theme, 'desk');
  settings.toggleDark();
  assert.equal(settings.getSettings().mode, 'dark');
  assert.equal(settings.getSettings().theme, 'desk');
});

test('only the known keys are persisted and invalid theme/mode writes are ignored', async () => {
  const { settings, data } = await setup({ theme: 'desk', mode: 'light', lightTheme: 'paper', darkTheme: 'slate', workspace: 'old', workspaceThemes: {} });
  settings.setSetting('codeSize', 16);
  assert.deepEqual(JSON.parse(data.get('studio.settings.v1')), { theme: 'desk', mode: 'light', codeSize: 16, motion: true, typingFx: true, typingSparks: false, celebrations: true, coachPictures: 'auto' });
  settings.setSetting('theme', 'unknown');
  settings.setSetting('mode', 'unknown');
  settings.setSetting('workspace', 'old');
  assert.deepEqual(settings.getSettings(), { theme: 'desk', mode: 'light', codeSize: 16, motion: true, typingFx: true, typingSparks: false, celebrations: true, coachPictures: 'auto', dark: false });
});

test('missing matchMedia is safe', async () => {
  const { settings } = await setup();
  delete globalThis.window.matchMedia;
  settings.apply();
  assert.equal(settings.isDark(), false);
});
