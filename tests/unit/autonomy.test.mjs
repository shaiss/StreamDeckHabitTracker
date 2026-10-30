// Autonomy Toggle (#94 / study §3.5): cycle order, consent mapping, face
// parity across the three modes, and a drift guard so public/deck.js (and
// its deck.html CSS) cannot fork the pure helpers in lib/takeover.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  CONSENT_LEVELS, normalizeConsent, cycleConsent, autonomyOf,
  AUTONOMY_GLYPH, AUTONOMY_MODES,
  beginConsentWrite, settleConsentWrite, mergePolledConsent, acceptCoachNavSeq
} from '../../lib/takeover.js';
import { face } from '../../streamdeck-plugin/src/faces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const decode = (uri) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');
const stripFrame = (svg) => svg.replace(/<g data-state-frame="[^"]*"[\s\S]*?<\/g>/, '');

test('consent levels stay the three known values — no new leash states', () => {
  assert.deepEqual(CONSENT_LEVELS, ['off', 'nudge-only', 'may-navigate']);
  assert.equal(normalizeConsent(undefined), 'off');
  assert.equal(normalizeConsent('auto'), 'off');
});

test('cycle order is MANUAL → ASSISTED → AUTO → MANUAL (off → nudge-only → may-navigate)', () => {
  assert.equal(cycleConsent('off'), 'nudge-only');
  assert.equal(cycleConsent('nudge-only'), 'may-navigate');
  assert.equal(cycleConsent('may-navigate'), 'off');
  // Unknown collapses to off, then advances one step.
  assert.equal(cycleConsent('sure!'), 'nudge-only');
  // A full lap lands where it started.
  let c = 'off';
  for (let i = 0; i < CONSENT_LEVELS.length; i++) c = cycleConsent(c);
  assert.equal(c, 'off');
});

test('autonomyOf maps 1:1 onto consent — MANUAL / ASSISTED / AUTO faces', () => {
  assert.deepEqual(autonomyOf('off'), {
    consent: 'off', mode: 'MANUAL', label: 'MANUAL', glyph: AUTONOMY_GLYPH
  });
  assert.deepEqual(autonomyOf('nudge-only'), {
    consent: 'nudge-only', mode: 'ASSISTED', label: 'ASSISTED', glyph: AUTONOMY_GLYPH
  });
  assert.deepEqual(autonomyOf('may-navigate'), {
    consent: 'may-navigate', mode: 'AUTO', label: 'AUTO', glyph: AUTONOMY_GLYPH
  });
  assert.equal(autonomyOf('garbage').mode, 'MANUAL', 'unknown → MANUAL default');
  assert.equal(AUTONOMY_GLYPH, '⚙');
  assert.deepEqual(Object.keys(AUTONOMY_MODES).sort(), [...CONSENT_LEVELS].sort());
});

test('face bytes for each mode: idle frame, violet ⚙, short label (#94)', () => {
  const VIOLET = 262;
  const at = (consent) => {
    const snap = autonomyOf(consent);
    return decode(face(snap.glyph, snap.label, VIOLET, '', 72, {
      frame: 'idle', grammar: true, mono: true, now: 0
    }));
  };
  const manual = at('off');
  const assist = at('nudge-only');
  const auto = at('may-navigate');
  for (const [svg, label] of [[manual, 'MANUAL'], [assist, 'ASSISTED'], [auto, 'AUTO']]) {
    assert.match(svg, /data-state-frame="idle"/, label + ' stays calm/idle');
    assert.ok(svg.includes(AUTONOMY_GLYPH), label + ' shows the gear glyph');
    assert.match(svg, new RegExp('>' + label + '<'), label + ' short label');
  }
  // Only the label text differs between modes — interior recipe is shared.
  assert.equal(stripFrame(manual).replace(/>MANUAL</g, '>X<'),
    stripFrame(assist).replace(/>ASSISTED</g, '>X<'));
  assert.equal(stripFrame(assist).replace(/>ASSISTED</g, '>X<'),
    stripFrame(auto).replace(/>AUTO</g, '>X<'));
  const haloStop = (svg) => (svg.match(/<radialGradient[\s\S]*?stop-color="(#[0-9a-f]+)"/i) || [])[1];
  assert.equal(haloStop(manual), '#7f47e1', 'MANUAL interior is hue 262 violet');
  assert.equal(haloStop(assist), haloStop(manual));
  assert.equal(haloStop(auto), haloStop(manual));
});

