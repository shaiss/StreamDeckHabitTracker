// I/O side of the adaptive-targets pass (#70).
//
// Kept out of lib/coach.js so the lock, abort-on-read-failure, and write rails
// are unit-testable without pulling Mastra. coach.targetPass does the model
// call, then hands raw changes here; api/targets.js uses the same lock for
// human approve/dismiss so neither path can SET a stale snapshot over the other.

import { getTargets, setTargets, setHabitsAndTargets, withTargetsLock } from './store.js';
import { getHabitsStrict, prepareHabits, validateHabits } from './habits.js';
import { zaiModel } from './ai.js';
import {
  normalizeTargets,
  sanitizeTargetChanges,
  applyAutoChanges,
  MAX_PENDING
} from './target.js';

// Initial read for a target pass. Store errors MUST propagate — swallowing
// them as null empty-normalizes and the later setTargets would wipe stored
// proposals, history, and rejected dismissals.
export async function readTargetsForPass() {
  return normalizeTargets(await getTargets());
}

// Under the shared targets lock: re-read both docs, sanitize against live
// state, apply auto-downs, queue ups, write. Call after the model returns so
// the lock is not held across the LLM round-trip.
export async function commitTargetPass({ raw, parseError = '', engine = 'mastra' } = {}) {
  return withTargetsLock(async () => {
    const targets = normalizeTargets(await getTargets());
    if (targets.proposals.length >= MAX_PENDING) {
      return { ...targets, autoApplied: 0, queued: 0, parseError };
    }

    const habits = await getHabitsStrict();
    const { auto, queue } = sanitizeTargetChanges(raw, {
      habits,
      rejected: targets.rejected,
      pending: targets.proposals
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
