// Guard against production console 404s (#91): every local asset a page
// references must exist under public/, every habit in the seed roster must
// have a committed virtual-deck GIF, and no page may load Vercel Web Analytics
// (the admiral dropped it — /_vercel/insights/* 404s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = join(ROOT, 'public');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const TEXT_EXT = new Set(['.html', '.js', '.css', '.mjs', '.svg']);
const pages = walk(PUBLIC).filter((p) => TEXT_EXT.has(extname(p)));

test('no page requests /_vercel/insights (Web Analytics is disabled)', () => {
  const hits = [];
  for (const p of pages) {
    const src = readFileSync(p, 'utf8');
    if (src.includes('/_vercel/insights')) hits.push(p.slice(PUBLIC.length + 1));
  }
  assert.deepEqual(hits, [], 'pages must not reference /_vercel/insights/*');
});

test('nav.js and deck.html have no analytics inject/track wiring', () => {
  const nav = readFileSync(join(PUBLIC, 'nav.js'), 'utf8');
  const deck = readFileSync(join(PUBLIC, 'deck.html'), 'utf8');
  assert.ok(!nav.includes('script.js'), 'nav.js must not inject insights script');
  assert.ok(!nav.includes('window.va'), 'nav.js must not stub window.va');
  assert.ok(!deck.includes('virtual_deck_tap'), 'deck.html must not fire virtual_deck_tap');
  assert.ok(!deck.includes("window.va("), 'deck.html must not call window.va');
});

test('every seed habit has a committed /icons/animated/<name>.gif', () => {
  const { habits } = JSON.parse(readFileSync(join(ROOT, 'config/habits.json'), 'utf8'));
  const missing = habits
    .map((h) => h.name)
    .filter((name) => !existsSync(join(PUBLIC, 'icons/animated', `${name}.gif`)));
  assert.deepEqual(missing, [], 'missing virtual-deck GIFs for seed habits');
  assert.ok(
    existsSync(join(PUBLIC, 'icons/animated/_dashboard.gif')),
    'Stats key GIF missing'
  );
});

test('static local asset paths referenced by pages exist under public/', () => {
  // Match quoted /… paths to files with common static extensions. Skips
  // /api/* (runtime) and protocol-relative / absolute URLs.
  const re = /['"`](\/(?!\/)[^'"`?#]+\.(?:gif|png|svg|jpg|jpeg|webp|css|js|mjs|ico|woff2?))['"`]/gi;
  const missing = [];
  for (const p of pages) {
    const src = readFileSync(p, 'utf8');
    let m;
    while ((m = re.exec(src))) {
      const rel = m[1];
      if (rel.startsWith('/api/')) continue;
      if (!existsSync(join(PUBLIC, rel.slice(1)))) {
        missing.push(`${p.slice(PUBLIC.length + 1)} → ${rel}`);
      }
    }
  }
  // deck.html builds habit GIF URLs dynamically ('/icons/animated/' + name +
  // '.gif'); the seed-habit test above covers that. Catch any other hardcoded
  // string concatenations that still point at a concrete missing file.
  const deck = readFileSync(join(PUBLIC, 'deck.html'), 'utf8');
  for (const lit of deck.matchAll(/['"`](\/icons\/animated\/[^'"`]+\.gif)['"`]/g)) {
    if (!existsSync(join(PUBLIC, lit[1].slice(1)))) {
      missing.push(`deck.html → ${lit[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'page references missing local assets');
});