test('stale failed POST does not roll back a newer success (consent write race)', () => {
  // Tap1 optimistic: off → nudge-only (seq 1). Tap2: nudge-only → may-navigate (seq 2).
  // Tap2 succeeds, then Tap1 fails — face must stay AUTO / may-navigate.
  let consent = 'off';
  let confirmed = 'off';
  let seq = 0;
  let pending = false;

  const tap = () => {
    const prev = confirmed; // last persisted — not the prior tap's optimistic value
    const next = cycleConsent(consent);
    const writeSeq = beginConsentWrite(seq);
    seq = writeSeq;
    pending = true;
    consent = next;
    return { prev, writeSeq, next };
  };
  const t1 = tap();
  assert.equal(t1.next, 'nudge-only');
  const t2 = tap();
  assert.equal(t2.next, 'may-navigate');

  const ok2 = settleConsentWrite({
    currentSeq: seq, writeSeq: t2.writeSeq, ok: true,
    current: consent, prev: t2.prev
  });
  assert.equal(ok2.applied, true);
  assert.equal(ok2.pending, false);
  pending = ok2.pending;
  confirmed = ok2.consent;
  assert.equal(consent, 'may-navigate');
  assert.equal(confirmed, 'may-navigate');

  const fail1 = settleConsentWrite({
    currentSeq: seq, writeSeq: t1.writeSeq, ok: false,
    current: consent, prev: t1.prev
  });
  assert.equal(fail1.applied, false, 'stale failure is a no-op');
  assert.equal(fail1.consent, 'may-navigate');
  assert.equal(fail1.pending, true, 'stale settle must not clear the newer write flag');
  // Caller only mutates on applied — consent stays may-navigate.
  if (fail1.applied) { consent = fail1.consent; pending = fail1.pending; }
  assert.equal(consent, 'may-navigate');
  assert.equal(pending, false);
});

test('two failed POSTs roll back to confirmed consent (off), not tap-prev', () => {
  // Tap1: off → nudge-only. Tap2: nudge-only → may-navigate. Both POSTs fail.
  // Latest settle must restore confirmed=off, not Tap2's prev=nudge-only.
  let consent = 'off';
  let confirmed = 'off';
  let seq = 0;
  let pending = false;

  const tap = () => {
    const prev = confirmed;
    const next = cycleConsent(consent);
    const writeSeq = beginConsentWrite(seq);
    seq = writeSeq;
    pending = true;
    consent = next;
    return { prev, writeSeq, next };
  };
  const t1 = tap();
  assert.equal(t1.next, 'nudge-only');
  assert.equal(t1.prev, 'off');
  const t2 = tap();
  assert.equal(t2.next, 'may-navigate');
  assert.equal(t2.prev, 'off', 'both taps share the same confirmed prev');

  const fail1 = settleConsentWrite({
    currentSeq: seq, writeSeq: t1.writeSeq, ok: false,
    current: consent, prev: t1.prev
  });
  assert.equal(fail1.applied, false, 'stale failure is a no-op');

  const fail2 = settleConsentWrite({
    currentSeq: seq, writeSeq: t2.writeSeq, ok: false,
    current: consent, prev: t2.prev
  });
  assert.equal(fail2.applied, true);
  consent = fail2.consent;
  pending = fail2.pending;
  assert.equal(consent, 'off', 'face returns to MANUAL / off');
  assert.equal(pending, false);
  assert.equal(confirmed, 'off');
});

