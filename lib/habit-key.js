// Shared HABIT_KEY check for every gated route (issue #112 prep).
//
// Callers may present the key three ways, checked in this order:
//   1. the `x-habit-key` request header — the preferred channel: it stays out
//      of URLs, so it never lands in browser history, proxy logs, or Referer;
//   2. `?key=` — kept only for the #112 transition window, so decks and
//      bookmarks that predate the header keep working until they upgrade;
//   3. `body.key` — only on routes that already accepted it (pass `body`).
//
// Semantics are otherwise UNCHANGED: when HABIT_KEY is unset this still
// answers true (fail-open). Failing closed in production and the timing-safe
// compare are #112's job, deliberately not done here.
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

export function keyOk(req, body, secret = process.env.HABIT_KEY) {
  if (!secret) return true;
  return presentedKeys(req, body).some((k) => k === secret);
}

// Strip key material from anything about to be logged: ?key=/&key= query
// values and `x-habit-key: …` header echoes.
export function redactKey(s) {
  return String(s)
    .replace(/([?&](?:amp;)?key=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/(x-habit-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}
