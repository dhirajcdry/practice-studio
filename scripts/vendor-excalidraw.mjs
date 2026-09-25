// Put Excalidraw on disk so the whiteboard works with the wifi off.
//
//   node scripts/vendor-excalidraw.mjs
//
// Run this once, and again only to change version. The output is committed. Studio
// itself never bundles anything: `npm start` is still `node server/index.mjs` against a
// package.json with no dependencies, and the browser loads one ESM file from disk.
//
// WHY THERE IS A BUNDLER HERE AT ALL. Monaco ships a browser-ready dist, so vendoring it
// was a copy. Excalidraw does not — its published `dist/prod` leaves React and twenty-odd
// libraries (jotai, radix, pako, perfect-freehand…) as bare imports for a bundler to
// resolve, and React 19 dropped its UMD build. So something has to resolve them once.
// Doing it here, at vendoring time, keeps that cost out of the repo's runtime: esbuild is
// fetched by npx for the duration of this script and is never a dependency of Studio.
// What lands in web/vendor is the same kind of artefact as web/vendor/monaco — someone
// else's bundler output, read straight off disk.
//
// The alternative was an esm.sh-style CDN that rewrites packages on the fly. That puts a
// third party's rewriter in the trust chain of every byte, for a project whose whole
// point is that it runs on a plane. These bytes come from the npm tarballs.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'vendor', 'excalidraw');

const PACKAGES = [
  '@excalidraw/excalidraw@0.18.1',
  'react@19.3.0',
  'react-dom@19.3.0',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err || out}`))));
  });
}

const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-excalidraw-'));
console.log(`  working in ${work}`);

try {
  // 1. The tarballs, from npm, by exact version.
  console.log('  fetching packages…');
  await run('npm', ['pack', ...PACKAGES], { cwd: work });

  // npm installs the peer/transitive tree for us; esbuild then resolves against it.
  // --ignore-scripts because nothing here should be allowed to run install hooks.
  console.log('  installing the dependency tree…');
  await fsp.writeFile(path.join(work, 'package.json'), JSON.stringify({
    name: 'studio-excalidraw-vendor', version: '0.0.0', private: true, type: 'module',
  }, null, 2));
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...PACKAGES], { cwd: work });

  // 2. One entry that names exactly what Studio uses. Anything not reachable from here
  //    is dropped, which is most of what Excalidraw ships.
  const entry = path.join(work, 'entry.mjs');
  await fsp.writeFile(entry, `
export { Excalidraw, exportToSvg, exportToBlob, getSceneVersion, restoreElements } from '@excalidraw/excalidraw';
export { createRoot } from 'react-dom/client';
export { createElement, useCallback, useEffect, useRef, useState } from 'react';
`);

  // 3. Bundle. NODE_ENV=production is what strips React's dev warnings and Excalidraw's
  //    dev-only paths; without it the bundle is roughly twice the size and slower.
  console.log('  bundling (this takes a moment)…');
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });
  await run('npx', [
    '--yes', 'esbuild@0.25.0', entry,
    '--bundle', '--format=esm', '--platform=browser', '--target=es2022',
    '--minify', '--legal-comments=none',
    '--define:process.env.NODE_ENV="production"',
    '--define:process.env.IS_PREACT="false"',
    '--loader:.woff2=file', '--loader:.woff=file', '--loader:.ttf=file',
    '--loader:.png=file', '--loader:.svg=file',
    '--asset-names=assets/[name]-[hash]',
    `--outfile=${path.join(OUT, 'excalidraw.mjs')}`,
  ], { cwd: work });

  // 4. The stylesheet, which is published ready to use.
  const css = path.join(work, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'index.css');
  await fsp.copyFile(css, path.join(OUT, 'excalidraw.css'));

  // 5. Fonts. Excalidraw fetches these at runtime from EXCALIDRAW_ASSET_PATH rather than
  //    importing them, so the bundler never sees them and they have to be copied.
  const fonts = path.join(work, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
  await fsp.cp(fonts, path.join(OUT, 'fonts'), { recursive: true }).catch(() => {
    console.log('  ! no fonts directory — handwriting fonts will fall back');
  });

  await fsp.writeFile(path.join(OUT, 'VENDORED.md'), `# Excalidraw, vendored

Generated by \`node scripts/vendor-excalidraw.mjs\`. Do not edit by hand.

${PACKAGES.map((p) => `- ${p}`).join('\n')}

Bundled with esbuild at vendoring time because Excalidraw publishes bare imports for a
bundler to resolve and React 19 ships no browser build. esbuild is fetched by npx for
that one script and is not a dependency of Studio — \`npm start\` still installs nothing.

Excalidraw loads its fonts at runtime from \`window.EXCALIDRAW_ASSET_PATH\`, which
web/js/design.js points at this directory.
`);

  const sizes = await Promise.all(
    ['excalidraw.mjs', 'excalidraw.css'].map(async (f) => {
      const { size } = await fsp.stat(path.join(OUT, f));
      return `${f} ${(size / 1024 / 1024).toFixed(1)} MB`;
    }),
  );
  console.log(`\nvendored to web/vendor/excalidraw\n  ${sizes.join('\n  ')}`);
} finally {
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
}
