// Coach questions as a first-class primitive (issue #34, generalized by #77).
//
// A question used to be a bespoke 👍/👎 pair. It is now one of two workhorse
// patterns from the study: a yes/no becomes a 3-key Approval Gate (✓ APPROVE /
// … DETAILS / ✕ DENY, always that order), and a one-of-N becomes a Choice
// Picker (index badges ①②③). Tapping an answer key records the verdict and
// retires EVERY key that shares the qid; DETAILS routes to context and does
// not commit. A question is spent once it has been answered.
//
// It is the only way the coach can ever ask its human anything, which is
// exactly why it is rate-limited: one open question at a time, with a gap
// between them. A coach that can ask is a coach that can badger.
//
// Dependency-free aside from the shared glyph grammar (public/glyphs.js) and
// pure, like nudge.js and roster.js, so the zero-dep unit suite can pin the
// rules without Redis.

import {
  glyphFor, GATE_ORDER, GATE_FACE, faceLabel, choiceBadge
} from '../public/glyphs.js';

export const QUESTION_TTL_MS = 3 * 3600_000;    // time to answer before it lapses
export const QUESTION_GAP_MS = 6 * 3600_000;    // between one question and the next
export const MAX_TEXT = 120;
export const MAX_PICKER_OPTIONS = 4;

function commonFields(habit, text, qid, now, expiresAt) {
  return {
    habit,
    reason: text,
    question: text,
    qid,
    assignedAt: now,
    expiresAt
  };
}

function gateKey(common, role) {
  const spec = GATE_FACE[role];
  const def = {
    ...common,
    emoji: glyphFor(spec.verb),
    label: spec.label,
    answer: spec.answer,
    verb: spec.verb,
    pattern: 'gate',
    gateRole: role
  };
  if (spec.glyphTint) def.glyphTint = spec.glyphTint;
  return def;
}

function pickerKey(common, opt, index) {
  return {
    ...common,
    emoji: glyphFor('options'),
    label: faceLabel(opt.label, 'OPT'),
    answer: String(index),
    verb: 'options',
    pattern: 'picker',
    choiceIndex: index,
    badge: choiceBadge(index)
  };
}

function sanitizeOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const it of raw) {
    if (out.length >= MAX_PICKER_OPTIONS) break;
    if (it == null) continue;
    const src = typeof it === 'object' ? (it.label || it.habit || it.name || '') : it;
    const label = faceLabel(src);
    if (!label) continue;
    out.push({ label });
  }
  return out.length >= 2 ? out : null;
}

// Coerce a model-proposed question into safe slot defs, or null when it is
// unusable. Mirrors sanitize() in coach-shape.js: never throws, drops
// anything malformed, and callers treat null as "no question this pass".
export function sanitizeQuestion(raw, { now = Date.now(), reserved = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim().slice(0, MAX_TEXT);
  const habit = String(raw.habit || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (!text || !habit) return null;
  // A question must not shadow a fixed habit: tapping it logs under `habit`,
  // and answering "did lunch sit well?" must not masquerade as logging Eat.
  if (reserved.includes(habit.toLowerCase())) return null;

  const ttlMin = Number(raw.ttlMinutes);
  const expiresAt = now + (ttlMin >= 15 && ttlMin <= 720 ? ttlMin * 60_000 : QUESTION_TTL_MS);
  const qid = 'q' + now.toString(36);
  const common = commonFields(habit, text, qid, now, expiresAt);

  const options = sanitizeOptions(raw.options);
  const keys = options
    ? options.map((opt, i) => pickerKey(common, opt, i + 1))
    : GATE_ORDER.map((role) => gateKey(common, role));

  return {
    qid,
    text,
    habit,
    askedAt: now,
    expiresAt,
    pattern: options ? 'picker' : 'gate',
    keys,
    // Alias kept so older call sites that said "pair" still walk the keys.
    pair: keys
  };
}

// The open question, if any: the newest record that has neither been answered
// nor dismissed and has not lapsed. Deriving it from history rather than
// storing it separately means the two can never disagree.
export function openQuestion(records, now = Date.now()) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || r.answer || r.dismissedAt) continue;
    if (r.expiresAt && r.expiresAt <= now) continue;
    return r;
  }
  return null;
}

