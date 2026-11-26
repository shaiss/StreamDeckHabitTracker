// Issue #128: client-facing errors must never echo raw exception text.
// Zero-dep unit suite: do NOT import api/log.js (@vercel/functions) or any
// other handler that needs npm packages. Helper tests + light handlers only;
// api/log.js wiring is asserted from source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_ERROR,
  COACH_PASS_ERROR,
  classifyCoachPassError,
  logServerError,
  redactLogDetail,
  sendServerError
} from '../../lib/http-error.js';
import { rosterPass } from '../../lib/coach.js';
import dataHandler from '../../api/data.js';
import habitsHandler from '../../api/habits.js';
import rosterHandler from '../../api/roster.js';
import profileHandler from '../../api/profile.js';
import questionHandler from '../../api/question.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SENTINEL = 'LEAK_SENTINEL_upstash.example/redis-host_glm-5.2_status_503';

function redisOk(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
    text: async () => JSON.stringify({ result })
  };
}

function withRedis(handlers, fn) {
  const originalFetch = globalThis.fetch;
  const env = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    HABIT_KEY: process.env.HABIT_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY
  };
  globalThis.fetch = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    const cmd = String(args[0] || '').toUpperCase();
    if (typeof handlers === 'function') return handlers(args);
    const reply = handlers[cmd];
    if (reply === undefined) throw new Error(`unexpected redis ${args[0]}`);
    const result = typeof reply === 'function' ? await reply(args) : reply;
    if (result && typeof result === 'object' && typeof result.json === 'function') return result;
    return redisOk(result);
  };
  process.env.VERCEL_ENV = 'production';
  process.env.KV_REST_API_URL = 'https://example.test';
  process.env.KV_REST_API_TOKEN = 'test';
  delete process.env.HABIT_KEY;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      globalThis.fetch = originalFetch;
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

/** Quiet Redis for gather()/rosterPass: empty reads, OK writes. */
function quietRedis() {
  return {
    GET: () => null,
    LRANGE: () => [],
    SET: () => 'OK',
    RPUSH: () => 1,
    LTRIM: () => 'OK'
  };
}

function mkRes() {
  const res = { statusCode: 200, body: undefined, headers: {}, text: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.text = b; res.body = b; return res; };
  res.end = () => res;
  return res;
}

function bodyHasSentinel(res) {
  return JSON.stringify(res.body ?? '').includes(SENTINEL)
    || String(res.text ?? '').includes(SENTINEL);
}

test('CLIENT_ERROR is a stable generic string', () => {
  assert.equal(CLIENT_ERROR, 'Internal error');
});

test('classifyCoachPassError never returns the raw message', () => {
  assert.equal(
    classifyCoachPassError(new Error('no JSON in model reply')),
    COACH_PASS_ERROR.PARSE
  );
  assert.equal(
    classifyCoachPassError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    COACH_PASS_ERROR.TIMEOUT
  );
  assert.equal(
    classifyCoachPassError(new Error('request timeout after 30s')),
    COACH_PASS_ERROR.TIMEOUT
  );
  // Malformed model JSON → JSON.parse SyntaxError (extractJson wide slice).
  assert.equal(
    classifyCoachPassError(Object.assign(new Error('Unexpected token o in JSON'), { name: 'SyntaxError' })),
    COACH_PASS_ERROR.PARSE
  );
  assert.equal(
    classifyCoachPassError(Object.assign(new Error('Expected property name or } in JSON at position 1'), { name: 'SyntaxError' })),
    COACH_PASS_ERROR.PARSE
  );
  const upstream = new Error(`z.ai 503 (glm-5.2): ${SENTINEL}`);
  const code = classifyCoachPassError(upstream);
  assert.equal(code, COACH_PASS_ERROR.UPSTREAM);
  assert.ok(!code.includes(SENTINEL));
  assert.ok(!String(code).includes('z.ai'));
  assert.ok(!String(code).includes('glm'));
});

