// Nocturne Ritual key face (design/PHILOSOPHY.md), as an SVG the Stream Deck
// app rasterizes. Port of the old canvas face() — night base, votive halo in
// the key's hue, hairline inner ring, oversized glyph, whispered label.
//
// Colors are pre-converted from HSL to hex because SVG rasterizers disagree
// about hsl()/hsla() support; the label "shadow" is a dark offset copy for the
// same reason (no <filter> dependency).
import { hueFor } from '../../tools/lib-hue.mjs';
import { questionPaint, glyphFor, VERB_GLYPHS, GATE_ORDER } from '../../public/glyphs.js';

export { hueFor, questionPaint, glyphFor, VERB_GLYPHS, GATE_ORDER };

// Turn-state palette (study §2.2 / #74). State owns the OUTER frame only;
// object identity stays on the halo + inner ring. Tokens are duplicated in
// plugin.mjs (STATE_*) and deck.html (.frame-*) — design-tokens.test.mjs
// pins the three copies so they cannot drift. `danger` is NOT a frame state.
export const STATE_COLORS = Object.freeze({
  idle: '#3A3F47',
  working: '#2EA3FF',
  wait: '#FFB000',
  success: '#22C55E',
  blocked: '#FF4D4D'
});
export const FRAME_STATES = Object.freeze(Object.keys(STATE_COLORS));

// Quantized motion on the plugin poll loop (#74, same idea as urgencyStep).
// CSS on deck.html animates for real; the plugin only repaints when the step
// changes. Default tick is 3000ms (HT_TICK_MS). Wait breathes on that tick.
// Blocked samples Date.now() the same way, so the period MUST divide 3000 with
// an odd quotient: otherwise some wall-clock phases advance an even number of
// buckets and parity sticks (1500→÷2, 2500→phase-dependent ÷1 or ÷2). 1000ms
// is ÷3 — every default tick flips, and the period stays faster than wait.
export const FRAME_TICK_MS = 3000; // default HT_TICK_MS; wait periods divide this
export const FRAME_WAIT_MS = 3000;
export const FRAME_BLOCKED_MS = 1000;
export const FRAME_WORKING_MS = 4000;
export const FRAME_SUCCESS_FADE_MS = 2400;
// Odd quotients of FRAME_TICK_MS: ÷1, ÷3, ÷5. Faster as urgency rises.
// A continuous 3000→1200ms curve stalls: 3000/1200 = 2.5, so some phases
// advance an even bucket count and wait parity sticks for a whole tick.
export const FRAME_WAIT_PERIODS = Object.freeze([3000, 1000, 600]);

export function resolveFrame(state) {
  if (!state) return null;
  const f = state.frame ?? state.frameState ?? null;
  if (f == null || f === '') return null;
  return Object.prototype.hasOwnProperty.call(STATE_COLORS, f) ? f : null;
}

