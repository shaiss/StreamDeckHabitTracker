// Coach questions as a first-class primitive (issue #34).
//
// Reactive 👍/👎 feedback keys already existed ad hoc — the coach would just
// happen to emit a FoodGood/FoodBad pair and hope the human read them as a
// pair. Nothing linked the two keys, nothing recorded that a question had been
// ASKED, and an unanswered question was indistinguishable from a suggestion
// nobody tapped.
//
// This module makes the pair explicit: one question spawns two linked slot
// keys sharing a `qid`, differing only in `answer`. Tapping either one answers
// it and retires BOTH — a question is spent once it has been answered.
//
// It is the only way the coach can ever ask its human anything, which is
// exactly why it is rate-limited: one open question at a time, with a gap
// between them. A coach that can ask is a coach that can badger.
//
// Dependency-free and pure, like nudge.js and roster.js, so the zero-dep unit
// suite can pin the rules without Redis.

export const QUESTION_TTL_MS = 3 * 3600_000;    // time to answer before it lapses
export const QUESTION_GAP_MS = 6 * 3600_000;    // between one question and the next
export const MAX_TEXT = 120;

// Coerce a model-proposed question into a safe pair of slot defs, or null when
// it is unusable. Mirrors sanitize() in coach-shape.js: never throws, drops
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

  const side = (src, answer, fallbackEmoji, fallbackLabel) => ({
    habit,
    emoji: String((src && src.emoji) || fallbackEmoji).slice(0, 8),
    label: String((src && src.label) || fallbackLabel).slice(0, 12),
    // The question text rides on both keys so the dashboard, the virtual deck
    // and a hover tooltip can all show WHAT is being asked, not just the
    // answer's label.
    reason: text,
    question: text,
    qid,
    answer,
    assignedAt: now,
    expiresAt
  });

  return {
    qid,
    text,
    habit,
    askedAt: now,
    expiresAt,
    pair: [side(raw.yes, 'yes', '👍', 'Yes'), side(raw.no, 'no', '👎', 'No')]
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

// Two slots for the pair: prefer empty ones, then the stalest assignments, and
// never steal a live nudge — a nudge is already the coach interrupting, and
// talking over itself is worse than waiting.
export function pickQuestionSlots(slots, now = Date.now()) {
  const free = [];
  const busy = [];
  for (let i = 0; i < 4; i++) {
    const s = slots[i];
    if (s && s.nudge && (!s.expiresAt || s.expiresAt > now)) continue;   // off limits
    if (!s || (s.expiresAt && s.expiresAt < now)) free.push(i + 1);
    else busy.push({ slot: i + 1, at: s.assignedAt || 0 });
  }
  busy.sort((a, b) => a.at - b.at);
  const picked = [...free, ...busy.map((b) => b.slot)].slice(0, 2);
  return picked.length === 2 ? picked : null;
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
  'You may ALSO ask ONE yes/no question by adding "question" to your reply: ' +
  '{"question":{"text":"Did lunch sit well?","habit":"LunchSat","yes":{"emoji":"👍","label":"Good"},' +
  '"no":{"emoji":"👎","label":"Rough"},"ttlMinutes":180}}. It spawns a linked pair of keys and is the ONLY ' +
  'way you can ask them anything — so spend it on something you genuinely cannot infer from their taps. ' +
  'One open question at a time; asking nothing is usually right.';
