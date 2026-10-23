// Shared HABIT_KEY check for every gated route (#112).
//
// Callers may present the key three ways, checked in this order:
//   1. the `x-habit-key` request header — the preferred channel: it stays out
//      of URLs, so it never lands in browser history, proxy logs, or Referer;
//   2. `?key=` — kept only for the transition window, so decks and bookmarks
//      that predate the header keep working until they upgrade;
//      TODO(#115): remove `?key=` (and its CORS/doc mentions) once every
//      caller sends the header; tracked with the HABIT_KEY hardening
//      follow-ups: https://github.com/shaiss/StreamDeckHabitTracker/issues/115
//   3. `body.key` — only on routes that already accepted it (pass `body`).
//
// Fail closed (#112): in production (VERCEL_ENV === 'production') a missing
// or empty HABIT_KEY is a misconfiguration, not "open mode" — every gated
// write answers 503 and does no work. Outside production an unset key keeps
// the old open behavior for local dev and previews. Keys are compared with
// crypto.timingSafeEqual.
import { timingSafeEqual } from 'node:crypto';

export const KEY_HEADER = 'x-habit-key';

export function presentedKeys(req, body) {
  const out = [];
  const h = req && req.headers;
  if (h) {
    const v = typeof h.get === 'function' ? h.get(KEY_HEADER) : h[KEY_HEADER];
    if (typeof v === 'string' && v) out.push(v);
  }
  const q = (req && req.query) || {};
  if (typeof q.key === 'string' && q.key) out.push(q.key);
  if (body && typeof body.key === 'string' && body.key) out.push(body.key);
  return out;
}

export const isProduction = (env = process.env.VERCEL_ENV) => env === 'production';

// Constant-time string compare. timingSafeEqual needs equal lengths, so a
// length mismatch still runs a same-length dummy compare before rejecting —
// the reject path costs about the same as a real compare.
// `b` is the secret. `cmp` is injectable for tests only.
export function safeEqual(a, b, cmp = timingSafeEqual) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  if (A.length !== B.length) {
    cmp(B, B);
    return false;
  }
  return cmp(A, B);
}

const unset = (secret) => typeof secret !== 'string' || secret.trim() === '';

// 200 = proceed, 401 = wrong/missing key, 503 = production with no HABIT_KEY.
export function keyStatus(req, body, secret = process.env.HABIT_KEY, env = process.env.VERCEL_ENV) {
  if (unset(secret)) return isProduction(env) ? 503 : 200;
  let ok = false;
  // Compare every presented candidate (no early exit) so timing does not
  // reveal which channel carried a match.
  for (const k of presentedKeys(req, body)) ok = safeEqual(k, secret) || ok;
  return ok ? 200 : 401;
}

export function keyOk(req, body, secret = process.env.HABIT_KEY, env = process.env.VERCEL_ENV) {
  return keyStatus(req, body, secret, env) === 200;
}

export const MISCONFIGURED = 'Server misconfigured: HABIT_KEY is not set.';

// Route helper: answers 401/503 itself and returns true when the request must
// stop here. `text` routes (api/log.js) reply in plain text.
export function keyDenied(req, res, body, { text = false } = {}) {
  const status = keyStatus(req, body);
  if (status === 200) return false;
  const msg = status === 503 ? MISCONFIGURED : 'Unauthorized';
  if (text) res.status(status).send(msg);
  else res.status(status).json({ error: msg });
  return true;
}

// Strip key material from anything about to be logged: ?key=/&key= query
// values and `x-habit-key: …` header echoes.
export function redactKey(s) {
  return String(s)
    .replace(/([?&](?:amp;)?key=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/(x-habit-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}
