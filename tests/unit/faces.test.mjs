import { test } from 'node:test';
import assert from 'node:assert/strict';
import { face, hueFor } from '../../streamdeck-plugin/src/faces.mjs';

const decode = (uri) => {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
};

test('face() returns a well-formed SVG data URI with glyph, label, and badge', () => {
  const svg = decode(face('🌊', 'Flow', 200, 'AI 1'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/);
  assert.ok(svg.includes('🌊'), 'emoji glyph present');
  assert.ok(svg.includes('>Flow<'), 'label present');
  assert.ok(svg.includes('AI 1'), 'badge present');
  assert.ok(svg.includes('linearGradient'), 'night base gradient');
  assert.ok(svg.includes('radialGradient'), 'votive halo');
  assert.ok(!/hsla?\(/.test(svg), 'no hsl()/hsla() — rasterizer compatibility');
});

test('labels are truncated to 12 chars and long labels shrink the font', () => {
  const svg = decode(face('✨', 'Hydration Break Time', 100, ''));
  assert.ok(svg.includes('>Hydration Br<'), 'label truncated at 12');
  assert.ok(svg.includes('font-size="17"'), 'long label uses the 17px size');
  const short = decode(face('✨', 'Eat', 100, ''));
  assert.ok(short.includes('font-size="20"'), 'short label uses the 20px size');
});

test('AI-generated strings are XML-escaped, not injected', () => {
  const svg = decode(face('<script>', 'a&b"c', 10, '<x>'));
  assert.ok(!svg.includes('<script>'), 'raw markup must not survive');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('a&amp;b&quot;c'));
});

test('no badge means no badge element', () => {
  const svg = decode(face('✨', 'Slot 1', 222, ''));
  assert.ok(!svg.includes('text-anchor="end"'), 'badge text is the only end-anchored element');
});

test('hueFor is the shared tools/lib-hue.mjs formula', async () => {
  const lib = await import('../../tools/lib-hue.mjs');
  for (const n of ['Pee', 'Eat', 'Flow', 'Walk']) assert.equal(hueFor(n), lib.hueFor(n));
});

// Living key faces (#32): habit keys carry a 6th `state` argument
// {count, goal, doneToday, streak, ringFill}; slot/nudge keys pass none and
// must render byte-identically to the stateless face.

const state = (over = {}) =>
  ({ count: 0, goal: 1, doneToday: false, streak: 0, ringFill: 0, ...over });

test('living faces: streak ring track always draws, arc sweeps with ringFill', () => {
  const third = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, goal: 3, ringFill: 1 / 3 })));
  assert.ok(third.includes('stroke-dasharray'), 'partial fill draws the arc');
  assert.ok(third.includes('stroke-linecap="round"'), 'arc ends are rounded');
  const empty = decode(face('🚽', 'Pee', 20, '', 72, state()));
  assert.ok(!empty.includes('stroke-dasharray'), 'zero fill draws no arc');
  assert.ok(empty.includes('stroke-opacity="0.18"'), 'the faint track ring still shows');
  const stateless = decode(face('🚽', 'Pee', 20, ''));
  assert.ok(!stateless.includes('stroke-dasharray'), 'no state, no ring arc');
  assert.ok(!stateless.includes('stroke-opacity="0.18"'), 'no state, no ring track');
});

test('living faces: dim-when-done mutes the halo and shows a check', () => {
  const halo = (s) => s.match(/<radialGradient[\s\S]*?<\/radialGradient>/)[0];
  const done = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, doneToday: true, ringFill: 1 })));
  const notYet = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 0 })));
  assert.ok(done.includes('>✓<'), 'done face carries the ✓');
  assert.ok(!notYet.includes('>✓<'), 'undone face has no ✓');
  assert.notEqual(halo(done), halo(notYet), 'done halo is dimmed (lower saturation)');
});

test('living faces: count dots fill with the day tally', () => {
  const svg = decode(face('🍽', 'Eat', 90, '', 72, state({ count: 2, goal: 3, ringFill: 2 / 3 })));
  assert.equal((svg.match(/r="2\.6"/g) || []).length, 3, 'one dot per goal unit');
  assert.equal((svg.match(/fill-opacity="0\.95"/g) || []).length, 2, 'two dots read filled');
  const single = decode(face('🍽', 'Eat', 90, '', 72, state({ count: 1, goal: 1, doneToday: true, ringFill: 1 })));
  assert.ok(!single.includes('r="2.6"'), 'goal of 1 draws no dots');
});

test('living faces: a goal above 8 renders the count as a number, not dots', () => {
  const svg = decode(face('💧', 'Water', 200, '', 72, state({ count: 4, goal: 10, ringFill: 0.4 })));
  assert.ok(!svg.includes('r="2.6"'), 'no dot clutter above 8');
  assert.ok(svg.includes('>4<'), 'the tally shows as a number');
});
