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
// unique id for the same reason as BOLD: deck.html renders a legitimate
// <svg class="ring"> streak ring on every habit key (#64/#68).
const SVG = '<svg id=pwnsvg onload=1>';
const SCRIPT = '<script>window.PWN=1</script>';
// carries a unique id so a parsed one is unambiguously OURS — the dashboard
// (deck heartbeat) and habits (the .note block) both render legitimate <b>.
const BOLD = '<b id=pwnb>bold</b>';

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

// Counting nodes by tag is the wrong instrument: the pages legitimately create
// <img> (deck key icons) and <b> (the deck heartbeat line), and which of those
// exist at probe time depends on icon load timing and Chromium version.
//
// The precise, environment-independent question is whether the payload was
// PARSED or ESCAPED. If it was escaped it survives in innerHTML as `&lt;…`; if
// it was parsed the browser re-serializes it as a real tag. So assert on the
// serialized markup of the container, and report what was found on failure.
async function probe(path, root) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const result = await page.evaluate((sel) => {
    const scope = document.querySelector(sel);
    if (!scope) return { missing: true };
    const html = scope.innerHTML;
    // Tags that can only exist here if one of our payloads was parsed.
    // Every payload carries its own unique marker, so a legitimate node the
    // page renders (key icons, the streak-ring <svg>, the heartbeat <b>) can
    // never be mistaken for an injection — and vice versa.
    const parsed = [...scope.querySelectorAll('img, script, #pwnb, #pwnsvg')]
      .filter((el) => {
        if (el.tagName === 'IMG') return el.getAttribute('src') === 'x';  // icons are /icons/…
        if (el.tagName === 'SCRIPT') return !el.src;                      // page scripts sit outside
        return true;                                                      // uniquely tagged: ours
      })
      .map((el) => el.outerHTML.slice(0, 120));
    return {
      pwned: !!window.PWN,
      parsed,
      // proof the payloads actually reached this container at all — a probe
      // that renders nothing would otherwise "pass" vacuously
      rendered: html.includes('&lt;'),
      text: document.body.innerText
    };
  }, root);
  await page.close();
  return { ...result, errors };
}

function assertInert(r, what) {
  assert.equal(r.missing, undefined, `${what}: the content container was not found — the probe checked nothing`);
  assert.equal(r.pwned, false, `${what}: a <script> from the model executed`);
  assert.deepEqual(r.parsed, [], `${what}: hostile markup was parsed into real nodes`);
  assert.equal(r.rendered, true, `${what}: no escaped payload reached the container — the probe proved nothing`);
}

test('the dashboard renders hostile coach output as inert text', async () => {
  const r = await probe('/', '#app');
  assertInert(r, 'dashboard');
  assert.ok(r.text.includes(IMG), 'the hostile emoji should survive as visible text');
  assert.ok(r.text.includes(SVG), 'the hostile label should survive as visible text');
});

test('the coach mind renders hostile memory and slots as inert text', async () => {
  const r = await probe('/mind.html', '.wrap');
  assertInert(r, 'mind');
  assert.ok(r.text.includes(IMG) || r.text.includes(SVG), 'hostile strings should be visible as text');
});

test('the virtual deck renders hostile key faces as inert text', async () => {
  const r = await probe('/deck.html', '#face');
  assertInert(r, 'deck');
});

test('the habit manager renders a hostile roster as inert text', async () => {
  const r = await probe('/habits.html', '.wrap');
  assertInert(r, 'habits');
});
