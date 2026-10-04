import { test } from 'node:test';
import assert from 'node:assert/strict';
import { face, hueFor, STATE_COLORS, FRAME_STATES, resolveFrame, frameStep, frameBright, FRAME_WAIT_MS, FRAME_BLOCKED_MS, FRAME_TICK_MS, FRAME_WAIT_PERIODS, waitPeriodMs, owedFrame } from '../../streamdeck-plugin/src/faces.mjs';

const decode = (uri) => {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
};

test('face() returns a well-formed SVG data URI with glyph, label, and badge', () => {
  const svg = decode(face('🌊', 'Flow', 200, 'AI 1'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/);
  assert.ok(svg.includes('🌊'), 'emoji glyph present');
  assert.ok(svg.includes('>Flow<'), 'label present');
  assert.ok(svg.includes('AI 1'), 'badge present');
  assert.ok(svg.includes('linearGradient'), 'night base gradient');
  assert.ok(svg.includes('radialGradient'), 'votive halo');
  assert.ok(!/hsla?\(/.test(svg), 'no hsl()/hsla() — rasterizer compatibility');
});

test('labels are truncated to 12 chars and long labels shrink the font', () => {
  const svg = decode(face('✨', 'Hydration Break Time', 100, ''));
  assert.ok(svg.includes('>Hydration Br<'), 'label truncated at 12');
  assert.ok(svg.includes('font-size="17"'), 'long label uses the 17px size');
  const short = decode(face('✨', 'Eat', 100, ''));
  assert.ok(short.includes('font-size="20"'), 'short label uses the 20px size');
});

test('AI-generated strings are XML-escaped, not injected', () => {
  const svg = decode(face('<script>', 'a&b"c', 10, '<x>'));
  assert.ok(!svg.includes('<script>'), 'raw markup must not survive');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('a&amp;b&quot;c'));
});

test('no badge means no badge element', () => {
  const svg = decode(face('✨', 'Slot 1', 222, ''));
  assert.ok(!svg.includes('text-anchor="end"'), 'badge text is the only end-anchored element');
});

test('hueFor is the shared tools/lib-hue.mjs formula', async () => {
  const lib = await import('../../tools/lib-hue.mjs');
  for (const n of ['Pee', 'Eat', 'Flow', 'Walk']) assert.equal(hueFor(n), lib.hueFor(n));
});

// Living key faces (#32): habit keys carry a 6th `state` argument
// {count, goal, doneToday, streak, ringFill}; slot/nudge keys pass none and
// must render byte-identically to the stateless face.

const state = (over = {}) =>
  ({ count: 0, goal: 1, doneToday: false, streak: 0, ringFill: 0, ...over });

// #64: the progress indicator is the key's OWN rounded-rect border filling,
// not a separate circle floating over the square.
test('living faces: the key border fills — a rounded-rect frame, not a floating circle', () => {
  const third = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, goal: 3, ringFill: 1 / 3 })));
  assert.ok(!third.includes('rotate(-90'), 'the old rotated progress circle is gone');
  assert.ok(!/r="65"/.test(third), 'no inset progress-circle radius survives');
  assert.ok(third.includes('stroke-dasharray'), 'partial fill draws a lit segment');
  assert.ok(third.includes('stroke-linecap="round"'), 'the lit segment ends are rounded');
  // The fill is a <path> tracing the rounded-rect (A17 17 corners), not a circle.
  assert.match(third, /<path d="M[^"]*A17 17[^"]*"[^>]*stroke-dasharray/,
    'the fill traces the rounded-rect frame');

  const empty = decode(face('🚽', 'Pee', 20, '', 72, state()));
  assert.ok(!empty.includes('stroke-dasharray'), 'zero fill draws no lit segment');
  assert.ok(empty.includes('stroke-opacity="0.18"'), 'the faint frame track still shows');
  assert.ok(empty.includes('<path d="M'), 'the track is drawn as the frame path');

  const stateless = decode(face('🚽', 'Pee', 20, ''));
  assert.ok(!stateless.includes('stroke-dasharray'), 'no state, no fill');
  assert.ok(!stateless.includes('<path d="M'), 'no state, no frame');
});

