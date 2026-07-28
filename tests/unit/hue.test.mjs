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
  // mind.html joined the list when its memory orbs stopped using a rotating
  // palette and started deriving hue from the memory's own text (#65).
  for (const f of ['public/deck.html', 'public/mind.html', 'tools/lib-hue.mjs']) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    for (const marker of ['2166136261', '16777619', '% 320', '245']) {
      assert.ok(src.includes(marker), `${f} missing hue-formula marker ${marker}`);
    }
  }
});
