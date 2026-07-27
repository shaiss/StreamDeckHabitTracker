// The AI coach: decides what the 4 slot keys should be. Runs purely on a
// Mastra agent (lib/agent.js): the agent owns the hypothesis-memory loop (a
// recall tool + an update tool), and a custom fetch injects thinking:disabled
// so GLM-5.x doesn't burn its token budget reasoning (see lib/agent.js, PR #2).
// There is no raw-z.ai fallback: a framework hiccup surfaces as a clean error
// (each caller decides how to fail — react/nudge no-op, suggest/morning answer
// 502, roster queues nothing). The one place chat() is still called directly is
// /api/experiment, which needs byte-identical model-vs-model comparison.
//
// Every pass sees: the human's profile (name/about/timezone from settings),
// and its behavioral track record — which past slot keys the human actually
// tapped vs ignored (lib/scorer.js). That last loop is how the coach learns
// what lands (issue #6).
import { all, getSlots, setSlots, setInsight, getProfile, getSlotHistory, getRoster, setRoster, getNudgeState, setNudgeState, getDismissals, getQuestions, appendQuestion, patchQuestion } from './store.js';
import { extractJson, zaiModel } from './ai.js';
import { getHabits } from './habits.js';
import { coachAgent } from './agent.js';
import { sanitize, PROMPTS } from './coach-shape.js';
import { tzHelpers } from './tz.js';
import { scoreSuggestions, scoreNudges } from './scorer.js';
import { captureItem } from './dataset.js';
import { sanitizeProposals, normalizeRoster, MAX_PENDING } from './roster.js';
import { nudgeDue, pickNudgeSlot, CHECK_EVERY_MS, NUDGE_TTL_MS } from './nudge.js';
import { sanitizeQuestion, questionDue, pickQuestionSlots, scoreQuestions, openQuestion } from './question.js';

// Re-export the pure shapers so existing imports (api/experiment.js PROMPTS,
// tests) keep working; the definitions live in the dep-free coach-shape.js.
export { sanitize, PROMPTS };

export const REACT_COOLDOWN_MS = 45_000;
export const ROSTER_COOLDOWN_MS = 30_000;
const REACTIVE_TTL_MS = 2 * 3600_000; // feedback keys from reactive passes expire

export function summarize(entries, tzh, days = 14) {
  const cutoff = Date.now() - days * 86400_000;
  const recent = entries.filter((e) => e.t >= cutoff);
  const perHabit = {};
  for (const e of recent) {
    const s = (perHabit[e.h] ||= { taps: 0, big: 0, hours: {}, days: new Set() });
    s.taps++;
    if (e.i === 'high') s.big++;   // double-tapped: "that one was a big one"
    s.hours[tzh.hour(e.t)] = (s.hours[tzh.hour(e.t)] || 0) + 1;
    s.days.add(tzh.day(e.t));
  }
  return {
    timezone: tzh.tz,
    daysOfData: new Set(recent.map((e) => tzh.day(e.t))).size,
    totalTaps: recent.length,
    habits: Object.fromEntries(
      Object.entries(perHabit).map(([h, s]) => [
        h,
        {
          taps: s.taps,
          activeDays: s.days.size,
          // Omitted entirely when zero: a habit nobody double-taps should not
          // spend context on a field that always reads 0.
          ...(s.big ? { bigTaps: s.big } : {}),
          topHours: Object.entries(s.hours).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h2]) => +h2)
        }
      ])
    )
  };
}

// Fire-and-forget dataset capture; never lets a telemetry failure hurt a pass.
function capture(kind, context, rawSlots, engine, fixedNames) {
  captureItem({ kind, context, rawSlots, engine, model: zaiModel(), fixedNames }).catch(() => {});
}

// Shared per-pass context: profile, tz helpers, entries, track record.
async function gather() {
  const [profile, entries, history, habits, dismissals, questions] = await Promise.all([
    getProfile().catch(() => null),
    all(),
    getSlotHistory().catch(() => []),
    getHabits(),
    getDismissals().catch(() => []),
    getQuestions().catch(() => [])
  ]);
  const tzh = tzHelpers(profile?.tz);
  const track = scoreSuggestions(history, entries);
  return {
    tzh,
    entries,
    habits,
    dismissals,
    questions,
    questionRecord: {
      note: 'Questions you asked via 👍/👎 key pairs, and what came back. answered = they told you, dismissed = they refused, ignored = it lapsed. recentAnswers is the actual information you have been given — fold it into your hypotheses.',
      ...scoreQuestions(questions),
      openNow: openQuestion(questions)
    },
    nudgeRecord: {
      note: 'Your past nudges. tapped = they acted, dismissed = they explicitly waved it away, ignored = it expired unseen. A habit that keeps getting dismissed is one you should stop poking about.',
      ...scoreNudges(history, entries, dismissals)
    },
    fixedHabitsStr: habits.map((h) => `${h.emoji} ${h.name}`).join(', '),
    reserved: habits.map((h) => h.name.toLowerCase()),
    human: {
      name: profile?.name || '',
      about: profile?.about || '',
      timezone: tzh.tz
    },
    trackRecord: {
      note: 'Keys you offered before and whether the human actually tapped them. Drop asks that keep getting ignored; build on what lands.',
      ...track
    }
  };
}

