// E2E regression tests for the Stream Deck plugin (Node runtime).
//
// Spawns the real plugin entry (src/plugin.mjs) against a mock Stream Deck
// WebSocket server + mock backend, asserting the behavioral contract:
//   1. registers with the app and paints both faces from live server state
//   2. a slot swap on the server repaints the physical key on its own beat
//   3. the poll identifies itself (?deck=<version>&keys=N) for the heartbeat
//   4. a tap logs server-side (?slot=N) and rechecks catch the reactive swap
//   5. a hung poll cannot wedge the sync — the guard expires and it retries
//   6. the esbuild bundle (bin/plugin.js) passes the same boot smoke
//
// Requires: npm i @elgato/streamdeck esbuild --no-save (ws arrives as an SDK
// dep). No Chromium — that need died with the HTML runtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const SRC = fileURLToPath(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url));
const BIN = fileURLToPath(new URL(
  '../../streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js', import.meta.url));

const HABITS = [
  { name: 'Pee', emoji: '🚽', label: 'Pee' },
  { name: 'Eat', emoji: '🍽', label: 'Eat' }
];
const SLOT_A = { habit: 'Flow', emoji: '🌊', label: 'Flow', reason: 'deep work', assignedAt: 1 };
const SLOT_B = { habit: 'Walk', emoji: '🚶', label: 'Walk', reason: 'afternoon', assignedAt: 2 };

let http, httpPort;
let slots, today, pollUrls, logUrls, hangPolls;
const hung = [];

before(async () => {
  http = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/slots') {
      pollUrls.push(req.url);
      if (hangPolls > 0) { hangPolls--; hung.push(res); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, habits: HABITS, suggestedAt: 1, slots, ...(today ? { today } : {}) }));
      return;
    }
    if (url === '/api/log') {
      logUrls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => http.listen(0, r));
  httpPort = http.address().port;
});

