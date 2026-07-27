import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeQuestion, openQuestion, questionDue, pickQuestionSlots, scoreQuestions,
  QUESTION_TTL_MS, QUESTION_GAP_MS, MAX_TEXT, QUESTION_CLAUSE
} from '../../lib/question.js';

const NOW = 1_800_000_000_000;
const RAW = {
  text: 'Did lunch sit well?',
  habit: 'LunchSat',
  yes: { emoji: '👍', label: 'Good' },
  no: { emoji: '👎', label: 'Rough' }
};

// --- shaping ---

test('a question becomes two linked keys that differ only in the answer', () => {
  const q = sanitizeQuestion(RAW, { now: NOW });
  const [yes, no] = q.pair;
  assert.equal(yes.qid, no.qid, 'the shared qid is what makes them a pair');
  assert.equal(yes.habit, no.habit, 'both log the same thing');
  assert.deepEqual([yes.answer, no.answer], ['yes', 'no']);
  assert.deepEqual([yes.label, no.label], ['Good', 'Rough']);
  assert.equal(yes.question, RAW.text, 'the text rides on both keys');
  assert.equal(yes.expiresAt, NOW + QUESTION_TTL_MS);
});

test('👍/👎 are the defaults when the model names no faces', () => {
  const [yes, no] = sanitizeQuestion({ text: 'Tired?', habit: 'Tired' }, { now: NOW }).pair;
  assert.deepEqual([yes.emoji, no.emoji], ['👍', '👎']);
  assert.deepEqual([yes.label, no.label], ['Yes', 'No']);
});

test('unusable questions are dropped, never thrown on', () => {
  for (const bad of [null, undefined, 'nope', {}, { text: 'hi' }, { habit: 'X' }, { text: '  ', habit: 'X' }]) {
    assert.equal(sanitizeQuestion(bad, { now: NOW }), null, JSON.stringify(bad));
  }
});

test('a question may not shadow a fixed habit', () => {
  // Tapping the key logs under `habit`, so a question called "Eat" would turn
  // an answer into a bogus meal entry.
  assert.equal(sanitizeQuestion({ ...RAW, habit: 'Eat' }, { now: NOW, reserved: ['eat'] }), null);
  assert.ok(sanitizeQuestion({ ...RAW, habit: 'Eat' }, { now: NOW, reserved: ['drink'] }));
});

test('hostile field values are clamped, not trusted', () => {
  const q = sanitizeQuestion({
    text: 'x'.repeat(500),
    habit: 'Bad Habit!!<script>',
    yes: { emoji: '👍', label: 'a'.repeat(50) },
    no: { emoji: '👎', label: 'ok' }
  }, { now: NOW });
  assert.equal(q.text.length, MAX_TEXT);
  assert.equal(q.habit, 'BadHabitscript', 'stripped to the safe charset');
  assert.equal(q.pair[0].label.length, 12);
});

test('ttlMinutes is honored inside the same 15..720 window as slots', () => {
  assert.equal(sanitizeQuestion({ ...RAW, ttlMinutes: 60 }, { now: NOW }).expiresAt, NOW + 3600_000);
  assert.equal(sanitizeQuestion({ ...RAW, ttlMinutes: 5 }, { now: NOW }).expiresAt, NOW + QUESTION_TTL_MS);
  assert.equal(sanitizeQuestion({ ...RAW, ttlMinutes: 9999 }, { now: NOW }).expiresAt, NOW + QUESTION_TTL_MS);
});

// --- rate limiting: the coach can ask, so it must be stopped from badgering ---

const rec = (over) => ({ qid: 'q1', text: 't', habit: 'H', askedAt: NOW, expiresAt: NOW + QUESTION_TTL_MS, ...over });

test('only one question may be open at a time', () => {
  assert.equal(questionDue({ now: NOW, records: [] }).due, true);
  assert.equal(questionDue({ now: NOW + 1000, records: [rec()] }).reason, 'a question is already open');
});

test('an answered question still blocks until the gap passes', () => {
  const answered = rec({ answer: 'yes', answeredAt: NOW + 10 });
  assert.equal(questionDue({ now: NOW + QUESTION_GAP_MS - 1000, records: [answered] }).reason, 'asked recently');
  assert.equal(questionDue({ now: NOW + QUESTION_GAP_MS + 1000, records: [answered] }).due, true);
});

