// E2E regression tests for the habit manager, against a self-contained mock.
// The mock is stateful and runs the REAL roster decision logic (lib/roster.js)
// behind /api/roster, so these tests cover the wiring between the two rather
// than a hand-written stub of it.
// Requires: npm i playwright-core --no-save, and Chromium at CHROME_PATH or
// the repo default (/opt/pw-browsers/chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { sanitizeProposals, applyDecision, restoreFromArchive, normalizeRoster } from '../../lib/roster.js';
import {
  sanitizeTargetChanges,
  applyTargetDecision,
  normalizeTargets,
  applyAutoChanges
} from '../../lib/target.js';

// fileURLToPath, not .pathname: on Windows the latter yields "/C:/..." and
// every existsSync below silently 404s.
const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;
const posted = [];
// When set, /api/targets POST requires matching x-habit-key (#111).
let requiredTargetsKey = null;
// Dialog policy for window.prompt HABIT_KEY asks (mutable per test).
let dialogMode = 'dismiss'; // 'dismiss' | 'accept'
let dialogAcceptValue = 'test-habit-key-111-dummy';

let habits = [
  { name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' },
  { name: 'Caffeine', emoji: '☕', label: 'Caffeine', origin: 'human', goal: 5 },
  { name: 'Exercise', emoji: '🏃', label: 'Exercise', origin: 'human', goal: 1 }
];
const COACH_INVENTIONS = [{ habit: 'Awake', emoji: '☀️', label: 'Awake', active: true, offered: 4, landed: 1, taps: 1 }];
let roster = normalizeRoster({
  proposals: sanitizeProposals(
    [
      { kind: 'add', name: 'Stretch', emoji: '🧘', label: 'Stretch', reason: 'you log Sit for six hours straight' },
      { kind: 'retire', name: 'Pee', reason: 'you have never once tapped it' },
      { kind: 'add', name: 'Journal', emoji: '📓', label: 'Journal', reason: 'a hunch' }
    ],
    { habits }
  )
});
// Seed one queued ramp-up (Exercise 1→2). Auto-downs are applied server-side
// on the coach pass — the manager only decides ups.
let targets = (() => {
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Exercise', to: 2, reason: 'you hit 2 six of the last ten days' }],
    { habits, now: 1000 }
  );
  return normalizeTargets({ proposals: queue });
})();

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req, cb) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => cb(JSON.parse(b || '{}')));
};
const rosterView = () => ({ proposals: roster.proposals, archive: roster.archive, lastRunAt: roster.lastRunAt });

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/habits' && req.method === 'POST') {
      readBody(req, (body) => {
        posted.push(body);
        habits = body.habits;
        json(res, 200, { ok: true, habits });
      });
      return;
    }
    if (url === '/api/habits') {
      const fixed = new Set(habits.map((h) => h.name.toLowerCase()));
      json(res, 200, { habits, coachHabits: COACH_INVENTIONS.filter((c) => !fixed.has(c.habit.toLowerCase())) });
      return;
    }
    if (url === '/api/roster' && req.method === 'POST') {
      readBody(req, (body) => {
        const r = body.restore
          ? restoreFromArchive({ habits, roster, name: String(body.restore) })
          : applyDecision({ habits, roster, id: String(body.id || ''), decision: String(body.decision || '') });
        if (r.error) return json(res, 400, { error: r.error });
        habits = r.habits;
        roster = r.roster;
        json(res, 200, { ok: true, applied: r.applied, habits, ...rosterView() });
      });
      return;
    }
    if (url === '/api/roster') {
      json(res, 200, rosterView());
      return;
    }
    if (url === '/api/targets' && req.method === 'POST') {
      readBody(req, (body) => {
        if (requiredTargetsKey) {
          const hdr = req.headers['x-habit-key'];
          const got = Array.isArray(hdr) ? hdr[0] : hdr;
          if (got !== requiredTargetsKey) {
            return json(res, 401, { error: 'Unauthorized' });
          }
        }
        const r = applyTargetDecision({
          habits,
          targets,
          id: String(body.id || ''),
          decision: String(body.decision || '')
        });
        if (r.error) return json(res, 400, { error: r.error });
        habits = r.habits;
        targets = r.targets;
        json(res, 200, {
          ok: true,
          applied: r.applied,
          habits,
          proposals: targets.proposals,
          history: targets.history
        });
      });
      return;
    }
    if (url === '/api/targets') {
      json(res, 200, {
        proposals: targets.proposals,
        history: targets.history,
        lastRunAt: targets.lastRunAt
      });
      return;
    }
    const p = join(ROOT, url === '/' ? 'index.html' : url);
    if (existsSync(p)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(readFileSync(p));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const exe = process.env.CHROME_PATH ||
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  page = await browser.newPage();
  // Default: dismiss HABIT_KEY prompts so unkeyed flows keep working (#111).
  page.on('dialog', async (d) => {
    if (dialogMode === 'accept') await d.accept(dialogAcceptValue);
    else await d.dismiss();
  });
});