after(() => {
  for (const res of hung) { try { res.destroy(); } catch { /* gone */ } }
  http?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, { timeout = 15_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Boot one plugin process against a fresh mock Stream Deck app.
async function boot({ entry = SRC } = {}) {
  slots = [SLOT_A, null, null, null];
  today = null;
  pollUrls = [];
  logUrls = [];
  hangPolls = 0;

  const wss = new WebSocketServer({ port: 0 });
  const wsPort = wss.address().port;
  const sent = [];            // messages the plugin sent to the "app"
  let sock = null;
  const ready = new Promise((resolve) => {
    wss.on('connection', (s) => {
      sock = s;
      s.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        sent.push(m);
        if (m.event === 'registerPlugin') resolve();
      });
    });
  });

  const info = {
    application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10.0', version: '7.5.0' },
    plugin: { uuid: 'com.shaiss.habit-tracker', version: '2.0.0' },
    devicePixelRatio: 1,
    colors: {},
    // The SDK's device store refuses action events for unknown devices, so
    // the mock must announce the device up front like the real app does.
    devices: [{ id: 'dev-1', name: 'Mock MK.2', size: { columns: 5, rows: 3 }, type: 0 }]
  };
  // The SDK reads manifest.json from the process cwd (the app launches
  // plugins from inside the .sdPlugin folder) — recreate that contract or
  // registerAction() dies silently into the SDK's file logger.
  const cwd = mkdtempSync(join(tmpdir(), 'ht-plugin-'));
  copyFileSync(fileURLToPath(new URL(
    '../../streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/manifest.json', import.meta.url)),
  join(cwd, 'manifest.json'));
  const child = spawn(process.execPath, [
    entry, '-port', String(wsPort), '-pluginUUID', 'uuid-1',
    '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)
  ], {
    cwd,                                              // SDK log files land here
    env: {
      ...process.env,
      HT_POLL_MS: '800', HT_TICK_MS: '100',
      HT_POLL_TIMEOUT_MS: '600', HT_RECHECK_MS: '150,350'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  // A failed boot must not leak the child or the wss — live handles keep the
  // test-file process alive and hang the whole runner after the ✖.
  try {
    await Promise.race([ready, sleep(10_000).then(() => { throw new Error('no registerPlugin. output:\n' + out); })]);
  } catch (err) {
    try { child.kill(); } catch { /* gone */ }
    wss.close();
    throw err;
  }

  const emit = (ev) => sock.send(JSON.stringify(ev));
  const appear = (context, actionUuid, settings) => emit({
    event: 'willAppear', action: actionUuid, context, device: 'dev-1',
    payload: { settings, coordinates: { column: 0, row: 0 }, controller: 'Keypad', isInMultiAction: false }
  });
  appear('ctx-slot-1', 'com.shaiss.habit-tracker.slot', { base: `http://127.0.0.1:${httpPort}`, slot: 1 });
  appear('ctx-habit-0', 'com.shaiss.habit-tracker.habit', { base: `http://127.0.0.1:${httpPort}`, index: 0 });

  const images = () => sent.filter((m) => m.event === 'setImage');
  const done = () => { try { child.kill(); } catch { /* gone */ } wss.close(); };
  return { child, emit, images, sent, done, output: () => out };
}

const svgOf = (m) => Buffer.from(m.payload.image.split(',')[1], 'base64').toString('utf8');

test('registers and paints both faces from live server state (SVG)', async () => {
  const p = await boot();
  try {
    await until(() => pollUrls.length >= 1, { label: 'first poll' });
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    for (const m of p.images()) {
      assert.match(m.payload.image, /^data:image\/svg\+xml;base64,/);
    }
    const faces = p.images().map(svgOf);
    assert.ok(faces.some((f) => f.includes('>Flow<')), 'slot face shows the assigned habit');
    assert.ok(faces.some((f) => f.includes('>Pee<')), 'habit face shows the live habit list');
  } finally { p.done(); }
});

test('a slot swap on the server repaints the key on its own beat', async () => {
  const p = await boot();
  try {
    await until(() => p.images().some((m) => svgOf(m).includes('>Flow<')), { label: 'initial slot face' });
    const before = p.images().length;
    slots = [SLOT_B, null, null, null];
    await until(() => p.images().length > before && svgOf(p.images().at(-1)).includes('>Walk<'),
      { label: 'repaint after swap' });
  } finally { p.done(); }
});

test('the poll identifies itself so the backend can report live hardware', async () => {
  const p = await boot();
  try {
    await until(() => pollUrls.length >= 1, { label: 'first poll' });
    for (const u of pollUrls) {
      assert.match(u, /[?&]deck=\d+\.\d+\.\d+/, 'every poll carries ?deck=<version>');
      assert.match(u, /[?&]keys=\d+\b/, 'every poll reports live key count');
      assert.match(u, /[?&]tz=-?\d+\b/, 'every poll carries the host timezone for day bucketing (#32)');
    }
    await until(() => pollUrls.some((u) => /[?&]keys=2\b/.test(u)), { label: 'a poll reporting 2 keys' });
  } finally { p.done(); }
});

test('a tap logs server-side and rechecks catch the reactive swap', async () => {
  const p = await boot();
  try {
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    const polls = pollUrls.length;
    p.emit({
      event: 'keyDown', action: 'com.shaiss.habit-tracker.slot', context: 'ctx-slot-1', device: 'dev-1',
      payload: { settings: {}, coordinates: { column: 0, row: 0 } }
    });
    await until(() => logUrls.length === 1, { label: 'the tap to log' });
    assert.match(logUrls[0], /[?&]slot=1\b/, 'slot taps resolve server-side');
    await until(() => pollUrls.length > polls + 1, { label: 'post-tap rechecks' });
    await until(() => p.sent.some((m) => m.event === 'showOk'), { label: 'tap acknowledged on the key' });
  } finally { p.done(); }
});

test('a hung poll cannot wedge the sync — the guard expires and it retries', async () => {
  const p = await boot();
  try {
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    const before = pollUrls.length;
    hangPolls = 1;
    p.emit({ event: 'deviceDidConnect', device: 'dev-1', deviceInfo: { name: 'Mock', type: 0, size: { columns: 5, rows: 3 } } });
    await until(() => pollUrls.length === before + 1, { label: 'the hung poll to start' });
    slots = [SLOT_B, null, null, null];
    await until(() => pollUrls.length > before + 1, { label: 'a retry after expiry', timeout: 20_000 });
    await until(() => p.images().length > 0 && svgOf(p.images().at(-1)).includes('>Walk<'),
      { label: 'the swap to repaint' });
  } finally { p.done(); }
});

test('living key faces: today state paints habit keys and repaints on change (#32)', async () => {
  const p = await boot();
  try {
    // First paint has no today map — a plain habit face, no ring arc.
    await until(() => p.images().some((m) => svgOf(m).includes('>Pee<')), { label: 'initial habit face' });
    assert.ok(!p.images().map(svgOf).some((f) => f.includes('>Pee<') && f.includes('stroke-dasharray')),
      'no today state, no ring arc');
    // The server starts reporting progress — the key grows a ring + dots on
    // its own poll beat, no tap needed.
    today = { Pee: { count: 1, goal: 3, doneToday: false, streak: 2, ringFill: 1 / 3 } };
    await until(() => p.images().some((m) => {
      const f = svgOf(m);
      return f.includes('>Pee<') && f.includes('stroke-dasharray');
    }), { label: 'ring arc after today arrives' });
    const ringed = p.images().map(svgOf).filter((f) => f.includes('>Pee<') && f.includes('stroke-dasharray')).at(-1);
    assert.equal((ringed.match(/r="2\.6"/g) || []).length, 3, 'goal of 3 renders 3 count dots');
    assert.ok(!ringed.includes('>✓<'), 'not done yet — no check');
    // Goal met → dim + ✓, again purely from the poll.
    today = { Pee: { count: 3, goal: 3, doneToday: true, streak: 3, ringFill: 1 } };
    await until(() => p.images().some((m) => {
      const f = svgOf(m);
      return f.includes('>Pee<') && f.includes('>✓<');
    }), { label: 'done repaint with the check' });
  } finally { p.done(); }
});

test('the esbuild bundle boots and paints (packaging smoke)', async () => {
  const { bundlePlugin } = await import('../../tools/bundle-plugin.mjs');
  await bundlePlugin();
  const p = await boot({ entry: BIN });
  try {
    await until(() => p.images().length >= 2, { label: 'bundle paints faces' });
  } finally { p.done(); }
});
