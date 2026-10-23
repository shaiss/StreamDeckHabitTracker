// Shared HABIT_KEY gate for write endpoints. Prefer the `x-habit-key` header
// (web UI); `?key=` / body.key remain for the Stream Deck plugin and older
// callers. Timing-safe compare when a secret is configured; open when unset.
import { timingSafeEqual } from 'node:crypto';

export const HABIT_KEY_HEADER = 'x-habit-key';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length guard required — timingSafeEqual throws on unequal lengths.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function headerKey(req) {
  const headers = req?.headers;
  if (!headers) return '';
  const raw = headers[HABIT_KEY_HEADER] ?? headers['X-Habit-Key'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v == null ? '' : String(v);
}

/** First non-empty candidate: header, then query, then JSON body. */
export function providedKey(req) {
  const fromHeader = headerKey(req);
  if (fromHeader) return fromHeader;
  const q = req?.query || {};
  if (q.key != null && String(q.key) !== '') return String(q.key);
  const body = typeof req?.body === 'object' && req.body ? req.body : {};
  if (body.key != null && String(body.key) !== '') return String(body.key);
  return '';
}

/**
 * @param {object} req  Vercel/Node-style request ({ headers, query, body })
 * @param {string} [secret]  defaults to process.env.HABIT_KEY
 * @returns {boolean} true when no secret is set, or the provided key matches
 */
export function keyOk(req, secret = process.env.HABIT_KEY) {
  if (!secret) return true;
  return safeEqual(providedKey(req), String(secret));
}
