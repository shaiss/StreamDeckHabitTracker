// Guard: habitdeck.fyi (and the project domain) must permanently land `/`
// on `/deck.html` so the deck is the product home, not a silent rewrite of `/`.
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
  // Exact 308 (method-preserving permanent). Do not accept 301 or
  // `permanent: true` — those would still pass a looser "is permanent" check.
  assert.equal(rule.statusCode, 308, 'root redirect must be statusCode 308');
  assert.equal(vercel.rewrites, undefined, 'must not rewrite / (keeps URL as /)');
});
