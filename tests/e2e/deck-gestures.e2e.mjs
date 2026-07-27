// E2E regression tests for the virtual deck's gesture parity (issue #33).
//
// The virtual deck is a preview of the physical one, so a key there has to
// mean the same three things: tap logs, hold undoes, double-tap says "big".
// The plugin's own resolver is covered in plugin.e2e.mjs; this pins the
// browser copy in public/deck.html, which cannot import it (no build step).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;
let calls = [];        // every /api/log request, as "METHOD url"
let logStatus = 200;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/log') {
      calls.push(req.method + ' ' + req.url);
      res.writeHead(logStatus, { 'Content-Type': 'text/plain' });
      res.end(logStatus === 200 ? 'Logged: Drink' : 'Nothing to undo');
      return;
    }
    if (url === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: true, aiReady: true, suggestedAt: Date.now(),
        habits: [{ name: 'Drink', emoji: '💧', label: 'Drink' }],
        slots: [{ habit: 'Flow', emoji: '🌊', label: 'Flow', assignedAt: 1 }, null, null, null],
        today: {}
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

// Fresh page per test: gesture state lives on the DOM nodes.
async function open() {
  calls = [];
  logStatus = 200;
  await page.goto(`http://127.0.0.1:${port}/deck.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.k[data-habit="0"]');
  return page.locator('.k[data-habit="0"]');
}

// The tap path defers by DOUBLE_TAP_MS, so every assertion has to outwait it.
const settle = () => page.waitForTimeout(500);

test('a tap logs the habit as a plain GET', async () => {
  const key = await open();
  await key.click();
  await settle();
  assert.equal(calls.length, 1, 'exactly one request');
  assert.match(calls[0], /^GET \/api\/log\?hkey=1/);
  assert.doesNotMatch(calls[0], /intensity=/, 'a plain tap carries no intensity');
});

test('a hold undoes with DELETE and does not also log the release', async () => {
  const key = await open();
  await key.click({ delay: 700 });   // held past LONG_PRESS_MS
  await settle();
  assert.equal(calls.length, 1, 'the release after a hold must not log');
  assert.match(calls[0], /^DELETE \/api\/log\?hkey=1/);
});

test('a double tap logs once with intensity=high', async () => {
  const key = await open();
  await key.click();
  await page.waitForTimeout(60);     // inside DOUBLE_TAP_MS
  await key.click();
  await settle();
  assert.equal(calls.length, 1, 'a double tap is ONE log, not two');
  assert.match(calls[0], /intensity=high/);
});

test('AI slot keys carry the same three gestures', async () => {
  await open();
  const slot = page.locator('.k[data-slot="1"]');
  await slot.click({ delay: 700 });
  await settle();
  assert.match(calls[0], /^DELETE \/api\/log\?slot=1/);
});

test('nothing to undo surfaces the server message instead of a silent no-op', async () => {
  const key = await open();
  logStatus = 404;
  await key.click({ delay: 700 });
  await settle();
  assert.match(await page.$eval('#hint', (e) => e.textContent), /Nothing to undo/);
});

test('the Stats key still opens the dashboard on a plain tap', async () => {
  await open();
  // It registers no double-tap handler, so it must fire immediately on
  // release — the snappiness that the registration model exists to preserve.
  const popup = page.waitForEvent('popup', { timeout: 5000 });
  await page.locator('.k[title*="Stats"]').click();
  const p = await popup;
  assert.match(p.url(), /\/$/);
  await p.close();
});
