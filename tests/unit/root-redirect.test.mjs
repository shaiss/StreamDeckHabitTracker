// Guard: habitdeck.fyi root must permanently redirect to /deck.html so Vercel
// Web Analytics Visit path stays /deck.html (not a silent rewrite of /).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(
  readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')
);

test('vercel.json permanently redirects exact / to /deck.html', () => {
  assert.ok(Array.isArray(vercel.redirects), 'redirects array missing');
  const rule = vercel.redirects.find((r) => r.source === '/');
  assert.ok(rule, 'exact / redirect missing');
  assert.equal(rule.destination, '/deck.html');
  // 308 (or permanent:true) — not a rewrite — so the browser URL (and
  // pageview path) becomes /deck.html for Growth Visit attribution.
  const permanent =
    rule.statusCode === 308 ||
    rule.statusCode === 301 ||
    rule.permanent === true;
  assert.ok(permanent, 'root redirect must be permanent (308/301)');
  assert.equal(vercel.rewrites, undefined, 'must not rewrite / (keeps URL as /)');
});