after(async () => { await browser?.close(); server?.close(); });

const names = () => page.$$eval('.hrow .name', (els) => els.map((e) => e.value));
const settled = (needle) =>
  page.waitForFunction((n) => document.getElementById('status').textContent.includes(n), needle);

test('double-tapping Promote adds exactly one row and disables the button', async () => {
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.click('.promote');
  await page.click('.promote', { force: true }).catch(() => {}); // second tap: disabled
  const rows = await names();
  assert.deepEqual(rows.filter((n) => n === 'Awake').length, 1, rows.join(','));
  assert.equal(await page.$eval('.promote', (b) => b.disabled), true);
});

test('promoted row carries coach origin and Save posts a deduped list', async () => {
  await page.click('#saveBtn');
  await settled('Saved');
  const body = posted.at(-1);
  const awake = body.habits.filter((h) => h.name === 'Awake');
  assert.equal(awake.length, 1);
  assert.equal(awake[0].origin, 'coach');
});

test('a hand-added duplicate is blocked client-side before POST', async () => {
  const before2 = posted.length;
  await page.click('#addBtn');
  await page.fill('.hrow[data-new="1"]:last-child .emoji', '🚽');
  await page.fill('.hrow[data-new="1"]:last-child .label', 'Pee2');
  await page.fill('.hrow[data-new="1"]:last-child .name', 'pee'); // dup of Pee, case-insensitive
  await page.click('#saveBtn');
  await settled('appears twice');
  assert.equal(posted.length, before2, 'no POST should have been made');
});

test('the coach’s roster proposals render with their reason and both choices', async () => {
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  assert.equal(await page.$eval('#propSect', (s) => s.hidden), false);
  // Scope to #propRows — target raise cards also use .prow (in #targetPropRows).
  assert.equal((await page.$$('#propRows .prow')).length, 3);
  const retire = await page.$eval('.decide[data-name="Pee"][data-decision="approve"]', (b) => b.textContent);
  assert.match(retire, /Retire it/, 'a retirement must not read like an add');
  assert.match(await page.$eval('.prow .why', (e) => e.textContent), /six hours/);
});

test('approving an add lands it as a fixed key with coach origin', async () => {
  await page.click('.decide[data-name="Stretch"][data-decision="approve"]');
  await settled('fixed key now');
  assert.ok((await names()).includes('Stretch'));
  assert.equal(
    await page.$$eval('.hrow', (els) => els.find((e) => e.querySelector('.name').value === 'Stretch').dataset.origin),
    'coach'
  );
  assert.equal((await page.$$('.decide[data-name="Stretch"]')).length, 0, 'the decided proposal is gone');
});

test('dismissing a proposal drops it without touching the roster', async () => {
  const before2 = await names();
  await page.click('.decide[data-name="Journal"][data-decision="dismiss"]');
  await settled('won’t ask about Journal again');
  assert.deepEqual(await names(), before2);
  assert.deepEqual(roster.rejected, ['add:journal'], 'the refusal is remembered for the next pass');
});

test('approving a retire takes two deliberate presses and archives the key', async () => {
  const pee = page.locator('.decide[data-name="Pee"][data-decision="approve"]');
  await pee.click();
  await page.waitForFunction(() => {
    const b = document.querySelector('.decide[data-name="Pee"][data-decision="approve"]');
    return b && b.textContent.includes('CONFIRM?');
  });
  assert.ok((await names()).includes('Pee'), 'press 1 must not retire');
  await pee.click();
  await settled('retired');
  assert.equal((await names()).includes('Pee'), false);
  assert.equal(await page.$eval('#archSect', (s) => s.hidden), false);
  assert.equal(await page.$eval('.arow .nm', (e) => e.textContent), 'Pee');
  assert.equal(await page.$eval('#propSect', (s) => s.hidden), true, 'no proposals left');

  await page.click('.restore[data-name="Pee"]');
  await settled('back on your roster');
  assert.ok((await names()).includes('Pee'));
  assert.equal(await page.$eval('#archSect', (s) => s.hidden), true);
});

