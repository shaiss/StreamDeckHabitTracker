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

let server, browser, context, page, port;
let calls = [];        // every /api/log + /api/nudge request, as "METHOD url"
let logStatus = 200;
let nudgeFraction = null;   // null = slot 1 holds a plain suggestion
let mockRosterPending = 0;
let mockBlocked = false;
let mockQuestion = false;
let mockPicker = false;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/log') {
      calls.push(req.method + ' ' + req.url);
      res.writeHead(logStatus, { 'Content-Type': 'text/plain' });
      res.end(logStatus === 200 ? 'Logged: Drink' : 'Nothing to undo');
      return;
    }
    if (url === '/api/nudge') {
      calls.push(req.method + ' ' + req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dismissed: true }));
      return;
    }
    if (url === '/api/slots') {
      const now = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: true, aiReady: true, suggestedAt: now,
        habits: [{ name: 'Drink', emoji: '💧', label: 'Drink' }],
        slots: mockPicker
          ? [
              { habit: 'FixPick', emoji: '▤', label: 'REBASE', qid: 'qpick',
                question: 'Which fix?', pattern: 'picker', choiceIndex: 1,
                verb: 'options', assignedAt: now, expiresAt: now + 3600_000 },
              { habit: 'FixPick', emoji: '▤', label: 'MERGE', qid: 'qpick',
                question: 'Which fix?', pattern: 'picker', choiceIndex: 2,
                verb: 'options', assignedAt: now, expiresAt: now + 3600_000 },
              { habit: 'FixPick', emoji: '▤', label: 'SQUASH', qid: 'qpick',
                question: 'Which fix?', pattern: 'picker', choiceIndex: 3,
                verb: 'options', assignedAt: now, expiresAt: now + 3600_000 },
              null
            ]
          : mockQuestion
          ? [
              { habit: 'LunchSat', emoji: '✓', label: 'APPROVE', qid: 'qtest',
                question: 'Did lunch sit well?', pattern: 'gate', gateRole: 'approve',
                verb: 'approve', glyphTint: 'success', assignedAt: now, expiresAt: now + 3600_000 },
              { habit: 'LunchSat', emoji: '…', label: 'DETAILS', qid: 'qtest',
                question: 'Did lunch sit well?', pattern: 'gate', gateRole: 'details',
                verb: 'details', assignedAt: now, expiresAt: now + 3600_000 },
              { habit: 'LunchSat', emoji: '✕', label: 'DENY', qid: 'qtest',
                question: 'Did lunch sit well?', pattern: 'gate', gateRole: 'deny',
                verb: 'reject', assignedAt: now, expiresAt: now + 3600_000 },
              null
            ]
          : [
          nudgeFraction === null
            ? { habit: 'Flow', emoji: '🌊', label: 'Flow', assignedAt: 1 }
            : {
                habit: 'Water', emoji: '💧', label: 'Water?', nudge: true,
                assignedAt: now - 3600_000 * nudgeFraction,
                expiresAt: now + 3600_000 * (1 - nudgeFraction)
              },
          null, null, null
        ],
        rosterPending: mockRosterPending,
        blocked: mockBlocked,
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
  // hasTouch so page.touchscreen.tap exercises the same pointer path phones use.
  context = await browser.newContext({ hasTouch: true });
  page = await context.newPage();
});

after(async () => { await context?.close(); await browser?.close(); server?.close(); });

