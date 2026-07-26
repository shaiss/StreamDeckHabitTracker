// E2E regression tests for the "Tell the coach" natural-language logging box
// on the dashboard, against a self-contained mock. Requires playwright-core +
// Chromium (CHROME_PATH or /opt/pw-browsers/chromium), same as habits.e2e.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('../../public', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

let server, browser, page, port;
const nlPosts = []; // every POST /api/nl body, in order

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/nl' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const j = JSON.parse(body);
        nlPosts.push(j);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (j.entries) {
          res.end(JSON.stringify({ ok: true, logged: j.entries }));
        } else {
          const now = Date.now();
          res.end(JSON.stringify({
            entries: [
              { h: 'Drink', t: now - 2 * 3600_000, note: 'big glass', e: '💧', nl: 1 },
              { h: 'Exercise', t: now, note: '20 min walk', e: '🏃', nl: 1 }
            ],
            unmatched: ['haircut'],
            reply: 'Nice — hydration and a walk.'
          }));
        }
      });
      return;
    }
    if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, entries: [{ h: 'Drink', t: Date.now(), note: '', e: '💧', nl: 1 }] }));
      return;
    }
    if (url === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slots: [null, null, null, null], aiReady: true, model: '' }));
      return;
    }
    if (url === '/api/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: '', tz: '', about: '' }));
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

test('empty input never POSTs', async () => {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.click('#nlGo');
  await page.waitForTimeout(200);
  assert.equal(nlPosts.length, 0);
});

test('submitting text renders the proposal without writing anything', async () => {
  await page.fill('#nlText', 'drank a big glass 2h ago, walked 20 min, got a haircut');
  await page.click('#nlGo');
  await page.waitForSelector('#nlConfirm');
  assert.equal(nlPosts.length, 1, 'exactly one parse POST');
  assert.equal(nlPosts[0].text.includes('haircut'), true);
  assert.equal(nlPosts[0].entries, undefined, 'parse call must not carry entries');
  const chips = await page.$$eval('.nl-chip', (els) => els.map((e) => e.textContent));
  assert.equal(chips.length, 2);
  assert.match(chips[0], /Drink/);
  assert.match(chips[1], /Exercise/);
  assert.match(await page.$eval('.nl-out', (e) => e.textContent), /haircut/);
});

test('unchecked entries are excluded and double-clicking Log posts once', async () => {
  await page.uncheck('.nl-chip input[type=checkbox]'); // first chip = Drink
  const before2 = nlPosts.length;
  await page.click('#nlConfirm');
  await page.click('#nlConfirm', { force: true }).catch(() => {}); // second tap: disabled
  await page.waitForFunction(() => document.querySelector('.nl-out').textContent.includes('Logged'));
  const commits = nlPosts.slice(before2).filter((p) => p.entries);
  assert.equal(commits.length, 1, 'exactly one commit POST despite double-click');
  assert.equal(commits[0].entries.length, 1);
  assert.equal(commits[0].entries[0].h, 'Exercise');
  assert.equal((await page.$eval('#nlText', (e) => e.value)), '', 'input clears after logging');
});

test('NL entries carry the 💬 marker in Recent', async () => {
  await page.waitForSelector('.recent .row');
  assert.match(await page.$eval('.recent', (e) => e.textContent), /💬/);
});