test('latest failed POST still rolls back; poll ignored while write pending', () => {
  let consent = 'off';
  let seq = beginConsentWrite(0);
  let pending = true;
  const prev = 'off';
  consent = 'nudge-only';

  const polledMid = mergePolledConsent({
    pending, current: consent, polled: 'may-navigate'
  });
  assert.equal(polledMid.applied, false);
  assert.equal(polledMid.ignored, true);
  assert.equal(polledMid.consent, 'nudge-only', 'poll must not clobber in-flight optimistic');

  const fail = settleConsentWrite({
    currentSeq: seq, writeSeq: seq, ok: false, current: consent, prev
  });
  assert.equal(fail.applied, true);
  consent = fail.consent;
  pending = fail.pending;
  assert.equal(consent, 'off');
  assert.equal(pending, false);

  const polledAfter = mergePolledConsent({
    pending, current: consent, polled: 'nudge-only'
  });
  assert.equal(polledAfter.applied, true);
  assert.equal(polledAfter.ignored, false);
  assert.equal(polledAfter.consent, 'nudge-only');
});

test('poll started during a write is discarded even after pending clears', () => {
  // /api/slots snapshotted coachNav=off while write pending; response arrives
  // after the write persisted nudge-only and cleared pending.
  let consent = 'nudge-only';
  let confirmed = 'nudge-only';
  const consentSeq = 1;
  const pollSeq = 1;
  const pendingAtStart = true;
  const pendingNow = false;

  const polled = mergePolledConsent({
    pending: pendingNow, current: consent, polled: 'off',
    pollSeq, currentSeq: consentSeq, pendingAtStart
  });
  assert.equal(polled.ignored, true);
  assert.equal(polled.applied, false);
  assert.equal(polled.consent, 'nudge-only');
  if (!polled.ignored) confirmed = polled.consent;
  assert.equal(confirmed, 'nudge-only');
});

test('poll started at an older consentSeq is discarded after a newer tap', () => {
  let consent = 'may-navigate';
  const polled = mergePolledConsent({
    pending: false, current: consent, polled: 'off',
    pollSeq: 1, currentSeq: 2, pendingAtStart: false
  });
  assert.equal(polled.ignored, true);
  assert.equal(polled.consent, 'may-navigate');
});

test('acceptCoachNavSeq orders Autonomy writes; non-positive tokens refuse', () => {
  assert.equal(acceptCoachNavSeq(0, 1), true);
  assert.equal(acceptCoachNavSeq(1, 2), true);
  assert.equal(acceptCoachNavSeq(5, 6), true);
  assert.equal(acceptCoachNavSeq(1, 1), false, 'equal is stale');
  assert.equal(acceptCoachNavSeq(5, 4), false, 'older is stale');
  assert.equal(acceptCoachNavSeq(0, 0), false);
  assert.equal(acceptCoachNavSeq(0, -1), false);
  assert.equal(acceptCoachNavSeq(0, 1.5), false, 'non-integer refused');
  assert.equal(acceptCoachNavSeq(0, '2'), true, 'numeric string coerces');
  assert.equal(acceptCoachNavSeq(0, 1e21), false, 'non-safe integer refused');
});

