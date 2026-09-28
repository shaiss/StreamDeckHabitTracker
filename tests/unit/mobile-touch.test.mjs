// Drift guard for mobile touch reliability on the web surface.
//
// Phone taps were dropping because (a) deck keys had no touch-action and lost
// the press to scroll via pointercancel, (b) shared controls sat under the
// 44px touch floor, and (c) double-tap keys painted no press feedback until
// after DOUBLE_TAP_MS. These asserts keep those fixes from quietly regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

test('virtual deck keys claim the touch gesture', () => {
  const deck = read('public/deck.html');
  assert.match(deck, /\.k\s*\{[^}]*touch-action:\s*none/s,
    '.k must use touch-action:none so a finger wobble cannot become a scroll cancel');
  assert.match(deck, /setPointerCapture/,
    'bindGestures must capture the pointer so pointerup still fires on drift');
  assert.match(deck, /lostpointercapture/,
    'lost capture must clear the active pointer or a key can wedge forever');
  assert.match(deck, /b\.classList\.add\('pressed'\)/,
    'press feedback must paint on pointerdown, not after the double-tap window');
  assert.match(deck, /\.k \.facecss[^\{]*\{[^}]*pointer-events:\s*none/s,
    'face chrome must not be the hit target');
  assert.match(deck, /@media \(max-width:\s*430px\)[^\{]*\{[^}]*--key:\s*54px/s,
    'iPhone-class widths must shrink the 5-key row so it fits without horizontal scroll');
});

test('shared controls meet the 44px touch floor', () => {
  const theme = read('public/theme.css');
  const floor = 'calc(var(--s6) + var(--s3))';
  assert.ok(theme.includes(`min-height: ${floor}`), 'theme.css lost the 44px floor');
  assert.match(theme, /\.btn\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(theme, /\.linklike\s*\{[^}]*min-height:\s*calc\(var\(--s6\) \+ var\(--s3\)\)/s);

  const nav = read('public/nav.js');
  assert.match(nav, /min-width:\s*calc\(var\(--s6\) \+ var\(--s3\)\)/);
  assert.match(nav, /min-height:\s*calc\(var\(--s6\) \+ var\(--s3\)\)/);
  assert.match(nav, /touch-action:\s*manipulation/);

  const habits = read('public/habits.html');
  assert.match(habits, /\.hrow \.del\s*\{[^}]*min-height:\s*calc\(var\(--s6\) \+ var\(--s3\)\)/s);
});
