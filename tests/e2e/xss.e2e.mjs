// XSS regression suite for every page that renders coach output.
//
// Why this is e2e and not a regex over the source: sanitize() (lib/coach-shape.js)
// character-restricts only `habit` — `emoji` and `label` are length-clamped and
// nothing more, and `<img src=x>` fits in 11 of label's 12 characters. So the
// pages are the last line of defence. A static guard has to enumerate every
// field and every interpolation form and re-derive that list whenever a
// renderer changes; driving the real renderers with hostile values covers all
// of them by construction, including multiline templates.
//
// Requires: npm i playwright-core --no-save, and Chromium at CHROME_PATH or the
// repo default (/opt/pw-browsers/chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.gif': 'image/gif', '.png': 'image/png' };

// Every string here is hostile. Each is a *different* shape of attack so a
// renderer that escapes one but not another still fails.
const IMG = '<img src=x>';          // 11 chars — fits label's 12-char clamp
const SVG = '<svg onload';          // an unterminated tag still breaks out
const SCRIPT = '<script>window.PWN=1</script>';
const BOLD = '<b>bold</b>';

const EVIL_SLOT = {
  habit: 'Evil', emoji: IMG, label: SVG, reason: SCRIPT,
  assignedAt: Date.now()
};
const EVIL_NUDGE = {
  habit: 'Nudge', emoji: BOLD, label: IMG, reason: SVG,
  nudge: true, assignedAt: Date.now() - 1000, expiresAt: Date.now() + 60000
};
const EVIL_QUESTION = {
  habit: 'Ask', emoji: SVG, label: BOLD, reason: IMG,
  qid: 'q1', question: SCRIPT
};
const EVIL_HABITS = [{ name: 'Evil', emoji: IMG, label: SVG, goal: 1 }];
const EVIL_INSIGHT = { date: SCRIPT, text: IMG };

let server, browser, port;

const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/data') {
      return json(res, {
        configured: true,
        entries: [{ h: SVG, t: Date.now(), e: IMG, note: SCRIPT, slot: 1 }],
        insight: EVIL_INSIGHT
      });
    }
    if (url === '/api/slots') {
      return json(res, {
        configured: true, aiReady: true, model: SCRIPT, habits: EVIL_HABITS,
        suggestedAt: Date.now(), slots: [EVIL_SLOT, EVIL_NUDGE, EVIL_QUESTION, null],
        coachPage: new Array(12).fill(null), coachNav: 'off',
        today: { Evil: { count: 1, goal: 1, doneToday: true, streak: 3, ringFill: 1 } },
        track: { overall: { offered: 3, landed: 1, hitRate: 0.33 }, perHabit: [] },
        deck: { at: Date.now(), plugin: SVG, keys: 15 }
      });
    }
    if (url === '/api/mind') {
      return json(res, {
        configured: true, aiReady: true, model: SCRIPT, humanName: IMG,
        memory: { notes: `${SCRIPT}\n${IMG}\n${SVG}`, updatedAt: Date.now() },
        insight: EVIL_INSIGHT, slots: [EVIL_SLOT, EVIL_NUDGE, null, null],
        suggestedAt: Date.now(),
        track: { overall: { offered: 3, landed: 1, hitRate: 0.33 }, perHabit: [] },
        stats: { tapsObserved: 1, daysTogether: 1, ideasTried: 1, assignments: 1 }
      });
    }
    if (url === '/api/habits') return json(res, { habits: EVIL_HABITS, coachHabits: [] });
    if (url === '/api/roster') return json(res, { proposals: [], archive: [] });
    if (url.startsWith('/api/')) return json(res, { ok: true });

    const p = join(ROOT, url === '/' ? 'index.html' : url);
    if (p.startsWith(ROOT) && existsSync(p)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(readFileSync(p));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const exe = process.env.CHROME_PATH ||
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
});

after(async () => { await browser?.close(); server?.close(); });

// Counts only nodes the HOSTILE payloads could have created, and only inside
// the container the page renders model output into — every page ships its own
// inline <script> and the dashboard renders a legitimate <b> in the deck
// heartbeat line, both of which would otherwise read as false positives.
async function probe(path, root) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const result = await page.evaluate((sel) => {
    const scope = document.querySelector(sel);
    return {
      pwned: !!window.PWN,
      injected: scope ? scope.querySelectorAll('img[src="x"], svg, script').length : -1,
      text: document.body.innerText
    };
  }, root);
  await page.close();
  return { ...result, errors };
}

test('the dashboard renders hostile coach output as inert text', async () => {
  const r = await probe('/', '#app');
  assert.equal(r.pwned, false, 'a <script> from the model executed');
  assert.equal(r.injected, 0, 'hostile markup created real DOM nodes');
  assert.notEqual(r.injected, -1, 'the content container was not found — the probe is checking nothing');
  assert.ok(r.text.includes(IMG), 'the hostile emoji should survive as visible text');
  assert.ok(r.text.includes(SVG), 'the hostile label should survive as visible text');
});

test('the coach mind renders hostile memory and slots as inert text', async () => {
  const r = await probe('/mind.html', '.wrap');
  assert.equal(r.pwned, false, 'a <script> from the model executed');
  assert.equal(r.injected, 0, 'hostile markup created real DOM nodes');
  assert.notEqual(r.injected, -1, 'the content container was not found — the probe is checking nothing');
  assert.ok(r.text.includes(IMG) || r.text.includes(SVG), 'hostile strings should be visible as text');
});

test('the virtual deck renders hostile key faces as inert text', async () => {
  const r = await probe('/deck.html', '#face');
  assert.equal(r.pwned, false, 'a <script> from the model executed');
  assert.equal(r.injected, 0, 'hostile markup created real DOM nodes');
  assert.notEqual(r.injected, -1, 'the content container was not found — the probe is checking nothing');
});

test('the habit manager renders a hostile roster as inert text', async () => {
  const r = await probe('/habits.html', '.wrap');
  assert.equal(r.pwned, false, 'a <script> from the model executed');
  assert.equal(r.injected, 0, 'hostile markup created real DOM nodes');
  assert.notEqual(r.injected, -1, 'the content container was not found — the probe is checking nothing');
});