test('409 settle reconciles server coachNav + coachNavSeq; no auto-retry of intent', () => {
  // Client never polled (seq 0); another client already owns seq 10 / ASSISTED.
  // Local tap optimistically paints AUTO and POSTs navSeq=1 → 409 with server truth.
  let consent = 'off';
  let confirmed = 'off';
  let seq = 0;
  let pending = false;
  const prev = confirmed;
  const next = cycleConsent(consent); // nudge-only — but we simulate a bigger gap
  // Optimistic cycle as the plugin does: off → nudge-only with writeSeq 1.
  const writeSeq = beginConsentWrite(seq);
  seq = writeSeq;
  pending = true;
  consent = next;
  assert.equal(consent, 'nudge-only');
  assert.equal(writeSeq, 1);

  // Server says ASSISTED at seq 10 — reconcile, do not retry the rejected intent.
  const settled = settleConsentWrite({
    currentSeq: seq, writeSeq, ok: false,
    current: consent, prev,
    server: { coachNav: 'nudge-only', coachNavSeq: 10 }
  });
  assert.equal(settled.applied, true);
  assert.equal(settled.pending, false);
  assert.equal(settled.consent, 'nudge-only');
  assert.equal(settled.sequence, 10);
  consent = settled.consent;
  confirmed = settled.consent;
  pending = settled.pending;
  if (typeof settled.sequence === 'number' && settled.sequence > seq) {
    seq = settled.sequence;
  }
  assert.equal(confirmed, 'nudge-only');
  assert.equal(seq, 10, 'local navSeq advances to server so the next tap can win');
  assert.equal(pending, false);
  // Next tap starts at 11 — no automatic re-POST of the rejected intent.
  const nextWrite = beginConsentWrite(seq);
  assert.equal(nextWrite, 11);
  assert.notEqual(nextWrite, writeSeq, 'rejected navSeq is not retried');
});

test('409 settle with may-navigate server state updates confirmed away from prev', () => {
  // Local confirmed=off; optimistic may-navigate rejected; server is AUTO @ 5.
  const settled = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false,
    current: 'may-navigate', prev: 'off',
    server: { coachNav: 'may-navigate', coachNavSeq: 5 }
  });
  assert.equal(settled.applied, true);
  assert.equal(settled.consent, 'may-navigate');
  assert.equal(settled.sequence, 5);
  assert.notEqual(settled.consent, 'off');
});

test('409 settle without valid server state still falls back to prev', () => {
  const noBody = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false,
    current: 'nudge-only', prev: 'off'
  });
  assert.equal(noBody.consent, 'off');
  assert.equal(noBody.sequence, undefined);

  const badSeq = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false,
    current: 'nudge-only', prev: 'off',
    server: { coachNav: 'may-navigate', coachNavSeq: 1.5 }
  });
  assert.equal(badSeq.consent, 'off', 'non-integer coachNavSeq → prev');
  assert.equal(badSeq.sequence, undefined);

  const missingNav = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false,
    current: 'nudge-only', prev: 'off',
    server: { coachNavSeq: 3 }
  });
  assert.equal(missingNav.consent, 'off');
  assert.equal(missingNav.sequence, undefined);
});

test('stale 409 settle is still a no-op when a newer write is in flight', () => {
  const settled = settleConsentWrite({
    currentSeq: 2, writeSeq: 1, ok: false,
    current: 'may-navigate', prev: 'off',
    server: { coachNav: 'nudge-only', coachNavSeq: 99 }
  });
  assert.equal(settled.applied, false);
  assert.equal(settled.consent, 'may-navigate');
  assert.equal(settled.pending, true);
  assert.equal(settled.sequence, undefined);
});

