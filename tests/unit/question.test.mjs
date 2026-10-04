import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeQuestion, openQuestion, questionDue, pickQuestionSlots, scoreQuestions,
  QUESTION_TTL_MS, QUESTION_GAP_MS, MAX_TEXT, QUESTION_CLAUSE
} from '../../lib/question.js';
import { owedFrame } from '../../streamdeck-plugin/src/faces.mjs';

const NOW = 1_800_000_000_000;
const RAW = {
  text: 'Did lunch sit well?',
  habit: 'LunchSat',
  yes: { emoji: '👍', label: 'Good' },
  no: { emoji: '👎', label: 'Rough' }
};

// --- shaping ---

test('a yes/no question becomes a 3-key Approval Gate in fixed order', () => {
  const q = sanitizeQuestion(RAW, { now: NOW });
  assert.equal(q.pattern, 'gate');
  assert.equal(q.keys.length, 3);
  const [approve, details, deny] = q.keys;
  assert.equal(approve.qid, deny.qid, 'the shared qid is what makes them one question');
  assert.equal(details.qid, approve.qid);
  assert.deepEqual(q.keys.map((k) => k.gateRole), ['approve', 'details', 'deny']);
  assert.deepEqual(q.keys.map((k) => k.label), ['APPROVE', 'DETAILS', 'DENY']);
  assert.deepEqual(q.keys.map((k) => k.emoji), ['✓', '…', '✕']);
  assert.deepEqual(q.keys.map((k) => k.answer), ['yes', 'details', 'no']);
  assert.equal(approve.glyphTint, 'success');
  assert.equal(deny.glyphTint, undefined, 'deny stays neutral');
  assert.equal(approve.question, RAW.text, 'the text rides on every key');
  assert.equal(approve.expiresAt, NOW + QUESTION_TTL_MS);
});

test('model yes/no faces are ignored — the gate labels are the grammar', () => {
  const keys = sanitizeQuestion({ text: 'Tired?', habit: 'Tired' }, { now: NOW }).keys;
  assert.deepEqual(keys.map((k) => k.emoji), ['✓', '…', '✕']);
  assert.deepEqual(keys.map((k) => k.label), ['APPROVE', 'DETAILS', 'DENY']);
});

test('options[] become a Choice Picker with index badges, not numbers in the label', () => {
  const q = sanitizeQuestion({
    text: 'Which sat better?',
    habit: 'MealPick',
    options: [{ label: 'Salad' }, { label: 'option 2 pasta' }, { label: 'Soup' }]
  }, { now: NOW });
  assert.equal(q.pattern, 'picker');
  assert.equal(q.keys.length, 3);
  assert.deepEqual(q.keys.map((k) => k.choiceIndex), [1, 2, 3]);
  assert.deepEqual(q.keys.map((k) => k.badge), ['①', '②', '③']);
  assert.deepEqual(q.keys.map((k) => k.label), ['SALAD', 'OPTION PASTA', 'SOUP']);
  assert.ok(q.keys.every((k) => k.emoji === '▤'));
  assert.ok(q.keys.every((k) => !/\d/.test(k.label)), 'digits live on the badge');
});

test('a one-option list is not a picker — it falls through to the gate', () => {
  const q = sanitizeQuestion({ text: 'Only?', habit: 'Only', options: [{ label: 'Yes' }] }, { now: NOW });
  assert.equal(q.pattern, 'gate');
  assert.equal(q.keys.length, 3);
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
  assert.equal(q.keys[0].label, 'APPROVE', 'gate labels are not taken from hostile yes.label');
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

test('a gate prefers a consecutive empty window, in left-to-right order', () => {
  // [null, A, null, null]: both 3-windows have one busy key; leftmost wins
  // so APPROVE/DETAILS/DENY stay spatially ordered.
  assert.deepEqual(pickQuestionSlots([null, { habit: 'A', assignedAt: 9 }, null, null], NOW, 3), [1, 2, 3]);
});

test('when every window is equally busy, the stalest consecutive run wins', () => {
  const s = (h, at) => ({ habit: h, assignedAt: at });
  // window 1-3 stale=50+10+90=150; window 2-4 stale=10+90+30=130 → pick 2,3,4
  assert.deepEqual(pickQuestionSlots([s('A', 50), s('B', 10), s('C', 90), s('D', 30)], NOW, 3), [2, 3, 4]);
});

test('a live nudge is never displaced by a question', () => {
  // Both are the coach interrupting; talking over itself is worse than waiting.
  const nudge = { habit: 'Water', nudge: true, assignedAt: NOW, expiresAt: NOW + 3600_000 };
  assert.deepEqual(pickQuestionSlots([nudge, null, null, { habit: 'A', assignedAt: 5 }], NOW, 3), [2, 3, 4]);
});

test('no consecutive window means no question, rather than a half-placed gate', () => {
  const nudge = { habit: 'W', nudge: true, assignedAt: NOW, expiresAt: NOW + 3600_000 };
  assert.equal(pickQuestionSlots([nudge, nudge, null, { habit: 'A', assignedAt: 1 }], NOW, 3), null);
});

test('a 2-option picker still wants a consecutive pair', () => {
  assert.deepEqual(pickQuestionSlots([null, { habit: 'A', assignedAt: 9 }, null, null], NOW, 2), [3, 4]);
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

test('owedFrame lights wait only for a live question or nudge', () => {
  assert.equal(owedFrame({ qid: 'q1' }), 'wait');
  assert.equal(owedFrame({ nudge: true }), 'wait');
  assert.equal(owedFrame({ habit: 'Flow', reason: 'deep work' }), null,
    'a violet suggestion owes no press');
  assert.equal(owedFrame({ qid: 'q1', expiresAt: NOW - 1 }, NOW), null,
    'an expired question is not owed');
  assert.equal(owedFrame(null), null);
});

test('the virtual deck renders question keys through the shared grammar', () => {
  const src = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  const plugin = readFileSync(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(src, /qface/, 'a question face exists');
  assert.match(src, /questionPaint\(def\)/, 'and is painted from the shared grammar');
  assert.match(src, /from '\/glyphs\.js'/);
  assert.match(src, /owedFrame\(def\)/, 'pending questions light the wait frame, not a hue swap');
  assert.match(src, /go\('working',\s*280/, 'Ask ack starts on confirming (working)');
  assert.match(src, /go\('success',\s*1600/, 'Ask ack settles on done (success)');
  assert.match(src, /settleQuestionSiblings/, 'picker siblings settle to idle');
  assert.match(src, /isDetailsKey/, 'DETAILS routes to context, not /api/log');
  assert.match(plugin, /ASK_CONFIRMING_MS = 280/, 'plugin Ask ack uses the same confirming beat');
  assert.match(plugin, /setKeyFrame\(k, 'working'\)/);
  assert.match(plugin, /setKeyFrame\(k, 'success'\)/);
  assert.match(plugin, /showQuestionContext/, 'DETAILS opens context rather than committing');
  assert.match(plugin, /settleQuestionSiblings/);
});
