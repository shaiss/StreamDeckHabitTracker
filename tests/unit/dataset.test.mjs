import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatasetItem, DATASET_CAP } from '../../lib/dataset.js';

// Pins the Redis corpus shape that /api/experiment replays (issue #11 / #99).
// Pure — no Redis, no AI SDK, no framework scorer packages.

test('buildDatasetItem uses {input, output, metadata} with live quality score', () => {
  const rawSlots = [
    { habit: 'Mood', emoji: '🙂', label: 'Mood', reason: 'You tapped Eat at 1am — mood connects late nights.' }
  ];
  const item = buildDatasetItem({
    kind: 'suggest',
    context: { fixedHabits: 'Eat' },
    rawSlots,
    engine: 'ai-sdk',
    model: 'glm-5.2',
    fixedNames: ['Eat', 'Drink'],
    at: 1_700_000_000_000
  });
  assert.equal(item.at, 1_700_000_000_000);
  assert.deepEqual(item.input, { kind: 'suggest', context: { fixedHabits: 'Eat' } });
  assert.deepEqual(item.output, { rawSlots });
  assert.equal(item.metadata.engine, 'ai-sdk');
  assert.equal(item.metadata.model, 'glm-5.2');
  assert.ok(item.metadata.quality && typeof item.metadata.quality.composite === 'number');
  assert.ok(item.metadata.quality.composite > 0.5, JSON.stringify(item.metadata.quality));
});

test('dataset Redis list cap stays at 300 for experiment replay', () => {
  assert.equal(DATASET_CAP, 300);
});
