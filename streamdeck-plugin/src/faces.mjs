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

export function face(emoji, label, hue, badge, sat = 72) {
  const S = 144;
  const raw = String(label);
  const lbl = esc(raw.slice(0, 12));
  const lblSize = raw.length > 8 ? 17 : 20;
  const haloHi = hslToHex(hue, sat, 58);
  const haloLo = hslToHex(hue, sat, 45);
  const ring = hslToHex(hue, sat, 65);
  const badgeFill = hslToHex(hue, 80, 80);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<defs>` +
    `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#141827"/><stop offset="1" stop-color="#0a0c13"/>` +
    `</linearGradient>` +
    `<radialGradient id="h" cx="0.5" cy="0.36" r="0.62">` +
    `<stop offset="0" stop-color="${haloHi}" stop-opacity="0.62"/>` +
    `<stop offset="0.42" stop-color="${haloLo}" stop-opacity="0.18"/>` +
    `<stop offset="1" stop-color="${haloLo}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${S}" height="${S}" fill="url(#b)"/>` +
    `<rect width="${S}" height="${S}" fill="url(#h)"/>` +
    `<rect x="6" y="6" width="${S - 12}" height="${S - 12}" rx="17" fill="none" stroke="${ring}" stroke-opacity="0.30" stroke-width="1.5"/>` +
    `<text x="${S / 2}" y="76" text-anchor="middle" font-size="62" ` +
    `font-family="'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif">${esc(emoji)}</text>` +
    `<text x="${S / 2 + 1}" y="117" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="'Segoe UI',Arial,sans-serif" fill="#000000" fill-opacity="0.55">${lbl}</text>` +
    `<text x="${S / 2}" y="116" text-anchor="middle" font-size="${lblSize}" font-weight="600" ` +
    `font-family="'Segoe UI',Arial,sans-serif" fill="#e9edf4">${lbl}</text>` +
    (badge
      ? `<text x="${S - 10}" y="18" text-anchor="end" font-size="11" font-weight="700" ` +
        `font-family="'Segoe UI',Arial,sans-serif" fill="${badgeFill}" fill-opacity="0.9">${esc(badge)}</text>`
      : '') +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
