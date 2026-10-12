import test from 'node:test';
import assert from 'node:assert/strict';

test('theme stays global across views, dark-mode toggles, and reloads', async () => {
  // Import the browser settings module with only its storage and DOM boundary stubbed.
  const data = new Map([['studio.settings.v1', JSON.stringify({
    theme: 'editorial', workspace: 'focus',
    workspaceThemes: { workbench: 'slate', focus: 'paper', review: 'blueprint' },
  })]]);
  const classes = new Set();
  globalThis.localStorage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = {
    addEventListener() {}, documentElement: { style: { setProperty() {} } },
    body: { classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } } },
  };
  try {
    const settings = await import('../../web/js/settings.js?global-theme');
    for (const view of ['workbench', 'review', 'focus']) {
      settings.setSetting('workspace', view);
      assert.equal(settings.getSettings().theme, 'editorial', 'legacy per-view preferences must not override the active theme');
      assert.ok(classes.has('theme-editorial'));
    }
    settings.setSetting('theme', 'phosphor');
    settings.setSetting('workspace', 'review');
    settings.toggleDark(false);
    assert.equal(settings.getSettings().theme, 'editorial');
    settings.setSetting('workspace', 'workbench');
    settings.toggleDark(true);
    assert.equal(settings.getSettings().theme, 'phosphor');
    const reload = await import('../../web/js/settings.js?global-theme-reload');
    assert.equal(reload.getSettings().theme, 'phosphor');
    reload.setSetting('workspace', 'focus');
    assert.equal(reload.getSettings().theme, 'phosphor');
    assert.equal(JSON.parse(data.get('studio.settings.v1')).workspaceThemes, undefined);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});