// Fresh page per test: gesture state lives on the DOM nodes.
async function open({ nudge = null, roster = 0, blocked = false, question = false, picker = false } = {}) {
  calls = [];
  logStatus = 200;
  nudgeFraction = nudge;
  mockRosterPending = roster;
  mockBlocked = blocked;
  mockQuestion = question;
  mockPicker = picker;
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

// --- nudge escalation + dismissal (#35) ---

test('a hold on a nudge dismisses it instead of undoing a log', async () => {
  await open({ nudge: 0.5 });
  await page.waitForFunction(() => !!document.querySelector('.nudgeface'));
  calls = [];
  await page.locator('.k[data-slot="1"]').click({ delay: 700 });
  await page.waitForTimeout(500);
  assert.match(calls[0], /^POST \/api\/nudge\?dismiss=1&slot=1/);
  assert.ok(!calls.some((c) => c.startsWith('DELETE')), 'a poke has no log entry to undo');
  assert.match(await page.$eval('#hint', (e) => e.textContent), /not today/i);
});

test('a nudge face escalates as its TTL runs down', async () => {
  const urg = () => page.$eval('.nudgeface', (e) => parseFloat(e.style.getPropertyValue('--urg')));
  await open({ nudge: 0.05 });
  await page.waitForFunction(() => !!document.querySelector('.nudgeface .frame-wait'));
  const fresh = await urg();
  const freshHue = await page.$eval('.nudgeface', (e) => e.style.getPropertyValue('--hue'));
  await open({ nudge: 0.95 });
  await page.waitForFunction(() => !!document.querySelector('.nudgeface .frame-wait'));
  const late = await urg();
  const lateHue = await page.$eval('.nudgeface', (e) => e.style.getPropertyValue('--hue'));
  assert.ok(fresh < 0.2 && late > 0.8, `urgency should track the TTL: ${fresh} -> ${late}`);
  assert.equal(freshHue, lateHue, 'identity hue on the interior must not change with urgency');
});

test('a plain suggestion slot still undoes on hold, not dismisses', async () => {
  await open({ nudge: null });
  await page.locator('.k[data-slot="1"]').click({ delay: 700 });
  await settle();
  assert.match(calls[0], /^DELETE \/api\/log\?slot=1/, 'nudge-ness is resolved at press time');
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

test('Attention Beacon: idle / wait+count / blocked faces; tap never logs (#75)', async () => {
  await open();
  await page.waitForSelector('.k[data-beacon]');
  const faceOf = () => page.$eval('.k[data-beacon]', (el) => ({
    cls: el.querySelector('.facecss')?.className || '',
    frame: el.querySelector('.stateframe')?.className || '',
    badge: el.querySelector('.badge')?.textContent || '',
    glyph: el.querySelector('.em')?.textContent || ''
  }));
  let f = await faceOf();
  assert.match(f.cls, /coachface/, 'violet coach interior');
  assert.match(f.frame, /frame-idle/, 'dark/idle when nothing pending');
  assert.equal(f.badge, '');
  assert.equal(f.glyph, '🧭');

  await open({ nudge: 0.4, roster: 2 });
  await page.waitForFunction(() => document.querySelector('.k[data-beacon] .frame-wait'));
  f = await faceOf();
  assert.match(f.cls, /coachface/, 'interior stays coachface, not nudgeface');
  assert.doesNotMatch(f.cls, /nudgeface|qface/);
  assert.match(f.frame, /frame-wait/);
  assert.equal(f.badge, '3', '1 live nudge + 2 roster proposals');
  assert.equal(f.glyph, '🧭');

  await open({ blocked: true });
  await page.waitForFunction(() => document.querySelector('.k[data-beacon] .frame-blocked'));
  f = await faceOf();
  assert.match(f.cls, /coachface/);
  assert.match(f.frame, /frame-blocked/);
  assert.equal(f.glyph, '🧭');

  calls = [];
  await page.locator('.k[data-beacon]').click();
  await settle();
  assert.equal(calls.length, 0, 'beacon is a signpost — no log, dismiss, or answer');
  assert.match(await page.$eval('#hint', (e) => e.textContent), /blocked|signpost|quiet|pending/i);
});

test('keys claim touch-action:none and keep a tap after pointer capture', async () => {
  const key = await open();
  const touchAction = await key.evaluate((el) => getComputedStyle(el).touchAction);
  assert.equal(touchAction, 'none', 'scroll must not steal the key press');

  // Real touch: Playwright's touchscreen goes through the pointer pipeline the
  // phone uses. A regression that drops pointerup after a tiny move shows up
  // here even when mouse click() still passes.
  const box = await key.boundingBox();
  assert.ok(box, 'key must be visible');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await settle();
  assert.equal(calls.length, 1, 'a touchscreen tap must still log');
  assert.match(calls[0], /^GET \/api\/log\?hkey=1/);
});

test('press feedback paints on pointerdown before the double-tap window', async () => {
  const key = await open();
  await key.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1 });
  assert.equal(await key.evaluate((el) => el.classList.contains('pressed')), true);
  await key.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', buttons: 0 });
  // Class clears on up; the deferred tap still lands after DOUBLE_TAP_MS.
  assert.equal(await key.evaluate((el) => el.classList.contains('pressed')), false);
  await settle();
  assert.equal(calls.length, 1);
});

test('phone viewport: device fits without horizontal scroll and a tap still logs', async () => {
  // iPhone-class CSS width where the prior 62px phone size overflowed (~28px)
  // and turned taps into scroll cancels.
  await page.setViewportSize({ width: 390, height: 844 });
  const key = await open();
  const geometry = await page.evaluate(() => {
    const device = document.querySelector('.device');
    const r = device.getBoundingClientRect();
    return {
      deviceWidth: r.width,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      keySize: getComputedStyle(document.querySelector('.k')).width,
      touchAction: getComputedStyle(document.querySelector('.k')).touchAction
    };
  });
  assert.equal(geometry.touchAction, 'none');
  assert.ok(parseFloat(geometry.keySize) >= 44, `key must stay ≥44px, got ${geometry.keySize}`);
  assert.ok(
    geometry.scrollWidth <= geometry.clientWidth + 1,
    `horizontal overflow steals taps: scroll=${geometry.scrollWidth} client=${geometry.clientWidth} device=${geometry.deviceWidth}`
  );

  const box = await key.boundingBox();
  assert.ok(box, 'habit key visible at phone size');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await settle();
  assert.equal(calls.length, 1, 'phone tap must log via /api/log');
  assert.match(calls[0], /^GET \/api\/log\?hkey=1/);

  // Restore desktop-ish viewport for any later tests in this worker.
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a violet suggestion has no wait frame; a pending question does (#76)', async () => {
  await open();
  await page.waitForSelector('.k[data-slot="1"] .slotface');
  assert.equal(await page.locator('.k[data-slot="1"] .frame-wait').count(), 0,
    'coach merely speaking owes no press');
  await open({ question: true });
  await page.waitForSelector('.qface .frame-wait');
  assert.match(await page.$eval('.k[data-slot="1"] .facecss', (e) => e.className), /qface/);
});

test('pressing an Ask answer key runs wait → confirming → done (#76)', async () => {
  await open({ question: true });
  await page.waitForSelector('.k[data-slot="1"] .frame-wait');
  await page.locator('.k[data-slot="1"]').click();
  await page.waitForFunction(() => document.querySelector('.k[data-slot="1"] .frame-working'));
  await page.waitForFunction(() => document.querySelector('.k[data-slot="1"] .frame-success'));
});

test('a yes/no ask paints the Approval Gate in fixed order (#77)', async () => {
  await open({ question: true });
  await page.waitForSelector('.k[data-slot="1"] .qface .frame-wait');
  const labels = await page.$$eval('.k[data-slot] .lb', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels.slice(0, 3), ['APPROVE', 'DETAILS', 'DENY']);
  const glyphs = await page.$$eval('.k[data-slot] .em', (els) => els.map((e) => e.textContent));
  assert.deepEqual(glyphs.slice(0, 3), ['✓', '…', '✕']);
  assert.ok(await page.locator('.k[data-slot="1"] .em-tint-success').count());
  assert.equal(await page.locator('.k[data-slot="3"] .em-tint-success').count(), 0,
    'deny is not success-tinted');
});

test('DETAILS shows the question and does not log (#77)', async () => {
  await open({ question: true });
  await page.waitForSelector('.k[data-slot="2"] .qface');
  await page.locator('.k[data-slot="2"]').click();
  await page.waitForFunction(() => /lunch/i.test(document.getElementById('hint').textContent));
  await settle();
  assert.equal(calls.length, 0, 'DETAILS must not commit');
});

test('DETAILS double-tap also refuses to log (#77)', async () => {
  await open({ question: true });
  const details = page.locator('.k[data-slot="2"]');
  await page.waitForSelector('.k[data-slot="2"] .qface');
  await details.click();
  await page.waitForTimeout(60);
  await details.click();
  await settle();
  assert.equal(calls.length, 0, 'DETAILS must not log on any gesture');
  assert.match(await page.$eval('#hint', (e) => e.textContent), /lunch/i);
});

test('a Choice Picker badges indices and settles siblings on press (#77)', async () => {
  await open({ picker: true });
  await page.waitForSelector('.k[data-slot="1"] .qface .frame-wait');
  const badges = await page.$$eval('.k[data-slot] .badge', (els) => els.map((e) => e.textContent));
  assert.deepEqual(badges.slice(0, 3), ['①', '②', '③']);
  const labels = await page.$$eval('.k[data-slot] .lb', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels.slice(0, 3), ['REBASE', 'MERGE', 'SQUASH']);
  await page.locator('.k[data-slot="1"]').click();
  await page.waitForFunction(() => document.querySelector('.k[data-slot="1"] .frame-working, .k[data-slot="1"] .frame-success'));
  await page.waitForFunction(() => document.querySelector('.k[data-slot="2"] .frame-idle'));
});
