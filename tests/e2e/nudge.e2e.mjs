// E2E regression tests for proactive-nudge rendering: the dashboard slot card
// still tags a nudge, and the virtual deck key face keeps identity on the
// interior with a wait frame (❗ badge), while plain suggestions stay violet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// fileURLToPath, not .pathname: on Windows the latter yields "/C:/..." and
// every existsSync below silently 404s.
const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;

const SLOTS = [
  { habit: 'Stretch', emoji: '🧘', label: 'Stretch', reason: 'usually by 9am', assignedAt: Date.now() - 3600_000 },
  { habit: 'Drink', emoji: '💧', label: 'Water?', reason: 'no water logged yet today — you usually have 3 by now', assignedAt: Date.now(), expiresAt: Date.now() + 3600_000, nudge: true },
  null,
  null
];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, entries: [{ h: 'Drink', t: Date.now() - 86400_000, e: '💧' }] }));
      return;
    }
    if (url === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: true, aiReady: true, model: 'glm-5.2', suggestedAt: Date.now(),
        habits: [{ name: 'Drink', emoji: '💧', label: 'Drink' }],
        slots: SLOTS
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

test('dashboard marks the nudge slot amber with an ❗ NUDGE tag, suggestions stay plain', async () => {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.slot.nudge');
  assert.match(await page.$eval('.slot.nudge .tag', (e) => e.textContent), /❗ NUDGE · logs as Drink/);
  const plain = await page.$eval('.slot:not(.nudge):not(.empty) .tag', (e) => e.textContent);
  assert.match(plain, /SLOT 1/);
  assert.doesNotMatch(plain, /NUDGE/);
});

test('virtual deck renders the nudge key with identity interior, wait frame, and ❗ badge', async () => {
  await page.goto(`http://127.0.0.1:${port}/deck.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.nudgeface .frame-wait');
  assert.match(await page.$eval('.nudgeface .badge', (e) => e.textContent), /❗ 2/);
  assert.match(await page.$eval('.nudgeface .lb', (e) => e.textContent), /Water\?/);
  assert.ok(await page.$eval('.nudgeface', (e) => e.style.getPropertyValue('--hue')),
    'nudge interior uses the habit identity hue, not amber');
  // slot 1 is a plain suggestion — still the violet slotface, no wait frame
  assert.match(await page.$eval('.k[data-slot="1"] .facecss', (e) => e.className), /slotface/);
  assert.equal(await page.locator('.k[data-slot="1"] .frame-wait').count(), 0,
    'a violet suggestion owes no press, so no wait frame');
});
