#!/usr/bin/env node
// Renders a key icon PNG for each habit (+ a dashboard icon) with the
// pre-installed Chromium, driven by playwright-core for an exact viewport.
// Full-color emoji + label on a per-habit gradient. Output -> icons/<name>.png.
//
//   npm i playwright-core --no-save   # one-time, if regenerating
//   node tools/make-icons.mjs
//
// Icons are 288x288 CSS rendered at 2x -> 576x576 PNG (crisp; Stream Deck
// downsamples to the key size).

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

const COLORS = {
  Pee: ['#f6c445', '#d68a06'],
  Poop: ['#a9764e', '#5e3a20'],
  Eat: ['#ff7a59', '#e03a2f'],
  Drink: ['#5aa0ff', '#2160e6'],
  Exercise: ['#4fd98a', '#12915a'],
  _dashboard: ['#9aa0aa', '#3a3f47'],
  _default: ['#6b7280', '#374151']
};

function iconHtml(emoji, label, [c1, c2]) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${SIZE}px;height:${SIZE}px;overflow:hidden;
      background:radial-gradient(circle at 50% 33%, ${c1}, ${c2})}
    .k{position:absolute;inset:0;display:flex;flex-direction:column;
       align-items:center;justify-content:center;gap:2px;padding-bottom:20px;
       font-family:'DejaVu Sans','Liberation Sans',sans-serif}
    .e{font-size:150px;line-height:1;filter:drop-shadow(0 5px 7px rgba(0,0,0,.35))}
    .l{font-size:${label.length > 7 ? 34 : 46}px;font-weight:700;color:#fff;
       letter-spacing:.5px;text-shadow:0 2px 6px rgba(0,0,0,.55)}
  </style></head><body><div class="k"><div class="e">${emoji}</div><div class="l">${label}</div></div></body></html>`;
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });
const { habits } = JSON.parse(readFileSync(join(ROOT, 'config/habits.json'), 'utf8'));

const jobs = habits.map((h) => ({
  name: h.name, emoji: h.emoji, label: h.label, colors: COLORS[h.name] || COLORS._default
}));
jobs.push({ name: '_dashboard', emoji: '📊', label: 'Stats', colors: COLORS._dashboard });
// Generic faces for the AI slot keys (used by the Web Requests flavor, where
// the key can't repaint itself; the dashboard shows what each slot means).
for (let n = 1; n <= 4; n++) {
  jobs.push({ name: `Slot${n}`, emoji: '✨', label: `AI ${n}`, colors: ['#8b5cf6', '#5b21b6'] });
}

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
for (const j of jobs) {
  await page.setContent(iconHtml(j.emoji, j.label, j.colors), { waitUntil: 'load' });
  await page.screenshot({ path: join(ROOT, 'icons', `${j.name}.png`) });
  console.log('  wrote icons/' + j.name + '.png');
}
await browser.close();
console.log('Done: ' + jobs.length + ' icons.');
