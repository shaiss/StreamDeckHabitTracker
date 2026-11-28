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
import { spawn } from 'node:child_process';
import {
  CONSENT_LEVELS, normalizeConsent, cycleConsent, autonomyOf,
  AUTONOMY_GLYPH, AUTONOMY_MODES,
  beginConsentWrite, nextNavSeq, releaseIssuedNavSeq, settleConsentWrite, mergePolledConsent,
  acceptCoachNavSeq, CONSENT_WRITE_TIMEOUT_MS
} from '../../lib/takeover.js';
import { zip } from '../../tools/lib-zip.mjs';
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import { face } from '../../streamdeck-plugin/src/faces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Strict, Node-only ZIP reader used by the profile-archive assertions: walks
// the central directory and checks CRC32 (not just local headers). zlib.crc32
// is used when present; otherwise a small compatible implementation.
function crc32(buf) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function readZipArchive(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('missing end-of-central-directory');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error('central directory overlaps EOCD');
  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('truncated central directory');
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const xlen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nlen).toString('utf8');
    pos += 46 + nlen + xlen + clen;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('missing local header for ' + name);
    }
    const lflags = buf.readUInt16LE(localOff + 6);
    const lmethod = buf.readUInt16LE(localOff + 8);
    const lcrc = buf.readUInt32LE(localOff + 14);
    const lcsize = buf.readUInt32LE(localOff + 18);
    const lusize = buf.readUInt32LE(localOff + 22);
    const lnlen = buf.readUInt16LE(localOff + 26);
    const lxlen = buf.readUInt16LE(localOff + 28);
    if (lflags & 0x08) throw new Error('data-descriptor entries are not supported');
    if (lflags & 0x01) throw new Error('encrypted entry');
    if (lmethod !== method || lcrc !== crc || lcsize !== csize || lusize !== usize) {
      throw new Error('local header does not match central directory for ' + name);
    }
    const start = localOff + 30 + lnlen + lxlen;
    if (start + csize > buf.length) throw new Error('truncated entry ' + name);
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 8) data = inflateRawSync(raw);
    else if (method === 0) data = raw;
    else throw new Error('unsupported compression method ' + method + ' for ' + name);
    if (data.length !== usize) throw new Error('size mismatch for ' + name);
    if ((crc32(data) >>> 0) !== (crc >>> 0)) throw new Error('crc32 mismatch for ' + name);
    entries.push({ name, data });
  }
  if (pos !== cdOffset + cdSize) throw new Error('central directory size mismatch');
  return entries;
}


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

test('superseded success is kept: a later failure restores it, not the tap-time snapshot', () => {
  // Start ASSISTED (confirmed @ seq 5). AUTO (token 6) persists but its
  // response arrives after MANUAL (token 7) was issued; token 7 then fails.
  let confirmed = { consent: 'nudge-only', sequence: 5 };
  const stale = settleConsentWrite({
    currentSeq: 2, writeSeq: 1, ok: true, current: 'off', prev: 'nudge-only',
    written: 'may-navigate', navSeq: 6, confirmed
  });
  assert.equal(stale.applied, false, 'superseded settle never touches pending/optimistic state');
  assert.equal(stale.pending, true);
  assert.deepEqual(stale.confirmed, { consent: 'may-navigate', sequence: 6 });
  confirmed = stale.confirmed;

  const failed = settleConsentWrite({
    currentSeq: 2, writeSeq: 2, ok: false, current: 'off', prev: 'nudge-only',
    written: 'off', navSeq: 7, confirmed
  });
  assert.equal(failed.applied, true);
  assert.equal(failed.consent, 'may-navigate', 'restores the persisted AUTO, not the tap-time ASSISTED');
  assert.deepEqual(failed.confirmed, { consent: 'may-navigate', sequence: 6 });
});

test('an older success never overwrites a newer confirmed success', () => {
  const r = settleConsentWrite({
    currentSeq: 3, writeSeq: 1, ok: true, current: 'off', prev: 'off',
    written: 'nudge-only', navSeq: 4,
    confirmed: { consent: 'may-navigate', sequence: 6 }
  });
  assert.deepEqual(r.confirmed, { consent: 'may-navigate', sequence: 6 });
});

test('a failed write does not move the confirmed server sequence', () => {
  const r = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false, current: 'nudge-only', prev: 'off',
    written: 'nudge-only', navSeq: 1, confirmed: { consent: 'off', sequence: 0 }
  });
  assert.deepEqual(r.confirmed, { consent: 'off', sequence: 0 });
  assert.equal(r.consent, 'off');
});

test('409 reconcile older than the confirmed sequence falls back to confirmed', () => {
  const r = settleConsentWrite({
    currentSeq: 1, writeSeq: 1, ok: false, current: 'off', prev: 'off',
    server: { coachNav: 'nudge-only', coachNavSeq: 3 },
    confirmed: { consent: 'may-navigate', sequence: 6 }
  });
  assert.equal(r.consent, 'may-navigate');
  assert.deepEqual(r.confirmed, { consent: 'may-navigate', sequence: 6 });
});

