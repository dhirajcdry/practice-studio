import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveBoardScene, preserveBeforeBoardWrite, sceneHash } from './board-history.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-board-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const scene = (text, id = 'a') => [{ id, type: 'text', text, version: 1 }];

test('archives first and changed scenes by immutable content hash', async t => {
  const dir = await fixture(t), first = scene('first'), second = scene('second');
  await fs.writeFile(path.join(dir, 'elements.json'), JSON.stringify(first));
  await preserveBeforeBoardWrite(dir, second);
  await fs.writeFile(path.join(dir, 'elements.json'), JSON.stringify(second));
  await archiveBoardScene(dir, second);
  const files = await fs.readdir(path.join(dir, 'board-history'));
  assert.deepEqual(files.sort(), [`${sceneHash(first)}.json`, `${sceneHash(second)}.json`].sort());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'board-history', `${sceneHash(first)}.json`))), first);
});

test('repeated scenes do not create duplicate history files', async t => {
  const dir = await fixture(t), value = scene('same');
  await archiveBoardScene(dir, value); await archiveBoardScene(dir, value);
  assert.deepEqual(await fs.readdir(path.join(dir, 'board-history')), [`${sceneHash(value)}.json`]);
});

test('corrupt current board is rejected before a replacement can overwrite it', async t => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, 'elements.json'), '{broken');
  await assert.rejects(preserveBeforeBoardWrite(dir, scene('new')), /corrupted/);
  assert.equal(await fs.readFile(path.join(dir, 'elements.json'), 'utf8'), '{broken');
});

test('archive failure does not mutate the current board', async t => {
  const dir = await fixture(t), current = scene('current');
  await fs.writeFile(path.join(dir, 'elements.json'), JSON.stringify(current));
  await fs.writeFile(path.join(dir, 'board-history'), 'not a directory');
  await assert.rejects(preserveBeforeBoardWrite(dir, scene('next')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'elements.json'))), current);
});

test('a corrupt existing history snapshot prevents replacement and remains untouched', async t => {
  const dir = await fixture(t), current = scene('current'), next = scene('next');
  await fs.writeFile(path.join(dir, 'elements.json'), JSON.stringify(current));
  await fs.mkdir(path.join(dir, 'board-history'));
  const file = path.join(dir, 'board-history', `${sceneHash(next)}.json`);
  await fs.writeFile(file, '{interrupted');
  await assert.rejects(preserveBeforeBoardWrite(dir, next), /corrupted/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'elements.json'))), current);
  assert.equal(await fs.readFile(file, 'utf8'), '{interrupted');
  assert.ok((await fs.readdir(path.dirname(file))).every(name => !name.endsWith('.tmp')));
});

test('a first scene is archived before there is a current board', async t => {
  const dir = await fixture(t), first = scene('first');
  assert.equal(await preserveBeforeBoardWrite(dir, first), null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'board-history', `${sceneHash(first)}.json`))), first);
  await assert.rejects(fs.access(path.join(dir, 'elements.json')), { code: 'ENOENT' });
});
