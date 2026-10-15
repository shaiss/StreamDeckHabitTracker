// Pure profile-write rules for POST /api/profile (#94 / #95 CR).
// Extracted so unit tests can prove consent ordering without Redis:
//   - coachNav requires a positive integer navSeq (400 otherwise)
//   - unsequenced name/tz/about edits still work
//   - a stale merge that races a newer sequenced consent cannot clobber it
//     when the write is gated by compare-and-set on the raw snapshot
import { normalizeConsent, acceptCoachNavSeq } from './takeover.js';
import { isValidTz } from './tz.js';

export function parseProfileRaw(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * Merge a POST body onto a profile snapshot.
 * @returns {{ ok:true, next, useNavSeq, navSeq } | { ok:false, status, error, coachNav?, coachNavSeq? }}
 */
export function buildProfileNext(prev, body, { now = Date.now() } = {}) {
  const rawNavSeq = body.navSeq !== undefined ? Number(body.navSeq) : NaN;
  const useNavSeq = Number.isFinite(rawNavSeq) && Number.isInteger(rawNavSeq) && rawNavSeq > 0;

  // Consent changes must be ordered. Unsequenced coachNav is how a stale
  // dashboard Save restored may-navigate after the Autonomy key chose MANUAL.
  if (body.coachNav !== undefined && !useNavSeq) {
    return { ok: false, status: 400, error: 'coachNav requires navSeq' };
  }

  const next = { ...prev, updatedAt: now };
  if (body.tz !== undefined) {
    const tz = String(body.tz).trim();
    if (tz && !isValidTz(tz)) {
      return { ok: false, status: 400, error: `Unknown timezone: ${tz}. Use an IANA name like America/New_York.` };
    }
    next.tz = tz;
  }
  if (body.name !== undefined) next.name = String(body.name).slice(0, 60);
  if (body.about !== undefined) next.about = String(body.about).slice(0, 1000);
  if (body.coachNav !== undefined) next.coachNav = normalizeConsent(String(body.coachNav));

  if (useNavSeq) {
    if (body.coachNav === undefined) {
      return { ok: false, status: 400, error: 'navSeq requires coachNav' };
    }
    if (!acceptCoachNavSeq(prev.coachNavSeq, rawNavSeq)) {
      return {
        ok: false,
        status: 409,
        error: 'stale navSeq',
        coachNav: normalizeConsent(prev.coachNav),
        coachNavSeq: Math.max(0, Number(prev.coachNavSeq) || 0)
      };
    }
    next.coachNavSeq = rawNavSeq;
    return { ok: true, next, useNavSeq: true, navSeq: rawNavSeq };
  }
  return { ok: true, next, useNavSeq: false, navSeq: null };
}

/**
 * In-memory CAS store used by unit tests (and as the contract the API
 * handler mirrors against Redis EVAL). `raw` is the JSON string Redis holds.
 *
 * Sequenced writes refuse a stale navSeq. Unsequenced writes CAS against the
 * snapshot they merged from and retry from a fresh read so a concurrent
 * Autonomy MANUAL write cannot be clobbered by a stale name/tz/about save.
 */
export function applyProfileWrite(store, body, { now = Date.now(), maxAttempts = 3 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const expectedRaw = store.raw ?? null;
    const prev = parseProfileRaw(expectedRaw);
    const built = buildProfileNext(prev, body, { now });
    if (!built.ok) return built;

    if (built.useNavSeq) {
      // Match setProfileIfNavSeq: check token against the merge snapshot, then
      // CAS. Null expectedRaw = SET NX (first write); if another creator won,
      // refuse like Redis NX miss → 409.
      if (expectedRaw == null) {
        if (store.raw != null) {
          const cur = parseProfileRaw(store.raw);
          return {
            ok: false,
            status: 409,
            error: 'stale navSeq',
            coachNav: normalizeConsent(cur.coachNav),
            coachNavSeq: Math.max(0, Number(cur.coachNavSeq) || 0)
          };
        }
      } else if (store.raw !== expectedRaw) {
        const cur = parseProfileRaw(store.raw);
        return {
          ok: false,
          status: 409,
          error: 'stale navSeq',
          coachNav: normalizeConsent(cur.coachNav),
          coachNavSeq: Math.max(0, Number(cur.coachNavSeq) || 0)
        };
      }
      store.raw = JSON.stringify(built.next);
      return { ok: true, next: built.next };
    }

    // Unsequenced: CAS (null snapshot → NX). On loss, retry from the live
    // snapshot (preserves whatever coachNav a sequenced writer just stored).
    if (expectedRaw == null) {
      if (store.raw != null) continue;
    } else if (store.raw !== expectedRaw) {
      continue;
    }
    store.raw = JSON.stringify(built.next);
    return { ok: true, next: built.next };
  }
  return { ok: false, status: 409, error: 'profile busy' };
}

/**
 * Simulate the stale-dashboard race: merge from `staleRaw` (what the form
 * loaded) while `store` may already hold a newer Autonomy write. Returns the
 * CAS outcome without retrying — proves an unsequenced write must not land
 * when the snapshot is gone.
 */
export function applyProfileWriteFrom(store, staleRaw, body, { now = Date.now() } = {}) {
  const prev = parseProfileRaw(staleRaw);
  const built = buildProfileNext(prev, body, { now });
  if (!built.ok) return built;
  // Null staleRaw = first-write NX: succeed only while the key is still absent.
  if (staleRaw == null) {
    if (store.raw != null) return { ok: false, status: 409, error: 'cas lost' };
  } else if (store.raw !== staleRaw) {
    return { ok: false, status: 409, error: 'cas lost' };
  }
  store.raw = JSON.stringify(built.next);
  return { ok: true, next: built.next };
}