test('living faces: the lit border length grows with ringFill, up to the perimeter', () => {
  const lit = (f) => {
    const m = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, goal: 4, ringFill: f })))
      .match(/stroke-dasharray="([\d.]+) /);
    return m ? +m[1] : 0;
  };
  const [a, b, c] = [0.25, 0.5, 1].map(lit);
  assert.ok(a < b && b < c, `lit length rises monotonically: ${a},${b},${c}`);
  // Overshoot (repeatable habits can exceed their goal) clamps to the full
  // perimeter via Math.min(1, ringFill) — never a longer-than-the-frame dash.
  assert.equal(lit(1.5), c, 'ringFill past the goal is clamped to the full perimeter');
  // Full fill ≈ the exact rounded-rect perimeter 2(w+h) − 8r + 2πr, w=h=132, r=17.
  const P = 2 * (132 + 132) - 8 * 17 + 2 * Math.PI * 17;
  assert.ok(Math.abs(c - P) < 0.5, `full fill ≈ perimeter ${P.toFixed(2)}, got ${c}`);
});

test('living faces: dim-when-done mutes the halo and shows a check', () => {
  const halo = (s) => s.match(/<radialGradient[\s\S]*?<\/radialGradient>/)[0];
  const done = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 1, doneToday: true, ringFill: 1 })));
  const notYet = decode(face('🚽', 'Pee', 20, '', 72, state({ count: 0 })));
  assert.ok(done.includes('>✓<'), 'done face carries the ✓');
  assert.ok(!notYet.includes('>✓<'), 'undone face has no ✓');
  assert.notEqual(halo(done), halo(notYet), 'done halo is dimmed (lower saturation)');
});

test('living faces: count dots fill with the day tally', () => {
  const svg = decode(face('🍽', 'Eat', 90, '', 72, state({ count: 2, goal: 3, ringFill: 2 / 3 })));
  assert.equal((svg.match(/r="2\.6"/g) || []).length, 3, 'one dot per goal unit');
  assert.equal((svg.match(/fill-opacity="0\.95"/g) || []).length, 2, 'two dots read filled');
  const single = decode(face('🍽', 'Eat', 90, '', 72, state({ count: 1, goal: 1, doneToday: true, ringFill: 1 })));
  assert.ok(!single.includes('r="2.6"'), 'goal of 1 draws no dots');
});

test('living faces: a goal above 8 renders the count as a number, not dots', () => {
  const svg = decode(face('💧', 'Water', 200, '', 72, state({ count: 4, goal: 10, ringFill: 0.4 })));
  assert.ok(!svg.includes('r="2.6"'), 'no dot clutter above 8');
  assert.ok(svg.includes('>4<'), 'the tally shows as a number');
});

// --- nudge escalation (#35) ---

const svgOf = (uri) => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
const haloOpacity = (svg) => +svg.match(/id="h"[\s\S]*?stop-opacity="([\d.]+)"/)[1];
const borderWidth = (svg) => +svg.match(/rx="17"[^>]*stroke-width="([\d.]+)"/)[1];

test('a face with no urgency is byte-identical to before escalation existed', () => {
  const plain = svgOf(face('💧', 'Water', 38, 'AI 1', 90));
  assert.match(plain, /stop-opacity="0.62"/, 'the original halo opacity');
  assert.match(plain, /stroke-opacity="0.30" stroke-width="1.5"/, 'the original hairline ring');
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, null)), plain, 'null state changes nothing');
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { doneToday: false })), plain,
    'a state object without urgency changes nothing');
});

test('urgency brightens the halo and firms the border, monotonically', () => {
  const at = (u) => svgOf(face('💧', 'Water?', 38, '❗ 1', 90, { urgency: u }));
  const halos = [0, 0.5, 1].map((u) => haloOpacity(at(u)));
  const borders = [0, 0.5, 1].map((u) => borderWidth(at(u)));
  assert.ok(halos[0] < halos[1] && halos[1] < halos[2], 'halo opacity rises: ' + halos.join(','));
  assert.ok(borders[0] < borders[1] && borders[1] < borders[2], 'border thickens: ' + borders.join(','));
  assert.ok(halos[2] <= 1, 'and never becomes an invalid opacity');
});

