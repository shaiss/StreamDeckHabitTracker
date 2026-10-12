import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sanitize } from '../../lib/coach-shape.js';

// tools/screenshots.mjs is a standalone dev tool (README screenshot
// generator): it imports 'playwright-core', which is deliberately NOT a
// project dependency (see docs-links.test.mjs), so it can't be imported here
// — the zero-dependency unit job would fail on the missing module, and
// importing it would also open a real HTTP server and launch a browser as a
// side effect of module load. Instead these tests statically extract the
// script's demo-data literals and validate them against the real,
// already-unit-tested production rules they're supposed to satisfy (the slot
// sanitizer, the real habit roster, the assets it actually serves).

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = readFileSync(join(REPO_ROOT, 'tools', 'screenshots.mjs'), 'utf8');
const HABITS = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'habits.json'), 'utf8')).habits;
const FIXED_NAMES = HABITS.map((h) => h.name);

function extractSlotDefs(src) {
  const re = /\{\s*habit:\s*'([^']*)',\s*emoji:\s*'([^']*)',\s*label:\s*'([^']*)',\s*reason:\s*'([^']*)'/g;
  return [...src.matchAll(re)].map((m) => ({ habit: m[1], emoji: m[2], label: m[3], reason: m[4] }));
}

function extractTapHabitNames(src) {
  const re = /\badd\('([^']+)',\s*'[^']*',/g;
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))];
}

function extractMime(src) {
  const block = src.match(/const MIME = \{([^}]*)\}/);
  assert.ok(block, 'expected a MIME map literal in tools/screenshots.mjs');
  const map = {};
  for (const [, ext, type] of block[1].matchAll(/'(\.[a-z0-9]+)':\s*'([^']+)'/g)) map[ext] = type;
  return map;
}

test('the four demo AI slot keys survive the real sanitizer completely unchanged', () => {
  // If the sanitizer would truncate or drop a demo slot, the screenshot would
  // silently render something different from what the source claims.
  const defs = extractSlotDefs(SRC);
  assert.equal(defs.length, 4, 'expected exactly 4 demo AI slot definitions');

  const out = sanitize(defs, { reserved: FIXED_NAMES.map((n) => n.toLowerCase()) });
  assert.equal(out.length, 4, 'the real sanitizer dropped/deduped a demo slot');
  out.forEach((o, i) => {
    assert.equal(o.habit, defs[i].habit, `slot ${i} habit was mutated by sanitize()`);
    assert.equal(o.emoji, defs[i].emoji, `slot ${i} emoji was truncated by sanitize()`);
    assert.equal(o.label, defs[i].label, `slot ${i} label (>12 chars fails) was truncated by sanitize()`);
    assert.equal(o.reason, defs[i].reason, `slot ${i} reason (>160 chars fails) was truncated by sanitize()`);
  });
});

test('demo AI slot habit names are unique and never collide with a real fixed habit', () => {
  const defs = extractSlotDefs(SRC);
  const lower = defs.map((d) => d.habit.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, 'duplicate demo slot habit names would be silently deduped in production');
  for (const name of lower) {
    assert.ok(!FIXED_NAMES.some((f) => f.toLowerCase() === name), `demo slot "${name}" collides with a real fixed habit`);
  }
});

test('synthetic tap history only references habits that actually exist in config/habits.json', () => {
  const names = extractTapHabitNames(SRC);
  assert.ok(names.length > 0, 'expected to find add(...) calls building demo taps');
  for (const n of names) {
    assert.ok(FIXED_NAMES.includes(n), `demo tap habit "${n}" is not in config/habits.json — would render with a fallback color/face`);
  }
});

test('MIME map declares a content-type for every local asset actually linked from the pages being screenshotted', () => {
  const map = extractMime(SRC);
  const exts = new Set();
  for (const page of ['index.html', 'deck.html', 'mind.html']) {
    const html = readFileSync(join(REPO_ROOT, 'public', page), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const p = m[1];
      if (/^https?:/.test(p)) continue;
      const dot = p.lastIndexOf('.');
      if (dot === -1) continue;
      exts.add(p.slice(dot));
    }
  }
  assert.ok(exts.size > 0, 'expected at least one local asset reference in the screenshotted pages');
  for (const ext of exts) assert.ok(ext in map, `MIME map is missing "${ext}", used by a screenshotted page`);
});

test('MIME map still covers html/css/js/gif/png/svg (regression pin on the literal map)', () => {
  const map = extractMime(SRC);
  assert.deepEqual(map, {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  });
});

test('writes screenshots into docs/screenshots, matching where README embeds them', () => {
  assert.match(SRC, /OUT\s*=\s*join\(REPO,\s*'docs',\s*'screenshots'\)/);
});

test('renders the virtual deck, dashboard, and mind pages — the three pages README links to', () => {
  const shots = [...SRC.matchAll(/shoot\('([^']*)',\s*'([^']*)'/g)].map(([, path, file]) => ({ path, file }));
  assert.deepEqual(shots, [
    { path: '/deck.html', file: 'virtual-deck.png' },
    { path: '/', file: 'dashboard.png' },
    { path: '/mind.html', file: 'coach-mind.png' }
  ]);
});

test('extraction sanity: regressing the demo-slot literal shape would be caught, not silently pass with 0 matches', () => {
  // Negative control: the extractor must not silently succeed on unrelated
  // text — guards against the regex above becoming a no-op after a future
  // refactor of the slots array formatting.
  assert.deepEqual(extractSlotDefs('const x = 1;'), []);
  assert.deepEqual(extractTapHabitNames('const x = 1;'), []);
});