// Ask the coach. Pure Mastra: the agent owns hypothesis recall (via its own
// recall tool) and update. Throws propagate — callers decide how to fail.
// `generate` is injectable so ask() can be unit-tested without Redis or a
// network; it defaults to the real agent's generate().
export async function ask(request, { generate } = {}) {
  const gen = generate || ((prompt) => coachAgent().generate(prompt));
  const res = await gen(request);
  const text = typeof res === 'string' ? res : res?.text;
  if (!text || !text.trim()) throw new Error('agent returned no text');
  return { text, engine: 'mastra' };
}

async function commitSlots(items, engine, { defaultTtlMs = 0, reserved } = {}) {
  const slots = sanitize(items, { defaultTtlMs, reserved });
  if (!slots.length) return null;
  while (slots.length < 4) slots.push(null);
  // An open question owns its two keys until it is answered, dismissed, or
  // lapses. A slots array REPLACES all four, so without this a routine morning
  // or reactive pass would silently retract a question the human is still
  // looking at — and the record would then score as "ignored" (#34).
  const now = Date.now();
  const prevSlots = (await getSlots()).slots;
  for (let i = 0; i < 4; i++) {
    const s = prevSlots[i];
    if (s && s.qid && (!s.expiresAt || s.expiresAt > now)) slots[i] = s;
  }
  const doc = { slots, suggestedAt: now, reactedAt: now, model: zaiModel(), engine };
  await setSlots(doc);
  return doc;
}

// --- questions (#34) -------------------------------------------------------

// Drop every key belonging to a question. Both halves go together: a pair with
// one key left is a question that can be answered twice.
async function retirePair(qid) {
  const doc = await getSlots();
  const slots = doc.slots.map((s) => (s && s.qid === qid ? null : s));
  await setSlots({ ...doc, slots });
}

// Called from /api/log when a question key is tapped. The tap already logged;
// this records WHICH way it was answered and retires the pair.
export async function answerQuestion(def) {
  await patchQuestion(def.qid, { answer: def.answer, answeredAt: Date.now() });
  await retirePair(def.qid);
}

// Called from /api/question?dismiss=1 — the long-press "I'm not answering
// that", which must stay distinguishable from letting it lapse unseen.
export async function dismissQuestion(qid) {
  const rec = await patchQuestion(qid, { dismissedAt: Date.now() });
  if (rec) await retirePair(qid);
  return rec;
}

// Put a freshly sanitized question on the deck, if the gate allows and there
// is room. Returns the record or null; never throws into a coach pass.
async function commitQuestion(raw, ctx) {
  if (!raw) return null;
  const gate = questionDue({ records: ctx.questions });
  if (!gate.due) return null;
  const q = sanitizeQuestion(raw, { reserved: ctx.reserved });
  if (!q) return null;
  const doc = await getSlots();
  const picked = pickQuestionSlots(doc.slots);
  if (!picked) return null;   // every slot is a live nudge — wait our turn
  const slots = doc.slots.slice();
  slots[picked[0] - 1] = q.pair[0];
  slots[picked[1] - 1] = q.pair[1];
  await setSlots({ ...doc, slots, model: zaiModel() });
  await appendQuestion({ qid: q.qid, text: q.text, habit: q.habit, askedAt: q.askedAt, expiresAt: q.expiresAt });
  return q;
}

export async function fullSuggest() {
  const prev = await getSlots();
  const ctx = await gather();
  const context = {
    human: ctx.human,
    fixedHabits: ctx.fixedHabitsStr,
    currentAiSlots: prev.slots.filter(Boolean).map((s) => s.habit).join(', ') || 'none',
    trackRecord: ctx.trackRecord,
    questionRecord: ctx.questionRecord,
    last14Days: summarize(ctx.entries, ctx.tzh)
  };
  // No raw-z.ai fallback anymore: a coach failure is a clean 502, not a 500.
  // (api/suggest.js maps a null return to the "no usable suggestions" 502.)
  let text, engine;
  try {
    ({ text, engine } = await ask(PROMPTS.suggest(context)));
  } catch {
    return null;
  }
  const parsed = extractJson(text);
  capture('suggest', context, parsed.slots, engine, ctx.reserved);
  const doc = await commitSlots(parsed.slots, engine, { reserved: ctx.reserved });
  await commitQuestion(parsed.question, ctx);
  return doc;
}

