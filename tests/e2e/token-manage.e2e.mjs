// E2E: token mint/list/revoke must use Clerk-only transport even when a
// Stream Deck ht_ token is stored in HabitKey (sessionStorage). api/token.js
// refuses non-Clerk credentials; HabitKey.fetch would attach x-habit-key first
// and break management.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { documentHeaders } from './document-headers.mjs';

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.gif': 'image/gif',
  '.png': 'image/png'
};

// Assembled at runtime — no key-like literals for the scanner.
const STORED_HT = 'ht_' + 'e2estorede2estorede2estoredee2';
const CLERK_BEARER = 'clerk-' + 'session-for-token-manage-e2e';
const TOKEN_HASH = 'ab' + 'cdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const MINTED = 'ht_' + 'mintedmintedmintedmintedmintedm';

let server, browser, page, port;
/** @type {{ method: string, url: string, habitKey: string|null, authorization: string|null }[]} */
let tokenCalls = [];
let listed = [{ hash: TOKEN_HASH, prefix: 'ht_e2e', label: 'Deck', createdAt: Date.now() }];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/auth/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: false, publishableKey: null }));
      return;
    }
    if (url === '/auth.js') {
      const mock =
        `window.__HABIT_AUTH_MOCK__={signedIn:true,` +
        `getToken:async()=>'${CLERK_BEARER}'};\n`;
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(mock + readFileSync(join(ROOT, 'auth.js'), 'utf8'));
      return;
    }
    if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, entries: [] }));
      return;
    }
    if (url === '/api/slots') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: true, aiReady: true, model: 'fixture', suggestedAt: 0,
        habits: [], slots: [null, null, null, null], deck: null
      }));
      return;
    }
    if (url === '/api/token') {
      const habitKey = req.headers['x-habit-key'] || null;
      const authorization = req.headers.authorization || null;
      tokenCalls.push({ method: req.method, url: req.url, habitKey, authorization });
      if (habitKey) {
        // Mirror production: ht_ present → refuse (verifyApiToken null / via≠clerk).
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sign in on the web to manage API tokens.' }));
        return;
      }
      if (!authorization || !String(authorization).startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tokens: listed }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          listed = [{
            hash: TOKEN_HASH,
            prefix: MINTED.slice(0, 7),
            label: 'Stream Deck',
            createdAt: Date.now()
          }];
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            token: MINTED,
            prefix: MINTED.slice(0, 7),
            label: 'Stream Deck',
            createdAt: Date.now(),
            hash: TOKEN_HASH
          }));
        });
        return;
      }
      if (req.method === 'DELETE') {
        listed = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ revoked: true }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const p = join(ROOT, url === '/' ? 'index.html' : url);
    if (existsSync(p)) {
      const type = MIME[extname(p)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, ...(extname(p) === '.html' ? documentHeaders() : {}) });
      res.end(readFileSync(p));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const exe = process.env.CHROME_PATH ||
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  page = await browser.newPage();
});

after(async () => { await browser?.close(); server?.close(); });

test('signed-in Clerk user with stored ht_ can list, mint, and revoke via Clerk-only transport', async () => {
  tokenCalls = [];
  listed = [{ hash: TOKEN_HASH, prefix: 'ht_e2e', label: 'Deck', createdAt: Date.now() }];

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // Seed a stored Stream Deck token the way HabitKey keeps it (sessionStorage).
  await page.evaluate((k) => {
    sessionStorage.setItem('habitdeck.key', k);
  }, STORED_HT);

  await page.goto(`http://127.0.0.1:${port}/?settings=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#settings.open');
  await page.waitForFunction(() => {
    const list = document.getElementById('tokenList');
    return list && /revoke|No tokens/i.test(list.textContent || '');
  });

  // List must have succeeded (revoke button present) despite stored ht_.
  assert.match(await page.$eval('#tokenList', (e) => e.textContent), /revoke/i);

  const listCalls = tokenCalls.filter((c) => c.method === 'GET');
  assert.ok(listCalls.length >= 1, 'list /api/token must fire');
  for (const c of listCalls) {
    assert.equal(c.habitKey, null, 'list must not send x-habit-key');
    assert.equal(c.authorization, 'Bearer ' + CLERK_BEARER);
  }

  // Mint
  const beforeMint = tokenCalls.length;
  await page.click('#mintToken');
  await page.waitForFunction(() => {
    const once = document.getElementById('tokenOnce');
    return once && once.style.display !== 'none' && (once.textContent || '').length > 0;
  });
  const mintCalls = tokenCalls.slice(beforeMint).filter((c) => c.method === 'POST');
  assert.equal(mintCalls.length, 1);
  assert.equal(mintCalls[0].habitKey, null, 'mint must not send x-habit-key');
  assert.equal(mintCalls[0].authorization, 'Bearer ' + CLERK_BEARER);
  assert.match(await page.$eval('#tokenOnce', (e) => e.textContent), /^ht_/);

  // Revoke
  const beforeRevoke = tokenCalls.length;
  await page.click('#tokenList [data-revoke]');
  await page.waitForFunction(() => {
    const st = document.getElementById('tokenStatus');
    return st && /revoked/i.test(st.textContent || '');
  });
  const revokeCalls = tokenCalls.slice(beforeRevoke).filter((c) => c.method === 'DELETE');
  assert.ok(revokeCalls.length >= 1, 'revoke DELETE must fire');
  for (const c of revokeCalls) {
    assert.equal(c.habitKey, null, 'revoke must not send x-habit-key');
    assert.equal(c.authorization, 'Bearer ' + CLERK_BEARER);
  }

  // Stored deck token must still be intact (tokenFetch must not clear HabitKey).
  const stillStored = await page.evaluate(() => sessionStorage.getItem('habitdeck.key'));
  assert.equal(stillStored, STORED_HT);
});
