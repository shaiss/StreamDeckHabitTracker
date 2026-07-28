// Nocturne Ritual key face (design/PHILOSOPHY.md), as an SVG the Stream Deck
// app rasterizes. Port of the old canvas face() — night base, votive halo in
// the key's hue, hairline inner ring, oversized glyph, whispered label.
//
// Colors are pre-converted from HSL to hex because SVG rasterizers disagree
// about hsl()/hsla() support; the label "shadow" is a dark offset copy for the
// same reason (no <filter> dependency).
import { hueFor } from '../../tools/lib-hue.mjs';

export { hueFor };

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
export function face(emoji, label, hue, badge, sat = 72, state = null) {
  const done = !!(state && state.doneToday);
  if (done) sat = Math.round(sat * 0.55); // dim-when-done
  // Nudge escalation (#35): 0 when the poke lands, 1 as it nears expiry. The
  // halo brightens and the border firms up, so an ignored nudge gets harder to
  // keep ignoring rather than just quietly vanishing. Every other face passes
  // no urgency and renders exactly as before.
  const urg = state && typeof state.urgency === 'number'
    ? Math.max(0, Math.min(1, state.urgency))
    : 0;
  const S = 144;
  const raw = String(label);
  const lbl = esc(raw.slice(0, 12));
  const lblSize = raw.length > 8 ? 17 : 20;
  const haloHi = hslToHex(hue, sat, 58 + 12 * urg);
  const haloLo = hslToHex(hue, sat, 45 + 8 * urg);
  const ring = hslToHex(hue, sat, 65 + 10 * urg);
  const haloOpacity = (0.62 + 0.33 * urg).toFixed(2);
  const ringOpacity = (0.3 + 0.5 * urg).toFixed(2);
  const ringWidth = (1.5 + 1.5 * urg).toFixed(1);
  const badgeFill = hslToHex(hue, 80, 80);

  // Shared niche geometry: the hairline border and the progress fill trace the
  // exact same rounded rect, so they read as one frame — keep them off the same
  // constants rather than two copies of the literals that could drift (#64 review).
  const frameR = 17, frameX = 6, frameY = 6, frameW = S - 12, frameH = S - 12;

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
    progressFrame +
    `<text x="${S / 2}" y="76" text-anchor="middle" font-size="62" ` +
    `font-family="'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif">${esc(emoji)}</text>` +
    `<text x="${S / 2 + 1}" y="117" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="'Segoe UI',Arial,sans-serif" fill="#000000" fill-opacity="0.55">${lbl}</text>` +
    `<text x="${S / 2}" y="116" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="'Segoe UI',Arial,sans-serif" fill="#e9edf4">${lbl}</text>` +
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