// Background pass after a tap. Never throws to the caller; failures just mean
// the keys stay as they were.
export async function reactTo(entry) {
  const prev = await getSlots();
  if (Date.now() - (prev.reactedAt || 0) < REACT_COOLDOWN_MS) return;
  // Claim the window first so concurrent taps don't double-fire the model.
  await setSlots({ ...prev, reactedAt: Date.now() });

  const ctx = await gather();
  const today = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now()));
  const context = {
    human: ctx.human,
    justTapped: {
      habit: entry.h,
      emoji: entry.e || '',
      viaAiSlot: Boolean(entry.slot),
      localHour: ctx.tzh.hour(entry.t),
      // 'high' means they double-tapped — a big meal, a hard workout.
      intensity: entry.i || 'normal'
    },
    todayTaps: today.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
    currentAiSlots: prev.slots,
    fixedHabits: ctx.fixedHabitsStr,
    trackRecord: ctx.trackRecord,
    questionRecord: ctx.questionRecord,
    last14Days: summarize(ctx.entries, ctx.tzh)
  };
  const { text, engine } = await ask(PROMPTS.react(context));
  const parsed = extractJson(text);
  if (!parsed) return;
  if (parsed.change !== false && Array.isArray(parsed.slots)) {
    capture('react', context, parsed.slots, engine, ctx.reserved);
    await commitSlots(parsed.slots, engine, { defaultTtlMs: REACTIVE_TTL_MS, reserved: ctx.reserved });
  }
  // The question lands AFTER any slot rewrite — commitSlots replaces all four,
  // so asking first would wipe the pair we just placed. A tap is also the best
  // possible moment to ask: they are right there, holding the context.
  await commitQuestion(parsed.question, ctx);
}

// Scheduled morning pass (cron): set the day's keys before the human wakes.
export async function morningPass() {
  const prev = await getSlots();
  const ctx = await gather();
  const yesterday = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now() - 86400_000));
  const context = {
    human: ctx.human,
    fixedHabits: ctx.fixedHabitsStr,
    currentAiSlots: prev.slots,
    yesterdayTaps: yesterday.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
    trackRecord: ctx.trackRecord,
    questionRecord: ctx.questionRecord,
    last14Days: summarize(ctx.entries, ctx.tzh)
  };
  let text, engine;
  try {
    ({ text, engine } = await ask(PROMPTS.morning(context)));
  } catch {
    return null;
  }
  const parsed = extractJson(text);
  capture('morning', context, parsed.slots, engine, ctx.reserved);
  const doc = await commitSlots(parsed.slots, engine, { reserved: ctx.reserved });
  await commitQuestion(parsed.question, ctx);
  return doc;
}

// Scheduled roster pass (cron, right after the morning keys): the coach
// reviews the FIXED roster and proposes additions/retirements. It only ever
// queues proposals — applying one takes a human decision (api/roster.js).
//
// Deliberately not captured into the dataset: that corpus and lib/quality.js
// are slot-shaped, and roster proposals would score as noise.
export async function rosterPass() {
  const roster = normalizeRoster(await getRoster().catch(() => null));
  // Don't spend a model call while the human is still behind on decisions.
  if (roster.proposals.length >= MAX_PENDING) return { ...roster, added: 0 };

  const ctx = await gather();
  const context = {
    human: ctx.human,
    roster: ctx.habits.map((h) => ({
      name: h.name,
      emoji: h.emoji,
      label: h.label,
      origin: h.origin === 'coach' ? 'coach' : 'human'
    })),
    awaitingDecision: roster.proposals.map((p) => `${p.kind} ${p.name}`),
    alreadyDismissed: {
      note: 'The human said no to these — do not ask again.',
      keys: roster.rejected
    },
    retired: roster.archive.map((a) => a.name),
    trackRecord: ctx.trackRecord,
    last14Days: summarize(ctx.entries, ctx.tzh)
  };
  // "No changes today" is the expected answer most days, so an unreadable
  // reply OR a coach failure means no proposals — not a failed request. Report
  // it rather than swallowing it, but never let it 500 the caller.
  let raw = null;
  let parseError = '';
  let engine = 'mastra';
  try {
    const { text } = await ask(PROMPTS.roster(context));
    raw = extractJson(text).proposals;
  } catch (err) {
    parseError = String(err?.message || err).slice(0, 140);
  }
  const fresh = sanitizeProposals(raw, {
    habits: ctx.habits,
    rejected: roster.rejected,
    pending: roster.proposals
  });
  const doc = {
    ...roster,
    proposals: [...roster.proposals, ...fresh].slice(0, MAX_PENDING),
    lastRunAt: Date.now(),
    model: zaiModel(),
    engine
  };
  await setRoster(doc);
  // parseError stays out of the stored doc — it describes this pass, not state.
  return { ...doc, added: fresh.length, parseError };
}

