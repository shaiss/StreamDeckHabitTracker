// Issue #114: HabitDeck documents get a CSP and Referrer-Policy: no-referrer.
// The policy is pinned here so a relaxation cannot land without a test edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = join(ROOT, 'public');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

// style-src 'unsafe-inline' is the only relaxation past the #114 starting
// point. Page <style> blocks, runtime style="" (chart geometry, per-habit
// hue, streak ring), nav.js's injected <style>, and the key-language
// specimens all set styles in the document. script-src stays 'self' only —
// that is what keeps a style injection from reading sessionStorage.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// A trailing \b after a quoted "module" never matches: both the quote and
// the following character are non-word. The boundary has to sit on `module`.
const NOT_BLOCKING = /\b(?:defer|async)\b|\btype\s*=\s*["']?module\b/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('vercel.json sets CSP and Referrer-Policy on / and every public html page', () => {
  assert.ok(Array.isArray(vercel.headers), 'headers array missing');
  const routes = new Set(
    walk(PUBLIC)
      .filter((p) => extname(p) === '.html')
      .map((p) => '/' + relative(PUBLIC, p).split(sep).join('/'))
  );
  routes.add('/');
  assert.ok(routes.has('/deck.html') && routes.has('/index.html') && routes.has('/habits.html') && routes.has('/mind.html'));

  const seen = new Map();
  for (const rule of vercel.headers) {
    assert.deepEqual(
      rule.headers.map((h) => h.key).sort(),
      ['Content-Security-Policy', 'Referrer-Policy']
    );
    for (const h of rule.headers) {
      if (h.key === 'Content-Security-Policy') assert.equal(h.value, CSP, rule.source);
      if (h.key === 'Referrer-Policy') assert.equal(h.value, 'no-referrer', rule.source);
    }
    seen.set(rule.source, rule);
  }
  for (const route of routes) {
    assert.ok(seen.has(route), 'no header rule for ' + route);
  }
});

test('each page strips ?key= from a blocking head script before other subresources', () => {
  for (const p of walk(PUBLIC).filter((f) => extname(f) === '.html')) {
    const html = readFileSync(p, 'utf8');
    const rel = relative(PUBLIC, p);
    const tags = [...html.matchAll(/<script\b([^>]*)>/gi)];
    assert.ok(tags.length > 0, rel + ' has no script');
    assert.match(tags[0][1], /src="\/strip-key\.js"/, rel + ' first script must be /strip-key.js');
    assert.doesNotMatch(tags[0][1], NOT_BLOCKING, rel + ' strip script must be blocking');
    const stripAt = html.indexOf('<script src="/strip-key.js">');
    const styleAt = html.indexOf('rel="stylesheet"');
    assert.ok(stripAt !== -1 && styleAt !== -1 && stripAt < styleAt, rel + ' stylesheet precedes the key strip');
    const referrerAt = html.indexOf('name="referrer" content="no-referrer"');
    assert.ok(referrerAt !== -1 && referrerAt < stripAt, rel + ' referrer meta must precede the strip script');
    const inline = tags.filter((m) => !/\bsrc\s*=/.test(m[1]));
    assert.deepEqual(inline.map((m) => m[0]), [], rel + ' still has an inline script');
  }
});

test('strip-script guard rejects a module-typed script, including quoted type=module', () => {
  const samples = [
    ' type="module" src="/strip-key.js"',
    ' src="/strip-key.js" type="module"',
    " type='module' src='/strip-key.js'",
    ' type=module src="/strip-key.js"',
    ' type = "module"',
    ' defer src="/strip-key.js"',
    ' src="/strip-key.js" async',
    ' ASYNC'
  ];
  for (const attrs of samples) assert.match(attrs, NOT_BLOCKING, attrs);
  assert.doesNotMatch(' src="/strip-key.js"', NOT_BLOCKING);
  // The old shape (\b after the closing quote) missed every one of these.
  const old = /\b(?:defer|async|type\s*=\s*"module")\b/;
  assert.doesNotMatch(' type="module" src="/strip-key.js"', old);
  assert.doesNotMatch(' src="/strip-key.js" type="module"', old);
  assert.match(' type="module" src="/strip-key.js"', NOT_BLOCKING);
});
