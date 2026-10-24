// Guard: plugin rebuild pins stay exact so `npm ci` + `npm run build:plugin`
// reproduces bin/plugin.js byte-for-byte on the current tree (#108). Floating
// ranges here would let lockfile drift change the vendored ws / SDK / esbuild
// inside the bundle. (Historical #95 / 7911a44 sha256 differs only by esbuild
// chunk order — see tools/build-plugin.mjs.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Exact versions required for a reproducible plugin.js rebuild. */
const PINS = {
  '@elgato/streamdeck': '3.0.2',
  esbuild: '0.28.2',
  gifenc: '1.0.3',
  'playwright-core': '1.64.1',
  pngjs: '7.0.0',
  ws: '8.22.0'
};

test('package.json pins plugin build deps to exact versions', () => {
  for (const [name, ver] of Object.entries(PINS)) {
    assert.equal(
      pkg.devDependencies?.[name],
      ver,
      `${name} must be exact ${ver} in devDependencies (got ${pkg.devDependencies?.[name]})`
    );
    assert.ok(
      !String(pkg.devDependencies[name]).startsWith('^') &&
        !String(pkg.devDependencies[name]).startsWith('~'),
      `${name} must not use a floating range`
    );
  }
});

test('package.json overrides force ws@8.22.0 for transitive deps', () => {
  // Transitive deps can float ws (historically @mastra/core → 8.21.1); the
  // plugin bundle vendors whatever is hoisted, so the override is
  // load-bearing (#108 / #95 F2).
  assert.equal(pkg.overrides?.ws, '8.22.0');
});

test('npm run build:plugin is documented', () => {
  assert.equal(pkg.scripts?.['build:plugin'], 'node tools/build-plugin.mjs --no-images');
});