test('poll carrying an older server sequence is ignored (overlapping refreshes)', () => {
  // Two polls started at the same write generation; the newer one (seq 1,
  // may-navigate) lands first, then the delayed one (seq 0, off).
  let consent = 'off';
  let appliedSeq = 0;
  const newer = mergePolledConsent({
    pending: false, current: consent, polled: 'may-navigate',
    pollSeq: 1, currentSeq: 1, pendingAtStart: false, serverSeq: 1, appliedServerSeq: appliedSeq
  });
  assert.equal(newer.ignored, false);
  consent = newer.consent;
  appliedSeq = 1;
  const older = mergePolledConsent({
    pending: false, current: consent, polled: 'off',
    pollSeq: 1, currentSeq: 1, pendingAtStart: false, serverSeq: 0, appliedServerSeq: appliedSeq
  });
  assert.equal(older.ignored, true);
  assert.equal(older.consent, 'may-navigate');
});

test('poll at a lower sequence is still applied when no higher sequence was accepted', () => {
  // A failed write leaves the local generation ahead of the server; the stored
  // value (lower sequence than the local token) must still repaint the face.
  const r = mergePolledConsent({
    pending: false, current: 'off', polled: 'nudge-only',
    pollSeq: 3, currentSeq: 3, pendingAtStart: false, serverSeq: 1, appliedServerSeq: 1
  });
  assert.equal(r.ignored, false);
  assert.equal(r.consent, 'nudge-only');
  const fromZero = mergePolledConsent({
    pending: false, current: 'off', polled: 'nudge-only',
    pollSeq: 9, currentSeq: 9, pendingAtStart: false, serverSeq: 0, appliedServerSeq: 0
  });
  assert.equal(fromZero.ignored, false);
  // Equal sequence is idempotent, and a missing sequence never blocks a poll.
  assert.equal(mergePolledConsent({
    pending: false, current: 'off', polled: 'off', serverSeq: 4, appliedServerSeq: 4
  }).ignored, false);
  assert.equal(mergePolledConsent({
    pending: false, current: 'off', polled: 'off', serverSeq: undefined, appliedServerSeq: 4
  }).ignored, false);
});

test('issued navSeq stays monotonic while an older write is in flight', () => {
  // Older POST still pending, newer POST fails: a third tap must receive a
  // token strictly greater than the older in-flight write, otherwise the
  // older (larger) token could land later and overwrite the newer consent.
  let confirmedSeq = 0;
  let issued = 0;
  let outstanding = 0;
  let gen = 0;
  const begin = () => {
    gen = beginConsentWrite(gen);
    const token = nextNavSeq(confirmedSeq, issued);
    issued = token;
    outstanding += 1;
    return { writeSeq: gen, token };
  };
  const settle = (t, ok) => {
    const r = settleConsentWrite({
      currentSeq: gen, writeSeq: t.writeSeq, ok,
      current: 'off', prev: 'off',
      written: ok ? 'nudge-only' : 'may-navigate', navSeq: t.token,
      confirmed: { consent: 'off', sequence: confirmedSeq }
    });
    confirmedSeq = r.confirmed.sequence;
    outstanding = Math.max(0, outstanding - 1);
    issued = releaseIssuedNavSeq(issued, confirmedSeq, outstanding);
    return r;
  };

  const older = begin();
  assert.equal(older.token, 1);
  const newer = begin();
  assert.equal(newer.token, 2);
  const failed = settle(newer, false);
  assert.equal(failed.applied, true);
  assert.equal(issued, 2, 'latest failure must not drop the issued watermark while an older write is in flight');
  const third = begin();
  assert.equal(third.token, 3);
  assert.ok(third.token > older.token, 'third tap must beat the in-flight older token');
  settle(third, false);
  settle(older, false);
  assert.equal(outstanding, 0);
  assert.equal(issued, 0, 'after every write settles, the token recovers to the confirmed sequence');
  assert.equal(nextNavSeq(confirmedSeq, issued), 1);
  assert.equal(releaseIssuedNavSeq(7, 4, 1), 7);
  assert.equal(releaseIssuedNavSeq(7, 4, 0), 4);
  assert.equal(CONSENT_WRITE_TIMEOUT_MS, 10_000);
});

