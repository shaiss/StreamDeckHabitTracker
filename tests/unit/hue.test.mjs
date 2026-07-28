import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hueFor } from '../../tools/lib-hue.mjs';

test('habit hues never land in the reserved violet band', () => {
  for (const n of ['Pee', 'Poop', 'Eat', 'Drink', 'Exercise', 'Cannabis', 'Bedtime', 'Caffeine', 'Mood', 'Stretch']) {
    const h = hueFor(n);
    assert.ok(h < 245 || h >= 285, `${n} landed in the violet band: ${h}`);
  }
});

test('the five fixed habits stay well separated', () => {
  const hues = ['Pee', 'Poop', 'Eat', 'Drink', 'Exercise'].map(hueFor).sort((a, b) => a - b);
  for (let i = 1; i < hues.length; i++) assert.ok(hues[i] - hues[i - 1] >= 10, hues.join(','));
});

test('plugin and virtual deck embed the identical FNV-1a formula (drift guard)', () => {
  // The Node plugin imports the shared module instead of embedding a copy —
  // assert the import so a future rewrite can't silently fork the formula.
  const faces = readFileSync(new URL('../../streamdeck-plugin/src/faces.mjs', import.meta.url), 'utf8');
  assert.ok(faces.includes("from '../../tools/lib-hue.mjs'"), 'faces.mjs must import the shared hue formula');

  // The pages can't import, so they carry a copy. Checking for formula
  // *fragments* is not parity: `hue += 40` -> `hue += 0` keeps every marker and
  // still reintroduces the reserved violet band. So extract each copy, run it,
  // and compare its OUTPUT against the canonical implementation.
  // mind.html joined the list when its memory orbs stopped using a rotating
  // palette and started deriving hue from the memory's own text (#65).
  const NAMES = ['Pee', 'Poop', 'Eat', 'Drink', 'Exercise', 'Cannabis', 'Bedtime',
    'Caffeine', 'Mood', 'Stretch', 'Water', 'Sunlight', '', 'a', 'ünïcøde ✨',
    'a night owl who logs most habits after 9pm'];

  for (const f of ['public/deck.html', 'public/mind.html']) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    const fn = src.match(/function hueFor\s*\([\s\S]*?\n {4}}/);
    assert.ok(fn, `${f} must define hueFor()`);
    // eslint-disable-next-line no-new-func -- evaluating the page's own copy is the point
    const embedded = new Function(`${fn[0]}; return hueFor;`)();
    for (const n of NAMES) {
      assert.equal(embedded(n), hueFor(n), `${f} hueFor(${JSON.stringify(n)}) forked from lib-hue.mjs`);
    }
    // and the band it exists to protect still holds for the embedded copy
    for (const n of NAMES) {
      const h = embedded(n);
      assert.ok(h < 245 || h >= 285, `${f}: ${n} landed in the reserved violet band (${h})`);
    }
  }
});