// Proactive nudge pass, driven by the deck's own /api/slots poll (no cron):
// the coach may repaint ONE slot key as a nudge when the data shows something
// concrete slipping. Gate rules and the prompt live in lib/nudge.js. The
// throttle claims checkedAt in Redis BEFORE any expensive work, so a 15s poll
// loop costs one Redis read almost every time and a full evaluation at most
// every CHECK_EVERY_MS.
export async function nudgePass({ force = false } = {}) {
  const state = (await getNudgeState().catch(() => null)) || {};
  const now = Date.now();
  if (!force && now - (state.checkedAt || 0) < CHECK_EVERY_MS) {
    return { nudged: false, skipped: 'checked recently' };
  }
  await setNudgeState({ ...state, checkedAt: now });

  const prev = await getSlots();
  const ctx = await gather();
  const summary = summarize(ctx.entries, ctx.tzh);
  const due = nudgeDue({
    now,
    hour: ctx.tzh.hour(now),
    lastNudgeAt: state.lastAt || 0,
    lastTapAt: ctx.entries.at(-1)?.t || 0,
    daysOfData: summary.daysOfData,
    slots: prev.slots,
    lastDismissAt: state.lastDismissAt || 0
  });
  if (!due.due && !force) return { nudged: false, skipped: due.reason };

  const today = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(now));
  const dismissedToday = [
    ...new Set(ctx.dismissals.filter((d) => ctx.tzh.day(d.at) === ctx.tzh.day(now)).map((d) => d.habit))
  ];
  const context = {
    human: ctx.human,
    localHour: ctx.tzh.hour(now),
    todayTaps: today.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
    currentAiSlots: prev.slots,
    fixedHabits: ctx.fixedHabitsStr,
    trackRecord: ctx.trackRecord,
    // The three-way outcome history: which pokes get acted on, which get
    // waved away, and which are simply never seen (issue #35).
    nudgeRecord: ctx.nudgeRecord,
    dismissedToday: {
      note: 'They long-pressed "not today" on these since midnight. Do not raise them again today.',
      habits: dismissedToday
    },
    last14Days: summary
  };
  const { text, engine } = await ask(PROMPTS.nudge(context));
  const parsed = extractJson(text);
  if (!parsed || parsed.nudge === false || !parsed.habit) {
    return { nudged: false, skipped: 'coach declined' };
  }
  // No reserved list on purpose: a nudge may duplicate a fixed habit —
  // "💧 Water?" is a valid poke even though a Drink key exists, and tapping
  // it logs that habit via the normal slot resolution.
  const [def] = sanitize([parsed], { defaultTtlMs: NUDGE_TTL_MS });
  if (!def) return { nudged: false, skipped: 'unusable reply' };
  def.nudge = true;
  const requested = parseInt(parsed.slot, 10);
  const slot = requested >= 1 && requested <= 4 ? requested : pickNudgeSlot(prev.slots, now);
  capture('nudge', context, [parsed], engine, ctx.reserved);

  const slots = prev.slots.slice();
  slots[slot - 1] = def;
  await setSlots({ ...prev, slots, model: zaiModel(), engine });
  await setNudgeState({ ...state, checkedAt: now, lastAt: now, habit: def.habit, slot, count: (state.count || 0) + 1 });
  return { nudged: true, slot, def, engine };
}

// Scheduled daily digest (cron): a short insight for the dashboard.
export async function dailyDigest() {
  const ctx = await gather();
  const today = ctx.entries.filter((e) => ctx.tzh.day(e.t) === ctx.tzh.day(Date.now()));
  let text, engine;
  try {
    ({ text, engine } = await ask(
      'Write your end-of-day note to your human: 2-3 sentences — what you observed today, one pattern or ' +
      'hypothesis, and what you are watching for tomorrow. Warm, specific, no filler. Address them by name ' +
      'if you know it. ' +
      'Reply with ONLY JSON: {"insight":"..."}\n\n' +
      'Context: ' +
      JSON.stringify({
        human: ctx.human,
        todayTaps: today.map((e) => ({ h: e.h, hour: ctx.tzh.hour(e.t) })),
        trackRecord: ctx.trackRecord,
        last14Days: summarize(ctx.entries, ctx.tzh)
      })
    ));
  } catch {
    return null;
  }
  const insight = String(extractJson(text).insight || '').slice(0, 600);
  if (!insight) return null;
  const doc = { text: insight, date: ctx.tzh.day(Date.now()), model: zaiModel(), engine, at: Date.now() };
  await setInsight(doc);
  return doc;
}
