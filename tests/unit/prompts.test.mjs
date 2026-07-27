import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPTS } from '../../lib/coach-shape.js';

// PROMPTS.* are pure (context) -> string. They are the per-flow instructions
// the experiment runner replays byte-identically (issue #11), and they carry
// the flow-specific reply shape the agent's system prompt now also documents
// (lib/agent.js). These tests pin: each prompt names its reply key, instructs
// ONLY-JSON, and embeds the context object.

const baseCtx = {
  human: { name: 'Sam', about: 'night owl', timezone: 'America/New_York' },
  fixedHabits: '🚽 Pee, 🍽 Eat',
  currentAiSlots: 'none',
  trackRecord: { note: 'x' },
  last14Days: { timezone: 'America/New_York', daysOfData: 5, totalTaps: 30, habits: {} }
};

test('suggest prompt wants a slots[] array and embeds context', () => {
  const p = PROMPTS.suggest(baseCtx);
  assert.match(p, /ONLY JSON/i);
  assert.match(p, /"slots"/);
  assert.ok(p.includes(JSON.stringify(baseCtx)), 'context JSON is appended');
});

test('react prompt allows {"change":false} or a slots[] array', () => {
  const p = PROMPTS.react({ ...baseCtx, justTapped: { habit: 'Eat', emoji: '🍽', viaAiSlot: false, localHour: 9 } });
  assert.match(p, /"change":false/);
  assert.match(p, /"slots"/);
  assert.match(p, /ONLY JSON/i);
});

test('morning prompt references the human timezone and wants slots[]', () => {
  const p = PROMPTS.morning(baseCtx);
  assert.match(p, /America\/New_York/);
  assert.match(p, /"slots"/);
  assert.match(p, /ONLY JSON/i);
});

test('nudge prompt allows {"nudge":false} or a nudge:true object', () => {
  const p = PROMPTS.nudge(baseCtx);
  // shape comes from lib/nudge.js NUDGE_PROMPT; pin both branches
  assert.match(p, /"nudge":false/);
  assert.match(p, /"nudge":true/);
});

test('roster prompt wants proposals[] and mentions the pending cap', () => {
  const p = PROMPTS.roster(baseCtx);
  assert.match(p, /"proposals"/);
  assert.match(p, /"kind":"add"/);
  assert.match(p, /ONLY JSON/i);
  assert.ok(p.includes('3'), 'references MAX_PENDING (3)');
});

test('coach-page prompt wants slots[], caps at 12, and stays off the front/fixed keys', () => {
  const p = PROMPTS.coachPage({ ...baseCtx, currentFrontSlots: 'Flow, Bedtime', currentCoachPage: 'none' });
  assert.match(p, /"slots"/);
  assert.match(p, /ONLY JSON/i);
  assert.match(p, /12/, 'states the 12-key cap');
  assert.match(p, /front slots/i);
  assert.match(p, /fixed habit/i);
  assert.ok(p.includes(JSON.stringify({ ...baseCtx, currentFrontSlots: 'Flow, Bedtime', currentCoachPage: 'none' })), 'context JSON is appended');
});
