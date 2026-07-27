#!/usr/bin/env node
// Bundles streamdeck-plugin/src/ into the .sdPlugin's bin/plugin.js.
// The output is a COMMITTED artifact (like public/downloads/): the packaged
// zip and any local install run it directly, so rebuild + re-commit after any
// src/ change. Requires: npm i esbuild @elgato/streamdeck --no-save
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function bundlePlugin() {
  const outfile = join(ROOT, 'streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js');
  await build({
    entryPoints: [join(ROOT, 'streamdeck-plugin/src/plugin.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile,
    // ws's optional native accelerators — not installed, must stay external.
    external: ['bufferutil', 'utf-8-validate'],
    // ws uses require() internally; give the ESM bundle a require shim.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: 'error'
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('bundled -> ' + (await bundlePlugin()));
}
