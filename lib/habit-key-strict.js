// Strict HABIT_KEY gate for /api/profile writes.
//
// Status semantics:
//   200 = proceed
//   401 = HABIT_KEY set, key missing or wrong
//   503 = production (VERCEL_ENV === 'production') with HABIT_KEY unset/blank
// Outside production an unset key keeps the open behavior (local dev,
// previews).
//
// Temporary: superseded once the shared key gate in lib/habit-key.js covers
// this route; then delete this file and its call in api/profile.js.
import { timingSafeEqual } from 'node:crypto';
import { presentedKeys } from './habit-key.js';

export const STRICT_MISCONFIGURED = 'Server misconfigured: HABIT_KEY is not set.';

const unset = (secret) => typeof secret !== 'string' || secret.trim() === '';

// Constant-time compare; a length mismatch still burns a same-length compare.
function eq(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  if (A.length !== B.length) {
    timingSafeEqual(B, B);
    return false;
  }
  return timingSafeEqual(A, B);
}

export function strictKeyStatus(
  req, body, secret = process.env.HABIT_KEY, env = process.env.VERCEL_ENV
) {
  if (unset(secret)) return env === 'production' ? 503 : 200;
  let ok = false;
  for (const k of presentedKeys(req, body)) ok = eq(k, secret) || ok;
  return ok ? 200 : 401;
}

// Answers 401/503 itself; returns true when the caller must stop.
export function requireKeyStrict(req, res, body) {
  const status = strictKeyStatus(req, body);
  if (status === 200) return false;
  res.status(status).json({ error: status === 503 ? STRICT_MISCONFIGURED : 'Unauthorized' });
  return true;
}
