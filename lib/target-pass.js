// I/O side of the adaptive-targets pass (#70).
//
// Kept out of lib/coach.js so the lock, abort-on-read-failure, and write rails
// are unit-testable without pulling the AI SDK. coach.targetPass does the model
// call, then hands raw changes here; api/targets.js uses the same lock for
// human approve/dismiss so neither path can SET a stale snapshot over the other.

import { getTargets, setTargets, setHabitsAndTargets, withTargetsLock } from './store.js';
import { getHabitsStrict, prepareHabits, validateHabits } from './habits.js';
import { zaiModel } from './ai.js';
import {
  normalizeTargets,
  sanitizeTargetChanges,
  applyAutoChanges,
  TARGETS_COOLDOWN_MSG,
  MAX_PENDING
} from './target.js';

export const TARGET_COOLDOWN_MS = 30_000;

// Initial read for a target pass. Store errors MUST propagate — swallowing
// them as null empty-normalizes and the later setTargets would wipe stored
// proposals, history, and rejected dismissals.
export async function readTargetsForPass() {
  return normalizeTargets(await getTargets());
}

// Claim the 30s run window under the shared lock BEFORE the model call.
// Concurrent ?run=1 requests otherwise all pass a pre-check, each spend an
// LLM call, then commit sequentially — defeating the cooldown. Stamping
// lastRunAt here (nudge-style) makes the next claim fail closed until the
// window elapses. Callers map TARGETS_COOLDOWN → HTTP 429.
export async function claimTargetRun() {
  return withTargetsLock(async () => {
    const targets = normalizeTargets(await getTargets());
    const now = Date.now();
    if (now - targets.lastRunAt < TARGET_COOLDOWN_MS) {
      const err = new Error(TARGETS_COOLDOWN_MSG);
      err.code = 'TARGETS_COOLDOWN';
      err.doc = targets;
      throw err;
    }
    // Don't burn a model call (or stamp) while the human is still behind.
    if (targets.proposals.length >= MAX_PENDING) {
      return { skip: true, doc: { ...targets, autoApplied: 0, queued: 0 } };
    }
    const doc = { ...targets, lastRunAt: now };
    await setTargets(doc);
    return { skip: false, doc };
  });
}

// Under the shared targets lock: re-read both docs, sanitize against live
// state, apply auto-downs, queue ups, write. Call after the model returns so
// the lock is not held across the LLM round-trip.
//
// `expectedTargets` is the name→target map the model reasoned over. When a
// habit's live goal has moved since that snapshot (human approve/edit), the
// corresponding raw change is discarded as stale before any write.
export async function commitTargetPass({
  raw,
  parseError = '',
  engine = 'ai-sdk',
  expectedTargets = null
} = {}) {
  return withTargetsLock(async () => {
    const targets = normalizeTargets(await getTargets());
    if (targets.proposals.length >= MAX_PENDING) {
      return { ...targets, autoApplied: 0, queued: 0, parseError };
    }

    const habits = await getHabitsStrict();
    const { auto, queue } = sanitizeTargetChanges(raw, {
      habits,
      rejected: targets.rejected,
      pending: targets.proposals,
      expectedTargets
    });

    let targetsDoc = {
      ...targets,
      proposals: [...targets.proposals, ...queue].slice(0, MAX_PENDING)
    };
    let appliedList = [];
    let habitsClean = null;

    if (auto.length) {
      const applied = applyAutoChanges({
        habits,
        targets: targetsDoc,
        changes: auto
      });
      // A sanitize bug must never write a broken roster — skip the auto-apply
      // (and its history) if the projected list fails validation.
      if (!validateHabits(applied.habits) && applied.applied.length) {
        habitsClean = prepareHabits(applied.habits);
        targetsDoc = applied.targets;
        appliedList = applied.applied;
      }
    }

    const doc = {
      ...targetsDoc,
      lastRunAt: Date.now(),
      model: zaiModel(),
      engine
    };
    // Goal + history must land together — a lone saveHabits before setTargets
    // can leave the roster updated with no matching history on a second-write fail.
    if (habitsClean) await setHabitsAndTargets(habitsClean, doc);
    else await setTargets(doc);
    return {
      ...doc,
      autoApplied: appliedList.length,
      queued: queue.length,
      applied: appliedList,
      parseError
    };
  });
}
