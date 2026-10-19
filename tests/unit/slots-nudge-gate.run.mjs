// Child process for tests/unit/slots-nudge-gate.test.mjs.
// Stubs Redis, the coach, and @vercel/functions, then invokes the real
// GET /api/slots handler. Prints one JSON document to stdout. Never prints
// env values.
import { register } from 'node:module';
import { io, resetIo } from './slots-nudge-stubs/io-log.mjs';

register('./slots-nudge-gate.hooks.mjs', import.meta.url);

const SECRET = 'unit-test-habit-key';

for (const k of Object.keys(process.env)) {
  if (/(HABIT_KEY|ZAI|GLM|ZHIPU|API_KEY|TOKEN|SECRET|REDIS|UPSTASH|^KV_)/i.test(k)) {
    delete process.env[k];
  }
}
process.env.ZAI_API_KEY = 'unit-test-zai';

globalThis.fetch = async (url) => {
  io.fetches.push(String(url).slice(0, 40));
  throw new Error('network forbidden');
};

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const { flushWaits } = await import('@vercel/functions');
const { default: handler } = await import('../../api/slots.js');

async function once(label, headers, secretSet) {
  if (secretSet) process.env.HABIT_KEY = SECRET;
  else delete process.env.HABIT_KEY;
  resetIo();
  const req = {
    method: 'GET',
    query: { deck: '1.0.0', keys: '4', tz: '0' },
    headers
  };
  const res = mockRes();
  await handler(req, res);
  await flushWaits();
  return {
    label,
    status: res.statusCode,
    slotCount: Array.isArray(res.body && res.body.slots) ? res.body.slots.length : -1,
    reads: io.reads.slice(),
    writes: io.writes.slice(),
    nudges: io.nudges.slice(),
    fetches: io.fetches.slice()
  };
}

const results = [
  await once('unkeyed', {}, true),
  await once('wrong-key', { 'x-habit-key': 'wrong-unit-test-habit-key' }, true),
  await once('keyed', { 'x-habit-key': SECRET }, true),
  await once('unset-secret', {}, false)
];
process.stdout.write(JSON.stringify(results) + '\n');
