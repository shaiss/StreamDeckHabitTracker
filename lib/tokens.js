// Per-user Stream Deck API tokens.
//
// The plugin already sends `settings.key` as `?key=` on every write and on the
// slots heartbeat. That value used to be the deployment-wide HABIT_KEY; now it
// is a per-user secret (`ht_…`) bound to a Clerk userId. Only the SHA-256 of
// the token is stored — the plaintext is shown once at creation.
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'ht_';
const META_PREFIX = 'habits:apitoken:';       // global (lookup by hash)
const INDEX_PREFIX = 'habits:apitokens:';     // global set of hashes per user

function creds() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  return { url, token };
}

async function cmd(args) {
  const { url, token } = creds();
  if (!url || !token) throw new Error('Storage not connected.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`store ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

export function hashToken(plaintext) {
  return createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

export function looksLikeApiToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 20;
}

/** Create a new token for userId. Returns { token, meta } — token is shown once. */
export async function createApiToken(userId, { label = 'Stream Deck' } = {}) {
  if (!userId) throw new Error('userId required');
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const hash = hashToken(token);
  const meta = {
    userId,
    hash,
    prefix: token.slice(0, 7),
    label: String(label || 'Stream Deck').slice(0, 40),
    createdAt: Date.now()
  };
  await cmd(['SET', META_PREFIX + hash, JSON.stringify(meta)]);
  await cmd(['SADD', INDEX_PREFIX + userId, hash]);
  return { token, meta: { prefix: meta.prefix, label: meta.label, createdAt: meta.createdAt, hash } };
}

/** Resolve a plaintext token to its userId, or null. */
export async function verifyApiToken(plaintext) {
  if (!looksLikeApiToken(plaintext)) return null;
  try {
    const raw = await cmd(['GET', META_PREFIX + hashToken(plaintext)]);
    if (!raw) return null;
    const meta = JSON.parse(raw);
    return meta?.userId || null;
  } catch {
    return null;
  }
}

export async function listApiTokens(userId) {
  const hashes = (await cmd(['SMEMBERS', INDEX_PREFIX + userId])) || [];
  const out = [];
  for (const hash of hashes) {
    const raw = await cmd(['GET', META_PREFIX + hash]);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw);
      out.push({
        hash,
        prefix: m.prefix,
        label: m.label,
        createdAt: m.createdAt
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function revokeApiToken(userId, hash) {
  const raw = await cmd(['GET', META_PREFIX + hash]);
  if (!raw) return false;
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return false;
  }
  if (meta.userId !== userId) return false;
  await cmd(['DEL', META_PREFIX + hash]);
  await cmd(['SREM', INDEX_PREFIX + userId, hash]);
  return true;
}
