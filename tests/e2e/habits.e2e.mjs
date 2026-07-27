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

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;
const posted = [];

let habits = [{ name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' }];
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
  assert.equal((await page.$$('.prow')).length, 3);
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

test('approving a retire archives the key and Restore brings it back', async () => {
  await page.click('.decide[data-name="Pee"][data-decision="approve"]');
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