test('a wait frame owns urgency: interior frozen, stroke firms, pulse speeds (#76)', () => {
  const at = (u) => svgOf(face('💧', 'Water?', 38, '❗ 1', 72, { frame: 'wait', urgency: u, now: 0 }));
  assert.equal(stripFrame(at(0)), stripFrame(at(1)), 'interior (halo/ring/glyph) ignores urgency');
  const widths = [0, 0.5, 1].map((u) => cues(at(u)).width);
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], 'wait stroke firms: ' + widths.join(','));
  const ops = [0, 1].map((u) => cues(at(u)).opacity);
  assert.ok(ops[0] < ops[1], 'wait floor brightens: ' + ops.join(','));
  assert.equal(waitPeriodMs(0), FRAME_WAIT_MS);
  assert.ok(waitPeriodMs(1) < waitPeriodMs(0), 'pulse period shortens');
  // frameStep must actually consume urgency — at 2000ms the default 3000ms
  // period is still step 0, but urgency-1 (600ms) has already flipped.
  assert.equal(frameStep('wait', 2000, { urgency: 0 }), 0);
  assert.equal(frameStep('wait', 2000, { urgency: 1 }), 1, 'urgency shortens the pulse period');
  assert.equal(haloOpacity(at(0)), haloOpacity(at(1)));
});

test('owedFrame is wait only for a live question or nudge', () => {
  const now = 1_800_000_000_000;
  assert.equal(owedFrame({ qid: 'q1' }, now), 'wait');
  assert.equal(owedFrame({ nudge: true }, now), 'wait');
  assert.equal(owedFrame({ habit: 'Flow' }, now), null);
  assert.equal(owedFrame({ qid: 'q1', expiresAt: now }, now), null);
  assert.equal(owedFrame(null, now), null);
});

test('an Approval Gate approve glyph is tinted success; deny stays interior ink', () => {
  const yes = decode(face('✓', 'APPROVE', 300, '', 78, { frame: 'wait', grammar: true, mono: true, glyphTint: 'success' }));
  assert.match(yes, /fill="#22C55E"/, 'affirmative glyph is success green');
  assert.match(yes, />APPROVE</);
  assert.match(yes, /data-state-frame="wait"/);
  assert.match(yes, /ui-monospace/, 'gate labels use the mono voice');
  const no = decode(face('✕', 'DENY', 300, '', 78, { frame: 'wait', grammar: true, mono: true }));
  assert.match(no, /fill="#e9edf4"/, 'deny glyph is neutral, not danger-red');
  assert.doesNotMatch(no, /fill="#22C55E"/);
});

test('wait periods always flip on a 3000ms tick, at any wall-clock phase', () => {
  // The 1200ms continuous curve failed this: floor((t+3000)/1200) sometimes
  // equals floor(t/1200) in parity, so an urgent wait froze for a whole tick.
  for (const p of FRAME_WAIT_PERIODS) {
    assert.equal(FRAME_TICK_MS % p, 0, `period ${p} must divide the tick`);
    assert.equal((FRAME_TICK_MS / p) % 2, 1, `tick must cover an odd number of ${p}ms periods`);
  }
  for (const u of [0, 0.2, 1 / 3, 0.5, 2 / 3, 0.9, 1]) {
    const p = waitPeriodMs(u);
    assert.ok(FRAME_WAIT_PERIODS.includes(p), `urg ${u} snapped to a legal period, got ${p}`);
    for (let t = 0; t < FRAME_TICK_MS; t += 37) {
      assert.notEqual(
        frameStep('wait', t, { urgency: u }),
        frameStep('wait', t + FRAME_TICK_MS, { urgency: u }),
        `wait urg=${u} must flip on every default tick (t=${t})`
      );
    }
  }
  assert.ok(waitPeriodMs(1) < waitPeriodMs(0.5));
  assert.ok(waitPeriodMs(0.5) < waitPeriodMs(0));
});

test('urgency is clamped, so bad input cannot emit invalid SVG', () => {
  for (const u of [-5, 5, 1.0001]) {
    const svg = svgOf(face('💧', 'Water?', 38, '❗ 1', 90, { urgency: u }));
    const o = haloOpacity(svg);
    assert.ok(o >= 0 && o <= 1, `opacity ${o} out of range for urgency ${u}`);
  }
});

// --- turn-state frame (#74) ---

