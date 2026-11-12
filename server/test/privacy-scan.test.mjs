import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../../scripts/privacy-scan.mjs';

const lines = (...texts) => texts.map((text, i) => ({ file: 'docs/x.md', line: i + 1, text }));

test('blocks private terms, emails, home paths and tailnet hosts on added lines', () => {
  const found = scan({ lines: lines('Prep for Acme loop', 'mail me@personal.dev', 'see /Users/someone/notes', 'https://box.tail1234ab.ts.net'), files: [] }, ['acme']);
  assert.equal(found.length, 4);
  assert.match(found[0], /private term/);
});

test('allows examples, fixtures paths and explicit privacy-ok lines', () => {
  const ok = lines('https://a:b@writer.example.ts.net', "root = '/Users/x/LeetCodeTutor'", 'Acme is a placeholder privacy-ok', 'noreply@anthropic.com');
  assert.deepEqual(scan({ lines: ok, files: [] }, ['acme']), []);
});

test('blocks personal data files and new images unless allowed', () => {
  const files = ['collection.json', 'data/my-prep.json', 'docs/images/new.png', 'server/test/fixtures/collection.json', 'data/catalog.json'];
  const found = scan({ lines: [], files });
  assert.equal(found.length, 3);
  assert.equal(scan({ lines: [], files: ['docs/images/new.png'] }, [], 'images').length, 0);
  assert.equal(scan({ lines: [], files: ['docs/images/new.png'], existing: true }).length, 0, 'already-tracked images are not re-flagged');
});
