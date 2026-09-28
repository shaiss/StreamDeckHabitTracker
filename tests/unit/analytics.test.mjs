// Source-marker guard for Growth (Streak) funnel analytics enablement.
// Static site: no @vercel/analytics package — pageviews via insights script
// injected from nav.js; Tap is a custom event on successful /api/log from
// the virtual deck. Keep this wiring from drifting silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nav = readFileSync(new URL('../../public/nav.js', import.meta.url), 'utf8');
const deck = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');

test('nav.js loads Vercel Web Analytics insights script', () => {
  assert.ok(nav.includes("window.va = window.va || function"), 'va queue stub missing');
  assert.ok(nav.includes('/_vercel/insights/script.js'), 'insights script src missing');
});

test('deck.html fires virtual_deck_tap on successful log', () => {
  assert.ok(deck.includes("window.va('event', { name: 'virtual_deck_tap' })"),
    'virtual_deck_tap custom event missing from tap success path');
});