test('redactLogDetail strips HABIT_KEY, bearer, and token material', () => {
  // Built at runtime: a literal ?key=<token> in this file trips the secret scanner.
  const sample = 'super-secret-' + 'habit-key-value';
  const keyed = 'boom ?' + 'key=' + sample;
  assert.ok(redactLogDetail(keyed).includes('[redacted]'));
  assert.ok(!redactLogDetail(keyed).includes(sample));

  const bearer = 'upstream Authorization: Bearer eyJhbGciOi.super.secret';
  const bearerOut = redactLogDetail(bearer);
  assert.match(bearerOut, /Authorization:\s*Bearer\s*\[redacted\]/i);
  assert.ok(!bearerOut.includes('eyJhbGciOi'));
  assert.equal((bearerOut.match(/\[redacted\]/g) || []).length, 1);

  // Quoted bearer + opaque chars (: ~) that base64-ish classes miss.
  const quoted = 'Authorization: Bearer "abc~secret"';
  const quotedOut = redactLogDetail(quoted);
  assert.match(quotedOut, /Authorization:\s*Bearer\s*\[redacted\]/i);
  assert.ok(!quotedOut.includes('abc~secret'));
  assert.ok(!quotedOut.includes('"'));

  const colon = 'proxy said Bearer abc:def then continued';
  const colonOut = redactLogDetail(colon);
  assert.match(colonOut, /Bearer \[redacted\]/);
  assert.ok(!colonOut.includes('abc:def'));

  const lone = 'proxy said Bearer sk-live-abc123xyz then continued';
  assert.match(redactLogDetail(lone), /Bearer \[redacted\]/);
  assert.ok(!redactLogDetail(lone).includes('sk-live-abc123xyz'));

  const tok = 'store 401: body token=abc123secret&x=1';
  assert.ok(redactLogDetail(tok).includes('token=[redacted]'));
  assert.ok(!redactLogDetail(tok).includes('abc123secret'));

  const long = 'x'.repeat(800);
  assert.equal(redactLogDetail(long).length, 500);
});

test('logServerError redacts HABIT_KEY material and returns an id', () => {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    // Built at runtime: a literal ?key=<token> in this file trips the secret scanner.
    const sample = 'super-secret-' + 'habit-key-value';
    const id = logServerError(new Error('boom ?' + 'key=' + sample), 'test');
    assert.match(id, /^[0-9a-f]{8}$/);
    const joined = lines.join('\n');
    assert.ok(joined.includes('[redacted]'));
    assert.ok(!joined.includes(sample));
    assert.ok(joined.includes(id));
  } finally {
    console.error = orig;
  }
});

test('logServerError redacts bearer tokens before logging', () => {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    logServerError(new Error('Redis REST failed: Authorization: Bearer sk-live-abc123xyz'), 'store');
    const joined = lines.join('\n');
    assert.match(joined, /Authorization:\s*Bearer\s*\[redacted\]/i);
    assert.ok(!joined.includes('sk-live-abc123xyz'));
  } finally {
    console.error = orig;
  }
});

