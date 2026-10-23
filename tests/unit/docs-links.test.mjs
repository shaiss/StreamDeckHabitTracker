import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This PR adds LICENSE and docs/MASTRA.md, and rewrites README.md to link to
// both (plus the new docs/screenshots/*.png images). Markdown links/images
// rot silently — nothing fails a build when one points at a moved or
// misspelled path. These tests parse the actual changed docs and assert every
// repo-relative link/image they contain resolves to a real file, so a future
// rename is caught here instead of by a reader clicking a dead link.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function extractRelativeLinks(markdown) {
  const links = new Set();
  for (const m of markdown.matchAll(/\]\(([^)]+)\)/g)) links.add(m[1]);
  for (const m of markdown.matchAll(/<img[^>]+src="([^"]+)"/g)) links.add(m[1]);
  return [...links].filter((l) => !/^https?:\/\//.test(l) && !l.startsWith('#') && !l.startsWith('mailto:'));
}

function assertLinksResolve(mdRelPath) {
  const abs = join(REPO_ROOT, mdRelPath);
  const md = readFileSync(abs, 'utf8');
  const baseDir = dirname(abs);
  const links = extractRelativeLinks(md);
  assert.ok(links.length > 0, `expected to find relative links in ${mdRelPath}`);
  for (const link of links) {
    const target = join(baseDir, link.split('#')[0]);
    assert.ok(existsSync(target), `${mdRelPath} links to a path that does not exist: "${link}" (resolved ${target})`);
  }
}

test('README.md: every repo-relative link and <img> resolves to a real file', () => {
  assertLinksResolve('README.md');
});

test('docs/MASTRA.md: every repo-relative link resolves to a real file', () => {
  assertLinksResolve('docs/MASTRA.md');
});

test('README.md embeds exactly the three new screenshots plus the design specimen', () => {
  const md = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const imgs = [...md.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imgs, [
    'design/specimen.png',
    'docs/screenshots/coach-mind.png',
    'docs/screenshots/dashboard.png',
    'docs/screenshots/virtual-deck.png'
  ]);
});

test('README.md screenshot references match exactly what tools/screenshots.mjs writes to disk', () => {
  const md = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const referenced = [...md.matchAll(/docs\/screenshots\/([\w-]+\.png)/g)].map((m) => m[1]).sort();

  const script = readFileSync(join(REPO_ROOT, 'tools/screenshots.mjs'), 'utf8');
  const written = [...script.matchAll(/shoot\('[^']*',\s*'([\w-]+\.png)'/g)].map((m) => m[1]).sort();

  assert.ok(written.length > 0, 'expected to find shoot(...) calls in tools/screenshots.mjs');
  assert.deepEqual(written, referenced, 'the generator must produce exactly the screenshots the README embeds — nothing extra, nothing missing');
});

test('docs/MASTRA.md is linked from README.md', () => {
  const md = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(md, /\(docs\/MASTRA\.md\)/);
});

test('LICENSE is a well-formed MIT license for this repo', () => {
  const license = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 shaiss/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  // sanity bounds: not empty, not absurdly large, no leftover template placeholders
  assert.ok(license.length > 500 && license.length < 5000);
  assert.doesNotMatch(license, /\[.*\]/, 'no unfilled [placeholder] tokens should remain');
});

test('package.json declares the MIT license, matching the newly-added LICENSE file', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
});

test('package.json description reflects the cloud + AI-coach product, not the old Google Sheet description', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.description, /logged in the cloud/i);
  assert.match(pkg.description, /AI coach/i);
  assert.doesNotMatch(pkg.description, /Google Sheet/i);
});

test('tools/screenshots.mjs is documented as an opt-in dependency, not a baked-in devDependency', () => {
  const script = readFileSync(join(REPO_ROOT, 'tools/screenshots.mjs'), 'utf8');
  assert.match(script, /npm i playwright-core --no-save/);

  const pkg = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /"playwright-core"/, 'playwright-core must stay out of package.json so the unit job needs no install');
});