const GOLDEN_WATER = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141827"/><stop offset="1" stop-color="#0a0c13"/></linearGradient><radialGradient id="h" cx="0.5" cy="0.36" r="0.62"><stop offset="0" stop-color="#f4ae34" stop-opacity="0.62"/><stop offset="0.42" stop-color="#da8e0b" stop-opacity="0.18"/><stop offset="1" stop-color="#da8e0b" stop-opacity="0"/></radialGradient></defs><rect width="144" height="144" fill="url(#b)"/><rect width="144" height="144" fill="url(#h)"/><rect x="6" y="6" width="132" height="132" rx="17" fill="none" stroke="#f6bb55" stroke-opacity="0.30" stroke-width="1.5"/><text x="72" y="76" text-anchor="middle" font-size="62" font-family="\'Segoe UI Emoji\',\'Apple Color Emoji\',\'Noto Color Emoji\',sans-serif">💧</text><text x="73" y="117" text-anchor="middle" font-size="20" font-weight="600" font-family="\'Segoe UI\',Arial,sans-serif" fill="#000000" fill-opacity="0.55">Water</text><text x="72" y="116" text-anchor="middle" font-size="20" font-weight="600" font-family="\'Segoe UI\',Arial,sans-serif" fill="#e9edf4">Water</text><text x="134" y="18" text-anchor="end" font-size="11" font-weight="700" font-family="\'Segoe UI\',Arial,sans-serif" fill="#f5d7a3" fill-opacity="0.9">AI 1</text></svg>';

const stripFrame = (svg) => svg.replace(/<g data-state-frame="[^"]*">[\s\S]*?<\/g>/g, '');
const frameGroup = (svg) => {
  const m = svg.match(/<g data-state-frame="([^"]*)">([\s\S]*?)<\/g>/);
  return m ? { name: m[1], body: m[2] } : null;
};
const cues = (svg) => {
  const g = frameGroup(svg);
  if (!g) return { name: null, check: false, bang: false, dash: false, opacity: null, width: null };
  return {
    name: g.name,
    check: />✓</.test(g.body),
    bang: />!</.test(g.body),
    dash: /stroke-dasharray/.test(g.body),
    opacity: +(g.body.match(/stroke-opacity="([\d.]+)"/) || [])[1],
    width: +(g.body.match(/stroke-width="([\d.]+)"/) || [])[1]
  };
};

test('a face with no frameState is byte-identical to the pre-frame golden', () => {
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90)), GOLDEN_WATER);
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, null)), GOLDEN_WATER);
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { doneToday: false })), GOLDEN_WATER);
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { frame: null })), GOLDEN_WATER);
  assert.equal(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { frameState: 'danger' })), GOLDEN_WATER,
    'danger is not a frame state — unknown values must no-op');
});

test('each of the five frame states is a distinct outer stroke', () => {
  const at = (frame, extra = {}) => svgOf(face('💧', 'Water', 38, 'AI 1', 90, { frame, now: 0, ...extra }));
  const drawn = Object.fromEntries(FRAME_STATES.map((f) => [f, at(f)]));
  const names = new Set(Object.values(drawn).map((s) => frameGroup(s)?.name));
  assert.deepEqual([...names].sort(), [...FRAME_STATES].sort(), 'all five states emit a tagged frame');
  for (const [a, b] of [['idle', 'working'], ['working', 'wait'], ['wait', 'success'], ['success', 'blocked'], ['idle', 'wait']]) {
    assert.notEqual(drawn[a], drawn[b], `${a} and ${b} must not share a frame`);
  }
  for (const f of FRAME_STATES) {
    const svg = drawn[f];
    assert.ok(svg.includes(`stroke="${STATE_COLORS[f]}"`), `${f} uses ${STATE_COLORS[f]}`);
    assert.match(svg, /<rect x="2" y="2" width="140" height="140" rx="21"/,
      `${f} draws the OUTER rect, not the identity ring`);
    assert.ok(!/<filter[\s>]/.test(svg), 'rasterizer-safe: no SVG filter');
    assert.equal(stripFrame(svg), GOLDEN_WATER, `${f}: interior (halo/ring/glyph) is unchanged`);
  }
  assert.equal(cues(drawn.success).check, true, 'success carries a ✓ on the frame');
  assert.equal(cues(drawn.blocked).bang, true, 'blocked carries a ! on the frame');
  assert.equal(cues(drawn.working).dash, true, 'working has a shimmer dash (non-hue mark)');
  assert.ok(cues(drawn.wait).opacity > cues(drawn.idle).opacity, 'wait is brighter than idle');
  assert.ok(cues(drawn.wait).width > cues(drawn.idle).width, 'wait stroke is firmer than idle');
  // frameState alias
  assert.ok(frameGroup(at('wait')) && resolveFrame({ frameState: 'wait' }) === 'wait');
  assert.equal(at('wait'), svgOf(face('💧', 'Water', 38, 'AI 1', 90, { frameState: 'wait', now: 0 })));
});

