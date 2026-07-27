import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVisibility } from '../../streamdeck-plugin/src/visibility.mjs';

// The derivation is a pure function over the appeared-key set (issue #53) —
// no SDK needed, same shape as scheduler.test.mjs and gestures.test.mjs. It
// is also the enforcement point for #54's navigation guardrail, so the
// "not visible" readings matter as much as the happy path.

test('no appeared keys: profile is not on screen at all', () => {
  assert.deepEqual(deriveVisibility([]), { anyVisible: false, visiblePage: null });
  assert.deepEqual(deriveVisibility(null), { anyVisible: false, visiblePage: null });
});

test('appeared keys sharing one page tag name the visible page', () => {
  const out = deriveVisibility([{ page: 1 }, { page: 1 }, { page: 1 }]);
  assert.deepEqual(out, { anyVisible: true, visiblePage: 1 });
});

test('mid-flip overlap: the majority page wins', () => {
  // Disappear events trail the next page's appears, so both pages briefly
  // coexist in the appeared set. Whoever has more keys on screen wins.
  const out = deriveVisibility([{ page: 0 }, { page: 1 }, { page: 1 }]);
  assert.equal(out.visiblePage, 1);
});

test('a dead heat reads as the LOWER page — "still where you were"', () => {
  assert.equal(deriveVisibility([{ page: 2 }, { page: 0 }]).visiblePage, 0);
  assert.equal(deriveVisibility([{ page: 0 }, { page: 2 }]).visiblePage, 0, 'order must not matter');
});

test('untagged keys count as visible but abstain from the page vote', () => {
  // Hand-placed keys and pre-#53 profiles carry no page tag.
  const out = deriveVisibility([{}, { base: 'x' }, null]);
  assert.deepEqual(out, { anyVisible: true, visiblePage: null });
  // One tagged key among untagged neighbors still names the page.
  assert.equal(deriveVisibility([{}, { page: 1 }]).visiblePage, 1);
});

test('page tags survive string form and reject junk', () => {
  assert.equal(deriveVisibility([{ page: '2' }]).visiblePage, 2, 'settings round-trip as JSON strings');
  assert.equal(deriveVisibility([{ page: 'coach' }]).visiblePage, null);
  assert.equal(deriveVisibility([{ page: -1 }]).visiblePage, null, 'negative pages are junk');
  assert.equal(deriveVisibility([{ page: 1.5 }]).visiblePage, 1, 'parseInt semantics, like every other setting');
});
