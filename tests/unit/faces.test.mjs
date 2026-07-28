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

// #64: the progress indicator is the key's OWN rounded-rect border filling,
// not a separate circle floating over the square.
test('living faces: the key border fills — a rounded-rect frame, not a floating circle', () => {
  const third = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, goal: 3, ringFill: 1 / 3 })));
  assert.ok(!third.includes('rotate(-90'), 'the old rotated progress circle is gone');
  assert.ok(!/r="65"/.test(third), 'no inset progress-circle radius survives');
  assert.ok(third.includes('stroke-dasharray'), 'partial fill draws a lit segment');
  assert.ok(third.includes('stroke-linecap="round"'), 'the lit segment ends are rounded');
  // The fill is a <path> tracing the rounded-rect (A17 17 corners), not a circle.
  assert.match(third, /<path d="M[^"]*A17 17[^"]*"[^>]*stroke-dasharray/,
    'the fill traces the rounded-rect frame');

  const empty = decode(face('🚽', 'Pee', 20, '', 72, state()));
  assert.ok(!empty.includes('stroke-dasharray'), 'zero fill draws no lit segment');
  assert.ok(empty.includes('stroke-opacity="0.18"'), 'the faint frame track still shows');
  assert.ok(empty.includes('<path d="M'), 'the track is drawn as the frame path');

  const stateless = decode(face('🚽', 'Pee', 20, ''));
  assert.ok(!stateless.includes('stroke-dasharray'), 'no state, no fill');
  assert.ok(!stateless.includes('<path d="M'), 'no state, no frame');
});

test('living faces: the lit border length grows with ringFill, up to the perimeter', () => {
  const lit = (f) => {
    const m = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, goal: 4, ringFill: f })))
      .match(/stroke-dasharray="([\d.]+) /);
    return m ? +m[1] : 0;
  };
  const [a, b, c] = [0.25, 0.5, 1].map(lit);
  assert.ok(a < b && b < c, `lit length rises monotonically: ${a},${b},${c}`);
  // Overshoot (repeatable habits can exceed their goal) clamps to the full
  // perimeter via Math.min(1, ringFill) — never a longer-than-the-frame dash.
  assert.equal(lit(1.5), c, 'ringFill past the goal is clamped to the full perimeter');
  // Full fill ≈ the exact rounded-rect perimeter 2(w+h) − 8r + 2πr, w=h=132, r=17.
  const P = 2 * (132 + 132) - 8 * 17 + 2 * Math.PI * 17;
  assert.ok(Math.abs(c - P) < 0.5, `full fill ≈ perimeter ${P.toFixed(2)}, got ${c}`);
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

// --- nudge escalation (#35) ---

const svgOf = (uri) => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
const haloOpacity = (svg) => +svg.match(/id="h"[\s\S]*?stop-opacity="([\d.]+)"/)[1];
const borderWidth = (svg) => +svg.match(/rx="17"[^>]*stroke-width="([\d.]+)"/)[1];

test('a face with no urgency is byte-identical to before escalation existed', () => {
  const plain = svgOf(face('💧', 'Water', 38, 'AI 1', 90));
  assert.match(plain, /stop-opacity="0.62"/, 'the original halo opacity');
  assert.match(plain, /stroke-opacity="0.30" stroke-width="1.5"/, 'the original hairline ring');
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, null)), plain, 'null state changes nothing');
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { doneToday: false })), plain,
    'a state object without urgency changes nothing');
});

test('urgency brightens the halo and firms the border, monotonically', () => {
  const at = (u) => svgOf(face('💧', 'Water?', 38, '❗ 1', 90, { urgency: u }));
  const halos = [0, 0.5, 1].map((u) => haloOpacity(at(u)));
  const borders = [0, 0.5, 1].map((u) => borderWidth(at(u)));
  assert.ok(halos[0] < halos[1] && halos[1] < halos[2], 'halo opacity rises: ' + halos.join(','));
  assert.ok(borders[0] < borders[1] && borders[1] < borders[2], 'border thickens: ' + borders.join(','));
  assert.ok(halos[2] <= 1, 'and never becomes an invalid opacity');
});

test('urgency is clamped, so bad input cannot emit invalid SVG', () => {
  for (const u of [-5, 5, 1.0001]) {
    const svg = svgOf(face('💧', 'Water?', 38, '❗ 1', 90, { urgency: u }));
    const o = haloOpacity(svg);
    assert.ok(o >= 0 && o <= 1, `opacity ${o} out of range for urgency ${u}`);
  }
});
