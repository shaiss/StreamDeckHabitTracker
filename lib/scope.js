// Request-scoped user identity for Redis key prefixing.
//
// Cutover rule (Deck product risk — do not weaken):
//   1. NEVER delete, rename, or overwrite legacy unprefixed `habits:*` keys.
//      The owner (HABIT_OWNER_USER_ID) READs/WRITEs those keys in place.
//      There is no copy step and no migration job — mapping is pure and
//      idempotent: redisKey('habits:log') === 'habits:log' for the owner,
//      forever, on every call.
//   2. Anonymous visitors never write. There is NO anonymous→user merge.
//      A new signed-in user's first write goes only to `u:{id}:…` and cannot
//      touch the owner's legacy keys or another user's prefix.
//   3. No cutover date is baked in; ops order is documented in docs/auth.md.
//
// Callers MUST enter via runAsUser() before touching store/habits/dataset —
// missing scope throws rather than leaking global keys.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runAsUser(userId, fn) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('runAsUser: userId required');
  }
  return als.run({ userId }, fn);
}

export function currentUserId() {
  return als.getStore()?.userId || null;
}

export function ownerUserId() {
  return (process.env.HABIT_OWNER_USER_ID || '').trim();
}

/** True when this userId should read/write the legacy unprefixed Redis keys. */
export function isOwner(userId) {
  const owner = ownerUserId();
  return Boolean(owner && userId && userId === owner);
}

/**
 * Map a logical key (`habits:log`) onto the Redis key for the current user.
 * Owner → legacy unprefixed key. Anyone else → `u:{id}:habits:log`.
 */
export function redisKey(base) {
  const uid = currentUserId();
  if (!uid) throw new Error('redisKey: no user scope — call runAsUser first');
  if (isOwner(uid)) return base;
  return `u:${uid}:${base}`;
}