test('sendServerError JSON shape keeps error field, hides sentinel', () => {
  const res = mkRes();
  const orig = console.error;
  console.error = () => {};
  try {
    sendServerError(res, new Error(SENTINEL), { label: 'unit', extra: { configured: true, entries: [] } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, CLIENT_ERROR);
    assert.equal(res.body.configured, true);
    assert.deepEqual(res.body.entries, []);
    assert.ok(!bodyHasSentinel(res));
  } finally {
    console.error = orig;
  }
});

test('sendServerError text mode returns plain Internal error', () => {
  const res = mkRes();
  const orig = console.error;
  console.error = () => {};
  try {
    sendServerError(res, new Error(SENTINEL), { label: 'unit', text: true });
    assert.equal(res.statusCode, 500);
    assert.equal(res.text, CLIENT_ERROR);
    assert.ok(!bodyHasSentinel(res));
  } finally {
    console.error = orig;
  }
});

test('api/log.js catch uses sendServerError text mode (no raw err.message)', () => {
  // Cannot import api/log.js here: it pulls @vercel/functions, absent in the
  // zero-dep unit job. Source contract + sendServerError text-mode unit cover it.
  const src = read('api/log.js');
  assert.match(src, /sendServerError\(res,\s*err,\s*\{\s*label:\s*'log',\s*text:\s*true\s*\}\)/);
  assert.doesNotMatch(src, /err\.message/);
});

async function assertHandlerHidesSentinel(name, invoke) {
  await withRedis(() => {
    throw new Error(`Redis REST failed: ${SENTINEL}`);
  }, async () => {
    const res = mkRes();
    const orig = console.error;
    console.error = () => {};
    try {
      await invoke(res);
    } finally {
      console.error = orig;
    }
    assert.equal(res.statusCode, 500, name + ' status');
    assert.ok(!bodyHasSentinel(res), name + ' leaked sentinel: ' + JSON.stringify(res.body ?? res.text));
    if (typeof res.body === 'object' && res.body) {
      assert.equal(res.body.error, CLIENT_ERROR, name + ' error field');
    } else {
      assert.equal(res.text, CLIENT_ERROR, name + ' plain text');
    }
  });
}

test('GET /api/data 500 does not echo thrown Redis message', async () => {
  await assertHandlerHidesSentinel('data', (res) =>
    dataHandler({ method: 'GET', query: {}, headers: {} }, res)
  );
  // Shape preserved: configured + empty entries alongside generic error.
  await withRedis(() => { throw new Error(SENTINEL); }, async () => {
    const res = mkRes();
    const orig = console.error;
    console.error = () => {};
    try {
      await dataHandler({ method: 'GET', query: {}, headers: {} }, res);
    } finally {
      console.error = orig;
    }
    assert.equal(res.body.configured, true);
    assert.deepEqual(res.body.entries, []);
  });
});

test('POST /api/habits 500 does not echo thrown Redis message', async () => {
  // GET swallows Redis failures into the seed fallback; the write path does not.
  await assertHandlerHidesSentinel('habits', (res) =>
    habitsHandler(
      {
        method: 'POST',
        query: {},
        headers: {},
        body: {
          habits: [{ name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' }]
        }
      },
      res
    )
  );
});

test('GET /api/roster 500 does not echo thrown Redis message', async () => {
  await assertHandlerHidesSentinel('roster', (res) =>
    rosterHandler({ method: 'GET', query: {}, headers: {} }, res)
  );
});

test('GET /api/profile 500 does not echo thrown Redis message', async () => {
  await assertHandlerHidesSentinel('profile', (res) =>
    profileHandler({ method: 'GET', query: {}, headers: {} }, res)
  );
});

test('GET /api/question 500 does not echo thrown Redis message', async () => {
  await assertHandlerHidesSentinel('question', (res) =>
    questionHandler({ method: 'GET', query: {}, headers: {} }, res)
  );
});

test('rosterPass parseError is coarse on upstream failure (no raw text)', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await withRedis(quietRedis(), async () => {
      const doc = await rosterPass({
        generate: async () => {
          throw new Error(`z.ai 500 (glm-5.2): body contains ${SENTINEL}`);
        }
      });
      assert.equal(doc.parseError, COACH_PASS_ERROR.UPSTREAM);
      assert.ok(!String(doc.parseError).includes(SENTINEL));
      assert.ok(!JSON.stringify(doc).includes(SENTINEL));
    });
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => l.includes('rosterPass')));
});

test('rosterPass parseError is parse_error on malformed model JSON', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    await withRedis(quietRedis(), async () => {
      const doc = await rosterPass({
        generate: async () => ({ text: 'here is {not: valid json at all' })
      });
      assert.equal(doc.parseError, COACH_PASS_ERROR.PARSE);
    });
  } finally {
    console.error = orig;
  }
});

test('rosterPass parseError is parse_error when extractJson finds no object', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    await withRedis(quietRedis(), async () => {
      const doc = await rosterPass({
        generate: async () => ({ text: 'sorry, no structured reply today' })
      });
      assert.equal(doc.parseError, COACH_PASS_ERROR.PARSE);
    });
  } finally {
    console.error = orig;
  }
});