test('virtual deck + plugin pin the same cycle/mapping + write race guard (drift)', () => {
  // Logic lives in public/deck.js (extracted with habit-key); CSS class in deck.html.
  const deckJs = readFileSync(new URL('../../public/deck.js', import.meta.url), 'utf8');
  const deckHtml = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  const plugin = readFileSync(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url), 'utf8');
  const takeover = readFileSync(new URL('../../lib/takeover.js', import.meta.url), 'utf8');
  assert.match(takeover, /export function cycleConsent/);
  assert.match(takeover, /export function autonomyOf/);
  assert.match(takeover, /export function beginConsentWrite/);
  assert.match(takeover, /export function settleConsentWrite/);
  assert.match(takeover, /export function mergePolledConsent/);
  assert.match(takeover, /export function acceptCoachNavSeq/);
  assert.match(deckHtml, /autonomyface/);
  assert.match(deckHtml, /src="\/deck\.js"/);
  for (const marker of [
    "const CONSENT_LEVELS = ['off', 'nudge-only', 'may-navigate']",
    "label: 'MANUAL'",
    "label: 'ASSISTED'",
    "label: 'AUTO'",
    'function cycleConsent(',
    'function autonomyOf(',
    'function beginConsentWrite(',
    'function settleConsentWrite(',
    'function mergePolledConsent(',
    'consentWritePending',
    'confirmedConsent',
    'pendingAtStart',
    'navSeq',
    'r.status === 409',
    'settled.sequence',
    'data-autonomy',
    'autonomyface'
  ]) {
    assert.ok(deckJs.includes(marker), 'deck.js missing autonomy marker: ' + marker);
  }
  assert.match(plugin, /cycleConsent/);
  assert.match(plugin, /autonomyOf/);
  assert.match(plugin, /beginConsentWrite/);
  assert.match(plugin, /settleConsentWrite/);
  assert.match(plugin, /mergePolledConsent/);
  assert.match(plugin, /consentWritePending/);
  assert.match(plugin, /confirmedConsent/);
  assert.match(plugin, /pendingAtStart/);
  assert.match(plugin, /navSeq/);
  assert.match(plugin, /r\.status === 409/);
  assert.match(plugin, /settled\.sequence/);
  assert.match(plugin, /com\.shaiss\.habit-tracker\.autonomy/);
  assert.match(plugin, /kind === 'autonomy'/);
  assert.match(plugin, /\/api\/profile/);
  assert.match(takeover, /server\?\.coachNavSeq/);
});

