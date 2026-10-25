// Per-user Stream Deck API tokens.
//
// The plugin already sends `settings.key` / global habitKey as `x-habit-key`
// on every write and on the slots heartbeat. That value used to be the
// deployment-wide HABIT_KEY; now it is a per-user secret (`ht_…`) bound to a
// Clerk userId.
//
// Storage: only a peppered SHA-256 of the token is stored (never plaintext).
// Keys go through REDIS_KEY_PREFIX / preview isolation via lib/store.js so a
// preview deployment cannot mint or revoke production tokens. Lookup keys are
// global within the environment (hash → meta); the per-user index is separate.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { redisCmd, redisKeyPrefix, isConfigured } from './store.js';

const TOKEN_PREFIX = 'ht_';
const META_PREFIX = 'habits:apitoken:'; // env-prefixed; lookup by hash
const INDEX_PREFIX = 'habits:apitokens:'; // env-prefixed; set of hashes per user

export function tokenPepper() {
  return (process.env.HABIT_TOKEN_PEPPER || '').trim();
}

function envKey(logical) {
  return redisKeyPrefix() + logical;
}

export function hashToken(plaintext, pepper = tokenPepper()) {
  // Pepper is required for any real deploy; empty pepper is only for tests that
  // inject one. create/verify refuse when env pepper is missing.
  return createHash('sha256')
    .update(String(pepper), 'utf8')
    .update('\0', 'utf8')
    .update(String(plaintext), 'utf8')
    .digest('hex');
}

export function looksLikeApiToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 20;
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function cmd(args) {
  // redisCmd asserts preview isolation; tokens share the same Redis gate.
  return redisCmd(args);
}

/** Create a new token for userId. Returns { token, meta } — token is shown once. */
export async function createApiToken(userId, { label = 'Stream Deck' } = {}) {
  if (!userId) throw new Error('userId required');
  if (!tokenPepper()) throw new Error('HABIT_TOKEN_PEPPER is not set');
  if (!isConfigured()) throw new Error('Storage not connected.');
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const hash = hashToken(token);
  const meta = {
    userId,
    hash,
    prefix: token.slice(0, 7),
    label: String(label || 'Stream Deck').slice(0, 40),
    createdAt: Date.now()
  };
  const metaKey = envKey(META_PREFIX + hash);
  const indexKey = envKey(INDEX_PREFIX + userId);
  await cmd(['SET', metaKey, JSON.stringify(meta)]);
  try {
    await cmd(['SADD', indexKey, hash]);
  } catch (err) {
    // Partial write: drop orphaned meta so a failed create cannot leave an
    // active, unlistable credential.
    await cmd(['DEL', metaKey]).catch(() => {});
    throw err;
  }
  return { token, meta: { prefix: meta.prefix, label: meta.label, createdAt: meta.createdAt, hash } };
}

/** Resolve a plaintext token to its userId, or null (missing/corrupt). Infra errors propagate. */
export async function verifyApiToken(plaintext) {
  if (!looksLikeApiToken(plaintext)) return null;
  if (!tokenPepper()) return null;
  if (!isConfigured()) throw new Error('Storage not connected.');
  const hash = hashToken(plaintext);
  const raw = await cmd(['GET', envKey(META_PREFIX + hash)]);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw);
    if (!meta || typeof meta.hash !== 'string' || !safeEqualHex(meta.hash, hash)) return null;
    return meta.userId || null;
  } catch {
    return null; // corrupt record = invalid credential
  }
}

export async function listApiTokens(userId) {
  if (!isConfigured()) throw new Error('Storage not connected.');
  const hashes = (await cmd(['SMEMBERS', envKey(INDEX_PREFIX + userId)])) || [];
  const out = [];
  for (const hash of hashes) {
    const raw = await cmd(['GET', envKey(META_PREFIX + hash)]);
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
  if (!isConfigured()) throw new Error('Storage not connected.');
  const metaKey = envKey(META_PREFIX + hash);
  const raw = await cmd(['GET', metaKey]);
  if (!raw) return false;
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return false;
  }
  if (meta.userId !== userId) return false;
  await cmd(['DEL', metaKey]);
  await cmd(['SREM', envKey(INDEX_PREFIX + userId), hash]);
  return true;
}
