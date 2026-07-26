// Tiny storage layer backed by a Redis-compatible REST API.
// Works with Vercel KV or an Upstash Redis integration — both expose a REST
// endpoint + token. We look for the standard env var names first, then fall
// back to auto-detecting any Redis-REST-looking vars, so connecting either
// integration in the Vercel dashboard "just works" no matter how it prefixes
// its variables.

const KEY = 'habits:log';

function creds() {
  const env = process.env;

  // Standard names, in priority order.
  let url =
    env.KV_REST_API_URL ||
    env.UPSTASH_REDIS_REST_URL ||
    env.REDIS_REST_URL ||
    env.STORAGE_REST_API_URL;
  let token =
    env.KV_REST_API_TOKEN ||
    env.UPSTASH_REDIS_REST_TOKEN ||
    env.REDIS_REST_TOKEN ||
    env.STORAGE_REST_API_TOKEN;

  // Fallback: sniff out a REST URL (https, from a redis-ish var).
  if (!url) {
    const k = Object.keys(env).find(
      (k) => /URL$/i.test(k) && /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) && /^https:\/\//i.test(env[k] || '')
    );
    if (k) url = env[k];
  }
  // Fallback: a write token (exclude read-only).
  if (!token) {
    const k = Object.keys(env).find(
      (k) =>
        /TOKEN$/i.test(k) &&
        !/READ_ONLY/i.test(k) &&
        /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) &&
        (env[k] || '').length > 10
    );
    if (k) token = env[k];
  }
  return { url, token };
}

export function isConfigured() {
  const { url, token } = creds();
  return Boolean(url && token);
}

// Names (not values) of detected credential vars — for the health check.
export function detectedKeys() {
  return Object.keys(process.env).filter(
    (k) => /(KV|UPSTASH|REDIS|STORAGE)/i.test(k) && /(URL|TOKEN)$/i.test(k)
  );
}

async function cmd(args) {
  const { url, token } = creds();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    throw new Error(`store ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.result;
}

// Append one entry: { h: habit, t: epoch-ms, note }
export async function append(entry) {
  return cmd(['RPUSH', KEY, JSON.stringify(entry)]);
}

// Delete all stored entries.
export async function clearAll() {
  return cmd(['DEL', KEY]);
}

// Return every entry, oldest first.
export async function all() {
  const res = await cmd(['LRANGE', KEY, '0', '-1']);
  return (res || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
