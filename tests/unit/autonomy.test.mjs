// Autonomy Toggle (#94 / study §3.5): cycle order, consent mapping, face
// parity across the three modes, and a drift guard so deck.html cannot fork
// the pure helpers in lib/takeover.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONSENT_LEVELS, normalizeConsent, cycleConsent, autonomyOf,
  AUTONOMY_GLYPH, AUTONOMY_MODES,
  beginConsentWrite, settleConsentWrite, mergePolledConsent, acceptCoachNavSeq
} from '../../lib/takeover.js';
import { face } from '../../streamdeck-plugin/src/faces.mjs';

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

test('autonomyOf maps 1:1 onto consent — MANUAL / ASSIST / AUTO faces', () => {
  assert.deepEqual(autonomyOf('off'), {
    consent: 'off', mode: 'MANUAL', label: 'MANUAL', glyph: AUTONOMY_GLYPH
  });
  assert.deepEqual(autonomyOf('nudge-only'), {
    consent: 'nudge-only', mode: 'ASSISTED', label: 'ASSIST', glyph: AUTONOMY_GLYPH
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
  for (const [svg, label] of [[manual, 'MANUAL'], [assist, 'ASSIST'], [auto, 'AUTO']]) {
    assert.match(svg, /data-state-frame="idle"/, label + ' stays calm/idle');
    assert.ok(svg.includes(AUTONOMY_GLYPH), label + ' shows the gear glyph');
    assert.match(svg, new RegExp('>' + label + '<'), label + ' short label');
  }
  // Only the label text differs between modes — interior recipe is shared.
  assert.equal(stripFrame(manual).replace(/>MANUAL</g, '>X<'),
    stripFrame(assist).replace(/>ASSIST</g, '>X<'));
  assert.equal(stripFrame(assist).replace(/>ASSIST</g, '>X<'),
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
});

test('virtual deck + plugin pin the same cycle/mapping + write race guard (drift)', () => {
  const deck = readFileSync(new URL('../../public/deck.html', import.meta.url), 'utf8');
  const plugin = readFileSync(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url), 'utf8');
  const takeover = readFileSync(new URL('../../lib/takeover.js', import.meta.url), 'utf8');
  assert.match(takeover, /export function cycleConsent/);
  assert.match(takeover, /export function autonomyOf/);
  assert.match(takeover, /export function beginConsentWrite/);
  assert.match(takeover, /export function settleConsentWrite/);
  assert.match(takeover, /export function mergePolledConsent/);
  assert.match(takeover, /export function acceptCoachNavSeq/);
  for (const marker of [
    "const CONSENT_LEVELS = ['off', 'nudge-only', 'may-navigate']",
    "label: 'MANUAL'",
    "label: 'ASSIST'",
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
    'data-autonomy',
    'autonomyface'
  ]) {
    assert.ok(deck.includes(marker), 'deck.html missing autonomy marker: ' + marker);
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
  assert.match(plugin, /com\.shaiss\.habit-tracker\.autonomy/);
  assert.match(plugin, /kind === 'autonomy'/);
  assert.match(plugin, /\/api\/profile/);
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
});
