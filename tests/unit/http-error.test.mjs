// Issue #128: client-facing errors must never echo raw exception text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_ERROR,
  COACH_PASS_ERROR,
  classifyCoachPassError,
  logServerError,
  sendServerError
} from '../../lib/http-error.js';
import dataHandler from '../../api/data.js';
import habitsHandler from '../../api/habits.js';
import rosterHandler from '../../api/roster.js';
import logHandler from '../../api/log.js';
import profileHandler from '../../api/profile.js';
import questionHandler from '../../api/question.js';

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
  const upstream = new Error(`z.ai 503 (glm-5.2): ${SENTINEL}`);
  const code = classifyCoachPassError(upstream);
  assert.equal(code, COACH_PASS_ERROR.UPSTREAM);
  assert.ok(!code.includes(SENTINEL));
  assert.ok(!String(code).includes('z.ai'));
  assert.ok(!String(code).includes('glm'));
});

test('logServerError redacts HABIT_KEY material and returns an id', () => {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    const id = logServerError(new Error('boom ?key=super-secret-habit-key-value'), 'test');
    assert.match(id, /^[0-9a-f]{8}$/);
    const joined = lines.join('\n');
    assert.ok(joined.includes('[redacted]'));
    assert.ok(!joined.includes('super-secret-habit-key-value'));
    assert.ok(joined.includes(id));
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

test('GET /api/log 500 does not echo thrown Redis message (plain text)', async () => {
  await assertHandlerHidesSentinel('log', (res) =>
    logHandler({ method: 'GET', query: { habit: 'Pee' }, headers: {} }, res)
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

test('roster parseError classification is what clients would see (no raw text)', () => {
  // Mirrors lib/coach.js rosterPass catch: log + classify, never slice(err.message).
  const err = new Error(`z.ai 500 (glm-5.2): body contains ${SENTINEL}`);
  const logged = [];
  const orig = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  let parseError;
  try {
    logServerError(err, 'rosterPass');
    parseError = classifyCoachPassError(err);
  } finally {
    console.error = orig;
  }
  assert.equal(parseError, COACH_PASS_ERROR.UPSTREAM);
  assert.ok(!String(parseError).includes(SENTINEL));
  assert.ok(logged.some((l) => l.includes('rosterPass')));
  assert.ok(logged.some((l) => l.includes('z.ai') || l.includes(SENTINEL)));
});