test('rejected attempts do not ratchet the next navSeq past the stored sequence', () => {
  // Stored sequence stays 0 while 1000 attempts fail. The token is derived from
  // the confirmed sequence (reset after each failed settle), so it stays valid.
  let confirmedSeq = 0;
  let issued = 0;
  let gen = 0;
  for (let i = 0; i < 1000; i++) {
    gen = beginConsentWrite(gen);
    const token = nextNavSeq(confirmedSeq, issued);
    issued = token;
    const settled = settleConsentWrite({
      currentSeq: gen, writeSeq: gen, ok: false, current: 'nudge-only', prev: 'off',
      written: 'nudge-only', navSeq: token,
      confirmed: { consent: 'off', sequence: confirmedSeq }
    });
    confirmedSeq = settled.confirmed.sequence;
    issued = releaseIssuedNavSeq(issued, confirmedSeq, 0);
  }
  assert.equal(gen, 1000, 'local generation still counts every attempt');
  assert.equal(nextNavSeq(confirmedSeq, issued), 1, 'next token is stored + 1');
  // In-flight writes still get strictly increasing tokens.
  assert.equal(nextNavSeq(5, 5), 6);
  assert.equal(nextNavSeq(5, 6), 7);
  assert.equal(nextNavSeq(undefined, undefined), 1);
});

test('profile-archive assertions read the zip with Node, not an external unzip', () => {
  const src = readFileSync(new URL('./autonomy.test.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /spawnSync\(\s*['\"]unzip['\"]/);
  assert.match(src, /readZipArchive\(/);
  assert.match(src, /crc32 mismatch/);
});

test('readZipArchive rejects a zip whose central-directory CRC does not match', () => {
  const good = zip([{ name: 'hello.txt', data: Buffer.from('hello') }]);
  const entries = readZipArchive(good);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'hello.txt');
  assert.equal(entries[0].data.toString('utf8'), 'hello');

  const eocd = good.length - 22;
  assert.equal(good.readUInt32LE(eocd), 0x06054b50);
  const cdOffset = good.readUInt32LE(eocd + 16);
  assert.equal(good.readUInt32LE(cdOffset), 0x02014b50);
  const badCd = Buffer.from(good);
  badCd.writeUInt32LE((badCd.readUInt32LE(cdOffset + 16) ^ 0xffffffff) >>> 0, cdOffset + 16);
  assert.throws(() => readZipArchive(badCd), /crc32 mismatch|does not match central directory/);

  const badLocal = Buffer.from(good);
  // Flip the stored CRC in the local header (offset 14); central stays intact.
  badLocal.writeUInt32LE((badLocal.readUInt32LE(14) ^ 0xffffffff) >>> 0, 14);
  assert.throws(() => readZipArchive(badLocal), /does not match central directory/);
});

test('dashboard Save allows one request in flight (no overlapping consent tokens)', () => {
  const js = readFileSync(new URL('../../public/index.js', import.meta.url), 'utf8');
  assert.match(js, /if \(saveBtn\.disabled\) return;\s*saveBtn\.disabled = true;/);
  assert.match(js, /\.finally\(\(\) => \{ saveBtn\.disabled = false; \}\)/);
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
    'settled.confirmed',
    'nextNavSeq(',
    'releaseIssuedNavSeq(',
    'confirmedSeq',
    'consentWritesOutstanding',
    'CONSENT_WRITE_TIMEOUT_MS',
    'appliedServerSeq',
    'signal: ctrl.signal',
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
  assert.match(plugin, /settled\.confirmed/);
  assert.match(plugin, /nextNavSeq/);
  assert.match(plugin, /releaseIssuedNavSeq/);
  assert.match(plugin, /confirmedSeq/);
  assert.match(plugin, /consentWritesOutstanding/);
  assert.match(plugin, /appliedServerSeq/);
  // Bounded write lifetime: one deadline over the POST and the 409 body read.
  assert.match(plugin, /CONSENT_WRITE_TIMEOUT_MS/);
  assert.match(plugin, /signal: ctrl\.signal/);
  assert.match(plugin, /com\.shaiss\.habit-tracker\.autonomy/);
  assert.match(plugin, /kind === 'autonomy'/);
  assert.match(plugin, /\/api\/profile/);
  assert.match(takeover, /export function releaseIssuedNavSeq/);
  assert.match(takeover, /export const CONSENT_WRITE_TIMEOUT_MS/);
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

    // Node-only ZIP read (no external `unzip` binary).
    const entries = readZipArchive(readFileSync(outfile));
    const page0Entry = entries.find((e) => /\/Profiles\/[A-F0-9-]+\/manifest\.json$/i.test(e.name));
    assert.ok(page0Entry, 'page-0 manifest missing from profile zip');
    const actions = JSON.parse(page0Entry.data.toString('utf8')).Controllers[0].Actions || {};
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

    // Node-only ZIP read (no external `unzip` binary).
    const entries = readZipArchive(readFileSync(outfile));
    const page0Entry = entries.find((e) => /\/Profiles\/[A-F0-9-]+\/manifest\.json$/i.test(e.name));
    assert.ok(page0Entry, 'page-0 manifest missing from profile zip');

    const actions = JSON.parse(page0Entry.data.toString('utf8')).Controllers[0].Actions || {};
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