test('a per-habit daily goal round-trips through the manager (living key faces #32)', async () => {
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hrow');
  // Fill the goal on the Pee row (robust to its position after prior tests
  // mutate the shared list). Playwright's locator filter scopes to the row
  // whose name input holds "Pee".
  const peeGoal = page.locator('.hrow').filter({ has: page.locator('.name[value="Pee"]') }).locator('.goal');
  await peeGoal.fill('8');
  await page.click('#saveBtn');
  await settled('Saved');
  // The POST must have carried goal:8 for that habit.
  const body = posted.at(-1);
  const target = body.habits.find((h) => h.name === 'Pee');
  assert.ok(target, 'Pee must be in the saved list');
  assert.equal(target.goal, 8, 'POST payload must include goal:8');
  // Reload and confirm the input re-hydrates from the persisted value.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.hrow');
  const goalVal = await page.$$eval('.hrow', (rows) => {
    const r = rows.find((rr) => rr.querySelector('.name')?.value === 'Pee');
    return r?.querySelector('.goal')?.value;
  });
  assert.equal(goalVal, '8', 'goal input must rehydrate to 8 after reload');
});

test('removing a habit row takes two deliberate presses (#78)', async () => {
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hrow');
  const before = await names();
  assert.ok(before.length >= 1);
  const del = page.locator('.hrow').filter({ has: page.locator(`.name[value="${before[0]}"]`) }).locator('.del');
  await del.click();
  assert.deepEqual(await names(), before, 'press 1 must not drop the row');
  assert.match(await del.textContent(), /CONFIRM\?/);
  await del.click();
  assert.equal((await names()).includes(before[0]), false);
});

test('target ramp-up proposals render with reason and both choices (#70)', async () => {
  // Re-seed a pending raise after earlier tests may have decided it.
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Exercise', to: 2, reason: 'you hit 2 six of the last ten days' }],
    { habits, now: Date.now() }
  );
  // If Exercise was retired/removed, put it back for this surface test.
  if (!habits.some((h) => h.name === 'Exercise')) {
    habits = [...habits, { name: 'Exercise', emoji: '🏃', label: 'Exercise', origin: 'human', goal: 1 }];
  } else {
    const idx = habits.findIndex((h) => h.name === 'Exercise');
    habits[idx] = { ...habits[idx], goal: 1 };
  }
  targets = normalizeTargets({ proposals: queue });
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  assert.equal(await page.$eval('#targetPropSect', (s) => s.hidden), false);
  assert.equal((await page.$$('.tprow')).length, 1);
  assert.match(await page.$eval('.tprow .why', (e) => e.textContent), /six of the last ten/);
  assert.match(
    await page.$eval('.tdecide[data-decision="approve"]', (b) => b.textContent),
    /Raise it/
  );
});

test('approving a target raise updates the habit goal with coach setBy (#70)', async () => {
  await page.click('.tdecide[data-name="Exercise"][data-decision="approve"]');
  await settled('Raised Exercise');
  const ex = habits.find((h) => h.name === 'Exercise');
  assert.ok(ex);
  assert.equal(typeof ex.goal, 'object');
  assert.equal(ex.goal.target, 2);
  assert.equal(ex.goal.setBy, 'coach');
  assert.equal((await page.$$('.tdecide[data-name="Exercise"]')).length, 0);
  // Reason surfaces on the habit row.
  assert.match(
    await page.$eval('.hrow[data-goal-setby="coach"] .goal-meta', (e) => e.textContent),
    /coach/
  );
});

test('dismissing a target raise remembers the refusal without changing the goal (#70)', async () => {
  // Queue a fresh raise for Caffeine (or re-add the habit if earlier deletes removed it).
  if (!habits.some((h) => h.name === 'Caffeine')) {
    habits = [...habits, { name: 'Caffeine', emoji: '☕', label: 'Caffeine', origin: 'human', goal: 5 }];
  }
  const caf = habits.find((h) => h.name === 'Caffeine');
  caf.goal = 5;
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Caffeine', to: 6, reason: 'ramping gently' }],
    { habits, now: Date.now() }
  );
  targets = normalizeTargets({ proposals: queue, rejected: targets.rejected });
  const beforeGoal = habits.find((h) => h.name === 'Caffeine').goal;
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.click('.tdecide[data-name="Caffeine"][data-decision="dismiss"]');
  await settled('won’t ask to raise Caffeine');
  assert.equal(habits.find((h) => h.name === 'Caffeine').goal, beforeGoal);
  assert.ok(targets.rejected.includes('caffeine:6'));
  // A re-sanitize with the same raise must not re-queue.
  const again = sanitizeTargetChanges(
    [{ name: 'Caffeine', to: 6, reason: 'ramping gently' }],
    { habits, rejected: targets.rejected, now: Date.now() + 1 }
  );
  assert.equal(again.queue.length, 0);
});