// 0..N integer that only moves when the face would look different. Reduced
// motion collapses every state to step 0 (steady brightness; callers skip
// the repaint). Success steps 0..4 as it settles, then holds.
// Clamp 0..1. Shared by wait pulse-rate, wait stroke, and (legacy) halo urg.
export function clampUrgency(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Wait breathe period: 3000ms / 1000ms / 600ms (#76 / #35). Every value
// divides FRAME_TICK_MS with an odd quotient, so frameStep always flips on
// a default plugin tick regardless of wall-clock phase.
export function waitPeriodMs(urg = 0) {
  const u = clampUrgency(urg);
  if (u >= 2 / 3) return 600;
  if (u >= 1 / 3) return 1000;
  return FRAME_WAIT_MS;
}

// A press is genuinely owed: live question pair or live nudge. Violet
// suggestions (coach merely speaking) return null — no amber frame (#76).
export function owedFrame(def, now = Date.now()) {
  if (!def) return null;
  if (def.expiresAt && def.expiresAt <= now) return null;
  if (def.qid || def.nudge) return 'wait';
  return null;
}

export function frameStep(frame, now = 0, opts = {}) {
  if (!frame || frame === 'idle' || opts.reducedMotion) return 0;
  if (frame === 'wait') return Math.floor(now / waitPeriodMs(opts.urgency)) % 2;
  if (frame === 'blocked') return Math.floor(now / FRAME_BLOCKED_MS) % 2;
  if (frame === 'working') return Math.floor(now / (FRAME_WORKING_MS / 4)) % 4;
  if (frame === 'success') {
    const age = Math.max(0, now - (opts.since ?? now));
    return Math.min(4, Math.floor(age / (FRAME_SUCCESS_FADE_MS / 4)));
  }
  return 0;
}

// Brightness 0..1 the SVG stroke reads. Reduced-motion: wait stays the
// brightest (your-move louder than idle), blocked stays full, working mid.
export function frameBright(frame, step = 0, opts = {}) {
  if (!frame || frame === 'idle') return 0;
  if (opts.reducedMotion) {
    if (frame === 'wait' || frame === 'blocked') return 1;
    if (frame === 'working') return 0.55;
    if (frame === 'success') return 0.7;
    return 0;
  }
  if (frame === 'wait') {
    // Floor rises with urgency so an ignored poke is louder even on the dim
    // half of the breathe; the peak stays 1 (#76 maps #35 onto the frame).
    const lo = 0.45 + 0.40 * clampUrgency(opts.urgency);
    return step ? 1 : lo;
  }
  if (frame === 'blocked') return step ? 1 : 0.18;
  if (frame === 'working') return 0.35 + (step / 3) * 0.65;
  if (frame === 'success') return Math.max(0.22, 1 - step / 4);
  return 0;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

// Living key faces (#32): habit keys pass `state`
// ({count, goal, doneToday, streak, ringFill}) and gain a streak ring,
// dim-when-done + ✓, and count dots. Slot/nudge keys pass none and render
// exactly as before.
//
// Turn-state frame (#74): optional `state.frame` / `state.frameState`
// ('idle'|'working'|'wait'|'success'|'blocked'). Absent/null → byte-identical
// to the pre-frame SVG. The state stroke is a SEPARATE outer ring so it never
// shares pixels with the identity hairline or the #64 progress fill.
export function face(emoji, label, hue, badge, sat = 72, state = null) {
  const done = !!(state && state.doneToday);
  if (done) sat = Math.round(sat * 0.55); // dim-when-done
  // Nudge escalation (#35/#76): 0 when the poke lands, 1 as it nears expiry.
  // With a turn-state frame, urgency firms the OUTER wait stroke (and speeds
  // its breathe) so identity stays on the halo. Without a frame, the old halo
  // slope is the fallback so golden no-frame faces stay byte-identical.
  const urg = clampUrgency(state && state.urgency);
  // Interior identity never carries turn-state. A wait/working/success/blocked
  // frame owns urgency (#76); halo escalation is only the no-frame fallback.
  const frameNameEarly = resolveFrame(state);
  const interiorUrg = frameNameEarly ? 0 : urg;
  const S = 144;
  const raw = String(label);
  const lbl = esc(raw.slice(0, 12));
  const lblSize = raw.length > 8 ? 17 : 20;
  const grammar = !!(state && state.grammar);
  const tintName = state && state.glyphTint;
  const glyphFill = (tintName && STATE_COLORS[tintName]) || (grammar ? '#e9edf4' : null);
  const labelFont = (state && state.mono)
    ? "ui-monospace,'Cascadia Mono',Consolas,monospace"
    : "'Segoe UI',Arial,sans-serif";
  const haloHi = hslToHex(hue, sat, 58 + 12 * interiorUrg);
  const haloLo = hslToHex(hue, sat, 45 + 8 * interiorUrg);
  const ring = hslToHex(hue, sat, 65 + 10 * interiorUrg);
  const haloOpacity = (0.62 + 0.33 * interiorUrg).toFixed(2);
  const ringOpacity = (0.3 + 0.5 * interiorUrg).toFixed(2);
  const ringWidth = (1.5 + 1.5 * interiorUrg).toFixed(1);
  const badgeFill = hslToHex(hue, 80, 80);

  // Shared niche geometry: the hairline border and the progress fill trace the
  // exact same rounded rect, so they read as one frame — keep them off the same
  // constants rather than two copies of the literals that could drift (#64 review).
  const frameR = 17, frameX = 6, frameY = 6, frameW = S - 12, frameH = S - 12;

  // Outer state-frame geometry (#74). Inset 2 / stroke 2 occupies px 1–3;
  // identity hairline is at 6 ± 0.75 and the #64 progress stroke at 6 ± 2
  // (px 4–8). A 1px gap so state and identity never share a rasterized pixel.
  const stateX = 2, stateY = 2, stateW = S - 4, stateH = S - 4, stateR = 21, stateSw = 2;

  const frameName = frameNameEarly;
  let stateFrame = '';
  if (frameName) {
    const reduced = !!(state && state.reducedMotion);
    const step = (state && typeof state.frameStep === 'number')
      ? state.frameStep
      : frameStep(frameName, (state && state.now) || 0, {
        reducedMotion: reduced, since: state && state.frameSince, urgency: urg
      });
    const bright = (state && typeof state.frameBright === 'number')
      ? Math.max(0, Math.min(1, state.frameBright))
      : frameBright(frameName, step, { reducedMotion: reduced, urgency: urg });
    const color = STATE_COLORS[frameName];
    // Base opacity: idle is dim/off; wait is the loudest still floor;
    // working/blocked/success scale with the quantized brightness step.
    let opacity;
    if (frameName === 'idle') opacity = 0.38;
    else if (frameName === 'wait') opacity = (0.62 + 0.38 * bright).toFixed(2);
    else if (frameName === 'working') opacity = (0.5 + 0.5 * bright).toFixed(2);
    else if (frameName === 'blocked') opacity = (0.2 + 0.8 * bright).toFixed(2);
    else opacity = (0.35 + 0.65 * bright).toFixed(2); // success settle-and-fade
    // Wait is firmer than the other states, and firms further as urgency rises
    // so #35 still visibly intensifies when the halo no longer carries it.
    const sw = frameName === 'wait' ? (2.6 + 1.6 * clampUrgency(urg)) : stateSw;
    stateFrame =
      `<g data-state-frame="${frameName}">` +
      `<rect x="${stateX}" y="${stateY}" width="${stateW}" height="${stateH}" rx="${stateR}" ` +
      `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${sw}"` +
      (frameName === 'working' ? ` stroke-dasharray="10 7"` : '') +
      `/>`;
    if (frameName === 'success') {
      stateFrame +=
        `<text x="14" y="22" text-anchor="start" font-size="13" font-weight="700" ` +
        `font-family="'Segoe UI',Arial,sans-serif" fill="${color}" fill-opacity="0.95">✓</text>`;
    } else if (frameName === 'blocked') {
      stateFrame +=
        `<text x="14" y="22" text-anchor="start" font-size="14" font-weight="700" ` +
        `font-family="'Segoe UI',Arial,sans-serif" fill="${color}" fill-opacity="0.95">!</text>`;
    }
    stateFrame += `</g>`;
  }

  // Progress frame (#64): the key's OWN rounded-rect border fills, instead of a
  // separate circle floating over the square (which read as pasted-on because
  // its curve never met the key edges). A dim full-perimeter track plus a bright
  // segment tracing ringFill of the perimeter, clockwise from top-center — so
  // the niche edge itself lights up as the day's goal fills. Same rounded-rect
  // geometry as the hairline border below, so the two read as one frame.
  //
  // Kept rasterizer-safe: only <path> + stroke-dasharray + round caps (already
  // proven on the SD rasterizer). The path is authored starting at top-center,
  // clockwise, so the dash fills from the top with no dashoffset math; the exact
  // rounded-rect perimeter is 2(w+h) − 8r + 2πr (four quarter-corners = 2πr).
  let progressFrame = '';
  if (state && typeof state.ringFill === 'number') {
    const r = frameR, x = frameX, y = frameY, w = frameW, h = frameH, cx = x + w / 2;
    const framePath =
      `M${cx} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
      `V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
      `H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
      `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
    const P = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
    const fw = 4; // thick border, so the fill reads at a glance
    progressFrame =
      `<path d="${framePath}" fill="none" stroke="${hslToHex(hue, sat, 55)}" ` +
      `stroke-opacity="0.18" stroke-width="${fw}"/>`;
    if (state.ringFill > 0) {
      const lit = (P * Math.min(1, state.ringFill)).toFixed(2);
      progressFrame +=
        `<path d="${framePath}" fill="none" stroke="${hslToHex(hue, 85, 72)}" ` +
        `stroke-opacity="0.95" stroke-width="${fw}" stroke-linecap="round" ` +
        `stroke-dasharray="${lit} ${P.toFixed(2)}"/>`;
    }
  }

  // Count dots (repeatable habits): one dot per goal unit along the bottom,
  // filled = today's tally. Above 8 the tally shows as a number instead.
  let tally = '';
  if (state && state.goal > 1 && typeof state.count === 'number') {
    if (state.goal > 8) {
      tally =
        `<text x="${S - 10}" y="${S - 10}" text-anchor="end" font-size="12" font-weight="700" ` +
        `font-family="'Segoe UI',Arial,sans-serif" fill="${badgeFill}" fill-opacity="0.95">${state.count}</text>`;
    } else {
      const dots = state.goal, filled = Math.min(state.count, dots);
      const gap = 9, x0 = (S - (dots - 1) * gap) / 2, y = S - 14;
      const on = hslToHex(hue, 85, 72), off = hslToHex(hue, sat, 45);
      for (let i = 0; i < dots; i++) {
        tally +=
          `<circle cx="${x0 + i * gap}" cy="${y}" r="2.6" ` +
          `fill="${i < filled ? on : off}" fill-opacity="${i < filled ? '0.95' : '0.3'}"/>`;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<defs>` +
    `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#141827"/><stop offset="1" stop-color="#0a0c13"/>` +
    `</linearGradient>` +
    `<radialGradient id="h" cx="0.5" cy="0.36" r="0.62">` +
    `<stop offset="0" stop-color="${haloHi}" stop-opacity="${haloOpacity}"/>` +
    `<stop offset="0.42" stop-color="${haloLo}" stop-opacity="0.18"/>` +
    `<stop offset="1" stop-color="${haloLo}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${S}" height="${S}" fill="url(#b)"/>` +
    `<rect width="${S}" height="${S}" fill="url(#h)"/>` +
    `<rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" rx="${frameR}" fill="none" stroke="${ring}" stroke-opacity="${ringOpacity}" stroke-width="${ringWidth}"/>` +
    stateFrame +
    progressFrame +
    `<text x="${S / 2}" y="76" text-anchor="middle" font-size="${grammar ? 54 : 62}" ` +
    (glyphFill
      ? `fill="${glyphFill}" font-weight="700" font-family="${labelFont}"`
      : `font-family="'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif"`) +
    `>${esc(emoji)}</text>` +
    `<text x="${S / 2 + 1}" y="117" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="${labelFont}" fill="#000000" fill-opacity="0.55">${lbl}</text>` +
    `<text x="${S / 2}" y="116" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="${labelFont}" fill="#e9edf4">${lbl}</text>` +
    tally +
    // ✓ (done habit) beats badge — habit keys pass no badge, so the check is
    // the only corner mark a habit face ever shows.
    (done
      ? `<text x="${S - 10}" y="18" text-anchor="end" font-size="12" font-weight="700" ` +
        `font-family="'Segoe UI',Arial,sans-serif" fill="${badgeFill}" fill-opacity="0.95">✓</text>`
      : badge
        ? `<text x="${S - 10}" y="18" text-anchor="end" font-size="11" font-weight="700" ` +
          `font-family="'Segoe UI',Arial,sans-serif" fill="${badgeFill}" fill-opacity="0.9">${esc(badge)}</text>`
        : '') +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
