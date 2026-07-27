// E2E regression tests for the hardware-liveness line on the dashboard.
//
// Issue #5's hardest part was not knowing *where* the break was: the virtual
// deck updated, the physical one didn't, and nothing told you whether the
// plugin was even talking to the backend. The plugin now tags its poll
// (`?deck=<version>`), the server records it, and the dashboard reports it — so
// "the coach isn't swapping" is distinguishable from "no deck ever asked".
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
let deck = null; // whatever /api/slots?track=1 should report

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, entries: [{ h: 'Drink', t: Date.now() - 3600_000, e: '💧' }] }));
      return;
    }
    if (url === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: true, aiReady: true, model: 'glm-5.2', suggestedAt: Date.now(),
        habits: [{ name: 'Drink', emoji: '💧', label: 'Drink' }],
        slots: [null, null, null, null],
        deck
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

const line = async () => {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#deckline');
  return {
    text: await page.$eval('#deckline', (e) => e.textContent),
    live: await page.$eval('#deckline', (e) => e.dataset.live)
  };
};

test('no deck has ever polled -> says so, and points at the plugin', async () => {
  deck = null;
  const { text, live } = await line();
  assert.match(text, /Physical deck:\s*never seen/);
  assert.match(text, /Install the plugin \+ profile/);
  assert.equal(live, '0');
});

test('a recent poll reads as live, with plugin version and key count', async () => {
  deck = { at: Date.now() - 4000, plugin: '1.6.0', keys: 10 };
  const { text, live } = await line();
  assert.match(text, /Physical deck:\s*live/);
  assert.match(text, /plugin 1\.6\.0/);
  assert.match(text, /10 keys/);
  assert.match(text, /last poll \d+s ago/);
  assert.equal(live, '1');
});

test('a deck that stopped polling reads as stale, not live', async () => {
  deck = { at: Date.now() - 7 * 60_000, plugin: '1.6.0', keys: 10 };
  const { text, live } = await line();
  assert.match(text, /Physical deck:\s*stale/);
  assert.match(text, /last poll 7m ago/);
  assert.equal(live, '0');
});

// `plugin` reaches Redis from a query string, so it must be treated as hostile
// at render time regardless of what the write path allows through. The payload
// below is exactly 20 chars — it fits the server's truncation, so the length cap
// is not a defense.
test('a markup payload in plugin renders as text, never as an element', async () => {
  deck = { at: Date.now() - 2000, plugin: '<svg onload=alert()>', keys: 1 };
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#deckline');
  assert.equal(await page.$$eval('#deckline svg', (els) => els.length), 0, 'markup must not become a node');
  assert.match(await page.$eval('#deckline', (e) => e.textContent), /<svg onload=alert\(\)>/);
});

test('a non-numeric key count is coerced, not interpolated', async () => {
  deck = { at: Date.now() - 2000, plugin: '1.6.0', keys: '<b>oops</b>' };
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#deckline');
  assert.equal(await page.$$eval('#deckline b', (els) => els.length), 1, 'only the live/stale <b> belongs here');
  assert.match(await page.$eval('#deckline', (e) => e.textContent), /·\s*0 keys/);
});