test('auto-down applies with reason and never touches the tap log shape (#70)', () => {
  // Pure wiring check (no browser): the same helpers the API uses auto-apply
  // a down without requiring a human click, and leave other fields alone.
  const before = [
    { name: 'Caffeine', emoji: '☕', label: 'Caffeine', goal: 5 },
    { name: 'Exercise', emoji: '🏃', label: 'Exercise', goal: 1 }
  ];
  const { auto } = sanitizeTargetChanges(
    [{ name: 'Caffeine', to: 3, reason: 'well over target all week' }],
    { habits: before, now: 42 }
  );
  const { habits: after, applied } = applyAutoChanges({
    habits: before,
    targets: null,
    changes: auto,
    now: 42
  });
  assert.equal(applied.length, 1);
  assert.equal(after[0].goal.target, 4); // step-clamped from 5
  assert.equal(after[0].goal.setBy, 'coach');
  assert.match(after[0].goal.reason, /well over/);
  assert.equal(after[1].goal, 1);
});

test('targets decide with correct x-habit-key succeeds when key required (#111)', async () => {
  const DUMMY = 'test-habit-key-111-dummy';
  requiredTargetsKey = DUMMY;
  dialogMode = 'accept';
  dialogAcceptValue = DUMMY;
  if (!habits.some((h) => h.name === 'Exercise')) {
    habits = [...habits, { name: 'Exercise', emoji: '🏃', label: 'Exercise', origin: 'human', goal: 1 }];
  } else {
    const idx = habits.findIndex((h) => h.name === 'Exercise');
    habits[idx] = { ...habits[idx], goal: 1 };
  }
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Exercise', to: 2, reason: 'keyed raise for #111' }],
    { habits, now: Date.now() }
  );
  targets = normalizeTargets({ proposals: queue });
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.click('.tdecide[data-name="Exercise"][data-decision="approve"]');
  await settled('Raised Exercise');
  assert.equal(habits.find((h) => h.name === 'Exercise').goal.target, 2);
  requiredTargetsKey = null;
  dialogMode = 'dismiss';
});

test('targets decide without/wrong key gets Unauthorized (#111)', async () => {
  const DUMMY = 'test-habit-key-111-dummy';
  requiredTargetsKey = DUMMY;
  // Dismiss first prompt (no key sent) → 401 → accept with wrong key → still 401.
  let prompts = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', async (d) => {
    prompts += 1;
    if (prompts === 1) await d.dismiss();
    else await d.accept('wrong-key-not-secret');
  });
  if (!habits.some((h) => h.name === 'Caffeine')) {
    habits = [...habits, { name: 'Caffeine', emoji: '☕', label: 'Caffeine', origin: 'human', goal: 5 }];
  }
  const caf = habits.find((h) => h.name === 'Caffeine');
  caf.goal = 5;
  const beforeGoal = caf.goal;
  const { queue } = sanitizeTargetChanges(
    [{ name: 'Caffeine', to: 6, reason: 'auth failure path' }],
    { habits, now: Date.now() }
  );
  targets = normalizeTargets({ proposals: queue });
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.click('.tdecide[data-name="Caffeine"][data-decision="dismiss"]');
  await settled('Unauthorized');
  assert.equal(habits.find((h) => h.name === 'Caffeine').goal, beforeGoal);
  assert.equal((await page.$$('.tdecide[data-name="Caffeine"]')).length, 1, 'proposal stays pending');
  // Restore default dialog handler for any later tests.
  page.removeAllListeners('dialog');
  page.on('dialog', async (d) => {
    if (dialogMode === 'accept') await d.accept(dialogAcceptValue);
    else await d.dismiss();
  });
  requiredTargetsKey = null;
  dialogMode = 'dismiss';
  assert.ok(prompts >= 1, 'user must be prompted for the key');
});