// May the coach ask right now? Biased toward silence, like the nudge gate.
export function questionDue({ now = Date.now(), records = [] } = {}) {
  if (openQuestion(records, now)) return { due: false, reason: 'a question is already open' };
  const last = records.length ? records[records.length - 1] : null;
  if (last && now - (last.askedAt || 0) < QUESTION_GAP_MS) {
    return { due: false, reason: 'asked recently' };
  }
  return { due: true, reason: 'ok' };
}

// Consecutive front-page slots for a question pattern. Prefer empty ones, then
// the window whose busy keys are stalest, and never steal a live nudge — a
// nudge is already the coach interrupting, and talking over itself is worse
// than waiting. Front-page only, like nudges (#52): a question the human
// can't see is a question that scores "ignored".
//
// Consecutive is load-bearing for the Approval Gate: affirmative-left /
// escape-center / negative-right is a spatial grammar, not a shuffle of
// whichever two holes were free.
export function pickQuestionSlots(slots, now = Date.now(), need = 3) {
  const n = Math.max(1, Math.min(4, need | 0));
  const stealable = (s) => !(s && s.nudge && (!s.expiresAt || s.expiresAt > now));
  const windows = [];
  for (let start = 0; start <= 4 - n; start++) {
    let ok = true, free = 0, stale = 0;
    const idxs = [];
    for (let j = 0; j < n; j++) {
      const s = slots[start + j];
      if (!stealable(s)) { ok = false; break; }
      idxs.push(start + j + 1);
      if (!s || (s.expiresAt && s.expiresAt < now)) free++;
      else stale += s.assignedAt || 0;
    }
    if (ok) windows.push({ idxs, free, stale });
  }
  if (!windows.length) return null;
  windows.sort((a, b) => b.free - a.free || a.stale - b.stale || a.idxs[0] - b.idxs[0]);
  return windows[0].idxs;
}

// asked / answered / dismissed / ignored — the question analogue of the nudge
// scorer. An open question has no verdict yet and is excluded from both sides
// of the ratio, so a fresh ask never reads as a failure.
export function scoreQuestions(records, now = Date.now()) {
  let answered = 0, dismissed = 0, ignored = 0, open = 0;
  const recent = [];
  for (const r of records || []) {
    if (!r) continue;
    if (r.answer) {
      answered++;
      recent.push({ text: r.text, answer: r.answer, at: r.answeredAt || r.askedAt });
    } else if (r.dismissedAt) dismissed++;
    else if (r.expiresAt && r.expiresAt <= now) ignored++;
    else open++;
  }
  const asked = answered + dismissed + ignored;
  return {
    asked,
    answered,
    dismissed,
    ignored,
    open,
    hitRate: asked ? +(answered / asked).toFixed(2) : 0,
    // The last handful of actual answers — the part with real information in
    // it, and what the coach folds into its hypotheses.
    recentAnswers: recent.slice(-8)
  };
}

// Pure (context) -> string, like the other coach prompts, so the experiment
// runner can replay a captured question context byte-identically.
export const QUESTION_CLAUSE =
  'You may ALSO ask ONE question by adding "question" to your reply. ' +
  'A yes/no ask is {"question":{"text":"Did lunch sit well?","habit":"LunchSat","ttlMinutes":180}} ' +
  'and renders as a 3-key Approval Gate (APPROVE / DETAILS / DENY) — do not send custom yes/no faces; ' +
  'position is the grammar. A one-of-N ask is ' +
  '{"question":{"text":"Which sat better?","habit":"MealPick","options":[{"label":"Salad"},{"label":"Pasta"}]}} ' +
  'and renders as a Choice Picker (index badges, not numbers in the label). ' +
  'This is the ONLY way you can ask them anything — so spend it on something you genuinely cannot infer from their taps. ' +
  'One open question at a time; asking nothing is usually right.';