test('plugin profiles reserve one Autonomy key regardless of pageCount', () => {
  // Formula + placement guard live in tools/generate.mjs. Pin the reservation
  // so a one-page --plugin profile still emits the sticky key (#94 / CR).
  const gen = readFileSync(new URL('../../tools/generate.mjs', import.meta.url), 'utf8');
  assert.match(gen, /const autonomyKeyCount = usePlugin \? 1 : 0/,
    'every plugin profile must reserve Autonomy (not pageCount > 1)');
  assert.doesNotMatch(gen, /const autonomyKeyCount = usePlugin && pageCount/,
    'Autonomy reservation must not depend on pageCount');
  // Placement and capacity still driven by autonomyKeyCount (not a hardcode).
  assert.match(gen, /if \(autonomyKeyCount\)/);
  assert.match(gen, /PLUGIN_AUTONOMY/);
  assert.match(gen, /- autonomyKeyCount/);
  // Explicit --slots must share the remaining-capacity ceiling (CodeRabbit #95).
  assert.match(gen, /Math\.min\(4, wanted, remaining\)/,
    'explicit --slots must cap by remaining page-0 capacity');
  // Cell reservation before habit fill (#95 Entelligence) — capacity math alone
  // does not stop place() from consuming Autonomy's cell with habits.
  assert.match(gen, /__reservedSticky/);
  assert.match(gen, /placeSticky\(\s*['"]autonomy['"]/);
});

test('mini + 9 habits still places Autonomy (reserved before habit fill) (#95)', async () => {
  // Entelligence #95: habits filled first and consumed every Mini cell, so
  // place() logged "dropped the Autonomy key". Pre-reserved sticky cells must
  // keep Autonomy even when habits overflow.
  const dir = mkdtempSync(join(tmpdir(), 'ht-auto-reserve-'));
  const outfile = join(dir, 'Repro.streamDeckProfile');
  const nine = Array.from({ length: 9 }, (_, i) => ({
    name: 'H' + i, label: 'H' + i, emoji: '•'
  }));
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/habits')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ habits: nine }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const runGenerate = () => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'tools/generate.mjs'),
        `http://127.0.0.1:${port}/api/log`,
        '--plugin', '--model=mini', '--static',
        `--outfile=${outfile}`, '--name=Repro'
      ],
      { cwd: ROOT }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const r = await runGenerate();
    assert.equal(r.status, 0, `generate failed: ${r.stderr || r.stdout}`);
    assert.doesNotMatch(r.stderr + r.stdout, /dropped the Autonomy key/);
    assert.match(r.stderr + r.stdout, /dropped habit key/,
      'overflowing habits should be the ones displaced');

    const listing = spawnSync('unzip', ['-Z1', outfile], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const page0Path = listing.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((n) => /\/Profiles\/[A-F0-9-]+\/manifest\.json$/i.test(n));
    assert.ok(page0Path, 'page-0 manifest missing from profile zip');
    const page0 = spawnSync('unzip', ['-p', outfile, page0Path], { encoding: 'utf8' });
    assert.equal(page0.status, 0, page0.stderr);
    const actions = JSON.parse(page0.stdout).Controllers[0].Actions || {};
    const uuids = Object.values(actions).map((a) => a.UUID);
    assert.ok(uuids.includes('com.shaiss.habit-tracker.autonomy'),
      'Autonomy key must survive habit overflow on Mini');
    assert.equal(
      Object.values(actions).filter((a) => a.__reservedSticky).length,
      0,
      'sticky placeholders must be overwritten with real actions'
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit --slots on mini+pages=2 does not drop Coach or Autonomy (#95)', async () => {
  // CodeRabbit #95: `--plugin --model=mini --pages=2 --slots=4` with one habit
  // used to fill page 0 before sticky keys; place() then dropped Coach + Autonomy.
  // Cap explicit slots by the same remaining capacity as the automatic count.
  // Async spawn (not spawnSync) so this process's fixture HTTP server can answer
  // generate.mjs's /api/habits fetch without blocking the event loop.
  const dir = mkdtempSync(join(tmpdir(), 'ht-slots-cap-'));
  const outfile = join(dir, 'Repro.streamDeckProfile');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/habits')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ habits: [{ name: 'Eat', label: 'Eat', emoji: '🍽' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const runGenerate = () => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'tools/generate.mjs'),
        `http://127.0.0.1:${port}/api/log`,
        '--plugin', '--model=mini', '--pages=2', '--slots=4',
        '--static', `--outfile=${outfile}`, '--name=Repro'
      ],
      { cwd: ROOT }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const r = await runGenerate();
    assert.equal(r.status, 0, `generate failed: ${r.stderr || r.stdout}`);
    assert.match(r.stderr + r.stdout, /Habits\s+:\s+1\b/, 'fixture must serve exactly one habit');
    assert.doesNotMatch(r.stderr + r.stdout, /dropped the Coach key/);
    assert.doesNotMatch(r.stderr + r.stdout, /dropped the Autonomy key/);

    const listing = spawnSync('unzip', ['-Z1', outfile], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const page0Path = listing.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((n) => /\/Profiles\/[A-F0-9-]+\/manifest\.json$/i.test(n));
    assert.ok(page0Path, 'page-0 manifest missing from profile zip');

    const page0 = spawnSync('unzip', ['-p', outfile, page0Path], { encoding: 'utf8' });
    assert.equal(page0.status, 0, page0.stderr);
    const actions = JSON.parse(page0.stdout).Controllers[0].Actions || {};
    const uuids = Object.values(actions).map((a) => a.UUID);
    assert.ok(uuids.includes('com.shaiss.habit-tracker.coach'), 'Coach key must be placed');
    assert.ok(uuids.includes('com.shaiss.habit-tracker.autonomy'), 'Autonomy key must be placed');
    assert.ok(uuids.includes('com.elgato.streamdeck.page.next'), 'nav next key must remain');
    // mini 3×2, 1 habit + Stats + Coach + Autonomy + nav ⇒ at most 1 AI slot
    const aiSlots = Object.values(actions).filter((a) => a.UUID === 'com.shaiss.habit-tracker.slot');
    assert.equal(aiSlots.length, 1, 'explicit --slots=4 must shrink to remaining capacity');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
