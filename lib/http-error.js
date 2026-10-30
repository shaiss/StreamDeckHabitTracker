// Client-safe error responses for API handlers (issue #128).
//
// Catch-all 500s used to echo err.message cross-origin (CORS *). Exception
// text from Redis/Upstash, the model provider, or JSON.parse can carry
// hostnames, upstream status, model names, and stored-data fragments.
// Handlers log the real detail server-side (redacted) and return a stable
// generic message to the client.

import { randomBytes } from 'node:crypto';
import { redactKey } from './habit-key.js';

/** Stable client-facing message for unexpected failures. */
export const CLIENT_ERROR = 'Internal error';

/** Cap logged exception text so a huge upstream body cannot flood logs. */
const LOG_DETAIL_MAX = 500;

/**
 * Coarse categories for roster/coach-pass failures that travel in a 200 body
 * (e.g. parseError). Never put err.message here — GET /api/roster is CORS *.
 */
export const COACH_PASS_ERROR = Object.freeze({
  PARSE: 'parse_error',
  TIMEOUT: 'timeout',
  UPSTREAM: 'upstream_error'
});

/** Map a thrown value to a coarse coach-pass code (no raw text). */
export function classifyCoachPassError(err) {
  const name = err && err.name ? String(err.name) : '';
  const msg = String((err && err.message) || err || '');
  if (name === 'AbortError' || /\btimeout\b|\baborted\b/i.test(msg)) {
    return COACH_PASS_ERROR.TIMEOUT;
  }
  // extractJson: missing braces → "no JSON…"; malformed braces → SyntaxError
  // from JSON.parse (message varies by Node: "Unexpected token" / "…is not valid JSON").
  if (
    name === 'SyntaxError' ||
    /no JSON in model reply/i.test(msg) ||
    /not valid JSON|Unexpected token|JSON\.parse/i.test(msg)
  ) {
    return COACH_PASS_ERROR.PARSE;
  }
  return COACH_PASS_ERROR.UPSTREAM;
}

/**
 * Strip credentials from free-form error text before console.error.
 * Starts with HABIT_KEY redaction, then bearer/token/password-shaped fields.
 */
export function redactLogDetail(s) {
  return redactKey(String(s ?? ''))
    // Authorization: Bearer <token> (or Authorization: <token>) as one unit —
    // applying a bare Bearer pass then an Authorization pass leaves a dangling
    // "[redacted]" from the first replace.
    .replace(
      /\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}]+/gi,
      '$1[redacted]'
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._\-+\/=]+/gi, '$1 [redacted]')
    .replace(
      /([?&](?:amp;)?(?:token|access_token|api[_-]?key|password|secret)=)[^&#\s"']*/gi,
      '$1[redacted]'
    )
    .replace(
      /\b((?:api[_-]?key|access_token|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]'
    )
    .slice(0, LOG_DETAIL_MAX);
}

/**
 * Log an unexpected error for Vercel function logs. Returns a short request
 * id that is safe to echo to the client if a caller wants correlation.
 * Never logs HABIT_KEY / ?key= / x-habit-key / bearer / token material.
 */
export function logServerError(err, label = 'handler') {
  const id = randomBytes(4).toString('hex');
  const name = (err && err.name) || 'Error';
  const msg = redactLogDetail((err && err.message) || String(err));
  console.error(label + ':', id, name, msg);
  return id;
}

/**
 * Log `err` and send a generic 500. Keeps response shapes the UI/tests
 * already expect:
 *   - default JSON: `{ error: 'Internal error' }`
 *   - `extra`: merged into the JSON body (e.g. data.js configured/entries)
 *   - `text: true`: plain-text body `Internal error` (api/log.js)
 */
export function sendServerError(res, err, { label = 'handler', extra, text } = {}) {
  logServerError(err, label);
  if (text) {
    res.status(500).send(CLIENT_ERROR);
    return;
  }
  res.status(500).json({ ...(extra || {}), error: CLIENT_ERROR });
}
