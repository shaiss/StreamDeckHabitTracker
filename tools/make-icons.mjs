#!/usr/bin/env node
// Renders key icon PNGs in the "Nocturne Ritual" language (design/PHILOSOPHY.md):
// a deep night base, a votive halo in the habit's own hue, a hairline inner
// ring, one oversized glyph, a whispered label. Habit hue comes from the same
// name-hash the Stream Deck plugin uses, so baked icons and live-rendered
// faces are one family. Output -> icons/<name>.png (576x576).
//
//   npm i playwright-core --no-save   # one-time, if regenerating
//   node tools/make-icons.mjs

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXE =
  process.env.CHROME_PATH ||
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const SIZE = 288;

// Identical to the plugin's hueFor() — hue is the habit's identity for life.
export function hueFor(name) {
  // FNV-1a for spread, then skip the reserved violet band [245,285) — violet
  // always means "the coach speaking", never a habit.
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let hue = h % 320;
  if (hue >= 245) hue += 40;
  return hue;
}

const VIOLET = 262; // reserved: the coach speaking
const SILVER = 222; // neutral (stats)

export function nocturneFace(emoji, label, hue, { badge = '', sat = 72 } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${SIZE}px;height:${SIZE}px;overflow:hidden;
      background:linear-gradient(180deg,#141827 0%,#0a0c13 100%)}
    .halo{position:absolute;inset:0;
      background:radial-gradient(circle at 50% 36%, hsla(${hue},${sat}%,58%,.62) 0%, hsla(${hue},${sat}%,45%,.18) 42%, transparent 68%)}
    .frame{position:absolute;inset:12px;border:2px solid hsla(${hue},${sat}%,65%,.30);border-radius:34px}
    .k{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:6px;padding-bottom:18px;
       font-family:'DejaVu Sans','Liberation Sans',sans-serif}
    .e{font-size:132px;line-height:1;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45))}
    .l{font-size:${label.length > 8 ? 27 : 33}px;font-weight:600;color:#e9edf4;
       letter-spacing:.05em;text-shadow:0 2px 6px rgba(0,0,0,.6)}
    .b{position:absolute;top:22px;right:26px;font-size:20px;font-weight:700;
       letter-spacing:.06em;color:hsla(${hue},80%,80%,.9)}
  </style></head><body>
    <div class="halo"></div><div class="frame"></div>
    <div class="k"><div class="e">${emoji}</div><div class="l">${label}</div></div>
    ${badge ? `<div class="b">${badge}</div>` : ''}
  </body></html>`;
}

// Allow import without side effects (make-animations reuses the template).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(ROOT, 'icons'), { recursive: true });
  const { habits } = JSON.parse(readFileSync(join(ROOT, 'config/habits.json'), 'utf8'));

  const jobs = habits.map((h) => ({
    name: h.name, emoji: h.emoji, label: h.label, hue: hueFor(h.name), opts: {}
  }));
  jobs.push({ name: '_dashboard', emoji: '📊', label: 'Stats', hue: SILVER, opts: { sat: 26 } });
  for (let n = 1; n <= 4; n++) {
    jobs.push({ name: `Slot${n}`, emoji: '✨', label: `AI ${n}`, hue: VIOLET, opts: { badge: 'AI' } });
  }

  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
  for (const j of jobs) {
    await page.setContent(nocturneFace(j.emoji, j.label, j.hue, j.opts), { waitUntil: 'load' });
    await page.screenshot({ path: join(ROOT, 'icons', `${j.name}.png`) });
    console.log('  wrote icons/' + j.name + '.png');
  }
  await browser.close();
  console.log('Done: ' + jobs.length + ' icons.');
}
