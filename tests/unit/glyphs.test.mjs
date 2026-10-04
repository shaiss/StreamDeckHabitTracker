import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VERB_GLYPHS, CHOICE_BADGES, GATE_ORDER, GATE_FACE,
  glyphFor, choiceBadge, faceLabel, questionPaint, isDetailsKey, MAX_LABEL_WORDS
} from '../../public/glyphs.js';

test('the shipped verb→glyph map is one glyph per verb', () => {
  assert.deepEqual(VERB_GLYPHS, {
    approve: '✓',
    reject: '✕',
    defer: '→',
    details: '…',
    back: '‹',
    run: '▶',
    stop: '■',
    options: '▤',
    drill: '⊕'
  });
  const glyphs = Object.values(VERB_GLYPHS);
  assert.equal(new Set(glyphs).size, glyphs.length, 'no two verbs share a glyph');
});

test('Approval Gate order is fixed: affirmative, escape, negative', () => {
  assert.deepEqual([...GATE_ORDER], ['approve', 'details', 'deny']);
  assert.equal(GATE_FACE.approve.glyphTint, 'success');
  assert.equal(GATE_FACE.deny.glyphTint, undefined, 'deny is neutral, not danger-red');
  assert.deepEqual(GATE_ORDER.map((r) => GATE_FACE[r].label), ['APPROVE', 'DETAILS', 'DENY']);
  assert.deepEqual(GATE_ORDER.map((r) => glyphFor(GATE_FACE[r].verb)), ['✓', '…', '✕']);
});

test('choice badges are indices, never inline in a label', () => {
  assert.deepEqual([...CHOICE_BADGES], ['①', '②', '③', '④']);
  assert.equal(choiceBadge(1), '①');
  assert.equal(choiceBadge(3), '③');
  assert.equal(faceLabel('Option 2 Salad'), 'OPTION SALAD');
  assert.equal(faceLabel('3 pending meals', 'MEALS'), 'PENDING MEAL');
  assert.ok(!/\d/.test(faceLabel('Pick 12 things')), 'digits never survive into the label');
  assert.equal(MAX_LABEL_WORDS, 2);
  assert.equal(faceLabel('one two three four'), 'ONE TWO');
});

test('questionPaint maps yes/no onto the gate; picker onto index badges', () => {
  const yes = questionPaint({ qid: 'q', pattern: 'gate', gateRole: 'approve' });
  assert.deepEqual([yes.glyph, yes.label, yes.badge, yes.glyphTint], ['✓', 'APPROVE', '', 'success']);
  const details = questionPaint({ qid: 'q', pattern: 'gate', gateRole: 'details' });
  assert.equal(details.glyph, '…');
  assert.ok(isDetailsKey({ gateRole: 'details' }));
  const pick = questionPaint({ qid: 'q', pattern: 'picker', choiceIndex: 2, label: 'Merge' });
  assert.equal(pick.glyph, '▤');
  assert.equal(pick.badge, '②');
  assert.equal(pick.label, 'MERGE');
  assert.ok(!/\d/.test(pick.label));
});

test('legacy 👍/👎 answers still paint as the gate verbs', () => {
  assert.equal(questionPaint({ answer: 'yes' }).glyph, '✓');
  assert.equal(questionPaint({ answer: 'no' }).glyph, '✕');
});

test('both renderers import the same module — they cannot fork the map', () => {
  const faces = readFileSync(new URL('../../streamdeck-plugin/src/faces.mjs', import.meta.url), 'utf8');
  const plugin = readFileSync(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url), 'utf8');
  const deck = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  assert.match(faces, /from '\.\.\/\.\.\/public\/glyphs\.js'/);
  assert.match(plugin, /from '\.\.\/\.\.\/public\/glyphs\.js'/);
  assert.match(deck, /from '\/glyphs\.js'/);
  assert.match(deck, /questionPaint/);
  assert.match(plugin, /questionPaint/);
});