test('a lapsed question stops being open', () => {
  const lapsed = rec({ expiresAt: NOW + 1000 });
  assert.equal(openQuestion([lapsed], NOW + 2000), null);
  assert.ok(openQuestion([lapsed], NOW + 500), 'still open before it lapses');
});

test('answered and dismissed questions are no longer open', () => {
  assert.equal(openQuestion([rec({ answer: 'no', answeredAt: NOW })], NOW + 10), null);
  assert.equal(openQuestion([rec({ dismissedAt: NOW })], NOW + 10), null);
});

// --- slot placement ---

test('a pair prefers empty slots', () => {
  assert.deepEqual(pickQuestionSlots([null, { habit: 'A', assignedAt: 9 }, null, null], NOW), [1, 3]);
});

test('a pair takes the stalest assignments when nothing is free', () => {
  const s = (h, at) => ({ habit: h, assignedAt: at });
  assert.deepEqual(pickQuestionSlots([s('A', 50), s('B', 10), s('C', 90), s('D', 30)], NOW), [2, 4]);
});

test('a live nudge is never displaced by a question', () => {
  // Both are the coach interrupting; talking over itself is worse than waiting.
  const nudge = { habit: 'Water', nudge: true, assignedAt: NOW, expiresAt: NOW + 3600_000 };
  assert.deepEqual(pickQuestionSlots([nudge, null, null, { habit: 'A', assignedAt: 5 }], NOW), [2, 3]);
});

test('no room means no question, rather than a half-placed pair', () => {
  const nudge = { habit: 'W', nudge: true, assignedAt: NOW, expiresAt: NOW + 3600_000 };
  assert.equal(pickQuestionSlots([nudge, nudge, nudge, { habit: 'A', assignedAt: 1 }], NOW), null);
});

// --- scoring ---

test('asked splits into answered / dismissed / ignored, and open is excluded', () => {
  const records = [
    rec({ qid: 'a', answer: 'yes', answeredAt: NOW + 1, text: 'A?' }),
    rec({ qid: 'b', dismissedAt: NOW + 1 }),
    rec({ qid: 'c', expiresAt: NOW + 1000 }),
    rec({ qid: 'd', expiresAt: NOW + 9_000_000 })   // still open
  ];
  const r = scoreQuestions(records, NOW + 2000);
  assert.deepEqual(
    [r.asked, r.answered, r.dismissed, r.ignored, r.open],
    [3, 1, 1, 1, 1],
    'the open one counts toward neither side of the ratio'
  );
  assert.equal(r.hitRate, 0.33);
  assert.deepEqual(r.recentAnswers, [{ text: 'A?', answer: 'yes', at: NOW + 1 }]);
});

test('no questions ever scores 0, not NaN', () => {
  const r = scoreQuestions([], NOW);
  assert.deepEqual([r.asked, r.hitRate], [0, 0]);
});

test('recentAnswers keeps only the last handful', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    rec({ qid: 'q' + i, answer: 'yes', answeredAt: NOW + i, text: 'Q' + i }));
  const r = scoreQuestions(many, NOW + 100);
  assert.equal(r.recentAnswers.length, 8);
  assert.equal(r.recentAnswers.at(-1).text, 'Q19', 'the newest survive');
});

// --- wiring guards ---

test('the question clause reaches every pass that may ask', () => {
  assert.match(QUESTION_CLAUSE, /"question"/);
  const shape = readFileSync(new URL('../../lib/coach-shape.js', import.meta.url), 'utf8');
  for (const pass of ['suggest', 'react', 'morning']) {
    const body = shape.split(pass + ': (c) =>')[1]?.split('Context:')[0] || '';
    assert.ok(body.includes('QUESTION_CLAUSE'), `${pass} must offer the question primitive`);
  }
});

test('the virtual deck renders question keys as their own thing', () => {
  const src = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  assert.match(src, /qface/, 'a question face exists');
  assert.match(src, /def\.qid \? '❓/, 'and is chosen by qid, ahead of nudge/suggestion');
});