test('desaturate: the five states stay distinguishable without hue', () => {
  const at = (frame, extra = {}) => cues(svgOf(face('💧', 'Water', 38, 'AI 1', 90, { frame, now: 0, ...extra })));
  const idle = at('idle');
  const working = at('working');
  const wait = at('wait');
  const success = at('success');
  const blocked = at('blocked');
  // Signature is motion/glyph/brightness — never the hex. Idle is still + dim;
  // working has a dash; wait is brighter/firmer; success has ✓; blocked has !.
  const sig = (c) => [c.check, c.bang, c.dash, c.opacity > 0.5, (c.width || 0) > 2.2].join(',');
  const sigs = [idle, working, wait, success, blocked].map(sig);
  assert.equal(new Set(sigs).size, 5, 'desaturated signatures collide: ' + sigs.join(' | '));
  // Brightness steps survive reduced-motion (still distinct vs idle).
  const waitStill = at('wait', { reducedMotion: true });
  const idleStill = at('idle', { reducedMotion: true });
  assert.ok(waitStill.opacity > idleStill.opacity, 'reduced-motion wait stays louder than idle');
  assert.equal(frameStep('wait', 99999, { reducedMotion: true }), 0);
  assert.equal(frameStep('blocked', 99999, { reducedMotion: true }), 0);
  assert.ok(frameStep('wait', FRAME_WAIT_MS, { reducedMotion: false }) !==
    frameStep('wait', 0, { reducedMotion: false }), 'wait flips on its period');
  const tick = 3000; // plugin default HT_TICK_MS
  assert.equal(tick % FRAME_BLOCKED_MS, 0, 'blocked period must divide the tick (no remainder → no phase alias)');
  assert.equal((tick / FRAME_BLOCKED_MS) % 2, 1, 'tick must cover an odd number of blocked periods');
  for (let t = 0; t < tick; t += 37) {
    assert.notEqual(frameStep('blocked', t), frameStep('blocked', t + tick),
      `blocked must flip on every default tick regardless of phase (t=${t})`);
  }
  assert.ok(frameBright('blocked', 1) > frameBright('blocked', 0), 'blocked blink is a brightness step');
});

test('state frame does not disturb living-face interior (#32/#64)', () => {
  const st = state({ count: 1, goal: 3, ringFill: 1 / 3 });
  const plain = svgOf(face('🚽', 'Pee', 20, '', 72, st));
  const framed = svgOf(face('🚽', 'Pee', 20, '', 72, { ...st, frame: 'wait', now: 0 }));
  assert.equal(stripFrame(framed), plain, 'progress fill / dots / halo survive a wait frame');
  assert.ok(framed.includes('stroke-dasharray'), 'the #64 fill is still there');
  assert.ok(framed.includes('data-state-frame="wait"'), 'and the outer wait frame is too');
});

test('Attention Beacon: interior stays violet coach across idle/wait/blocked (#75)', () => {
  const at = (frame, badge) => svgOf(face('🧭', 'Coach', 262, badge, 72, { frame, now: 0 }));
  const idle = at('idle', '');
  const wait = at('wait', '2');
  const blocked = at('blocked', '2');
  assert.equal(stripFrame(wait), stripFrame(at('idle', '2')), 'wait vs idle: only the frame differs');
  assert.equal(stripFrame(wait), stripFrame(blocked), 'blocked vs wait: only the frame differs');
  assert.ok(idle.includes('🧭') && wait.includes('🧭') && blocked.includes('🧭'));
  assert.equal(frameGroup(idle).name, 'idle');
  assert.equal(frameGroup(wait).name, 'wait');
  assert.equal(frameGroup(blocked).name, 'blocked');
  assert.ok(cues(blocked).bang, 'blocked ! lives on the frame, not the glyph');
  assert.match(wait, />2</, 'pending count is the top-right badge');
  assert.doesNotMatch(idle, />2</);
  const haloStop = (svg) => (svg.match(/<radialGradient[\s\S]*?stop-color="(#[0-9a-f]+)"/i) || [])[1];
  const idleHalo = haloStop(idle);
  assert.ok(idleHalo, 'idle has a votive halo');
  assert.equal(idleHalo, '#7f47e1', 'Coach interior is hue 262 violet, not some other shared color');
  assert.equal(haloStop(wait), idleHalo);
  assert.equal(haloStop(blocked), idleHalo);
});
