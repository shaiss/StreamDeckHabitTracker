// E2E regression tests for the habit manager, against a self-contained mock.
// Requires: npm i playwright-core --no-save, and Chromium at CHROME_PATH or
// the repo default (/opt/pw-browsers/chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('../../public', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;
const posted = [];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/habits' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        posted.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, habits: JSON.parse(body).habits }));
      });
      return;
    }
    if (url === '/api/habits') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        habits: [{ name: 'Pee', emoji: '🚽', label: 'Pee', origin: 'human' }],
        coachHabits: [{ habit: 'Awake', emoji: '☀️', label: 'Awake', active: true, offered: 4, landed: 1, taps: 1 }]
      }));
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

test('double-tapping Promote adds exactly one row and disables the button', async () => {
  await page.goto(`http://127.0.0.1:${port}/habits.html`, { waitUntil: 'networkidle' });
  await page.click('.promote');
  await page.click('.promote', { force: true }).catch(() => {}); // second tap: disabled
  const rows = await page.$$eval('.hrow .name', (els) => els.map((e) => e.value));
  assert.deepEqual(rows.filter((n) => n === 'Awake').length, 1, rows.join(','));
  assert.equal(await page.$eval('.promote', (b) => b.disabled), true);
});

test('promoted row carries coach origin and Save posts a deduped list', async () => {
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'));
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
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('appears twice'));
  assert.equal(posted.length, before2, 'no POST should have been made');
});
