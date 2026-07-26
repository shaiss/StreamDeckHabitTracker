#!/usr/bin/env node
// Renders the plugin's manifest images and packages the .sdPlugin folder into
// public/downloads/com.kalmansforge.habit-tracker.streamDeckPlugin (a zip).
//
//   npm i playwright-core --no-save   # one-time, if regenerating
//   node tools/build-plugin.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { zip } from './lib-zip.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PLUGIN_DIR = join(ROOT, 'streamdeck-plugin/com.kalmansforge.habit-tracker.sdPlugin');
const IMAGES = join(PLUGIN_DIR, 'images');
const EXE =
  process.env.CHROME_PATH ||
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

function tile(emoji, [c1, c2], size, label) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden;
    background:radial-gradient(circle at 50% 36%, ${c1}, ${c2})}
    .w{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-family:'DejaVu Sans',sans-serif}
    .e{font-size:${Math.round(size * (label ? 0.44 : 0.58))}px;line-height:1;
       filter:drop-shadow(0 ${size / 48}px ${size / 36}px rgba(0,0,0,.35))}
    .l{font-size:${Math.round(size * 0.15)}px;font-weight:700;color:#fff;margin-top:${size / 36}px;
       text-shadow:0 2px 4px rgba(0,0,0,.5)}
  </style></head><body><div class="w"><div class="e">${emoji}</div>${label ? `<div class="l">${label}</div>` : ''}</div></body></html>`;
}

const VIOLET = ['#8b5cf6', '#5b21b6'];
const GRAY = ['#9aa0aa', '#3a3f47'];

const assets = [
  { file: 'plugin.png', size: 144, emoji: '✅', colors: VIOLET, label: '' },
  { file: 'category.png', size: 46, emoji: '✅', colors: VIOLET, label: '' },
  { file: 'habit_action.png', size: 40, emoji: '✅', colors: GRAY, label: '' },
  { file: 'slot_action.png', size: 40, emoji: '✨', colors: VIOLET, label: '' },
  { file: 'habit_key.png', size: 144, emoji: '✅', colors: GRAY, label: 'Habit' },
  { file: 'slot_key.png', size: 144, emoji: '✨', colors: VIOLET, label: 'AI Slot' }
];

mkdirSync(IMAGES, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
for (const a of assets) {
  const page = await browser.newPage({ viewport: { width: a.size, height: a.size }, deviceScaleFactor: 1 });
  await page.setContent(tile(a.emoji, a.colors, a.size, a.label), { waitUntil: 'load' });
  await page.screenshot({ path: join(IMAGES, a.file) });
  await page.close();
  console.log('  rendered images/' + a.file);
}
await browser.close();

// Package: zip everything under the .sdPlugin folder, folder name included.
function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const entries = walk(PLUGIN_DIR).map((p) => ({
  name: 'com.kalmansforge.habit-tracker.sdPlugin/' + relative(PLUGIN_DIR, p).split('\\').join('/'),
  data: readFileSync(p)
}));
mkdirSync(join(ROOT, 'public/downloads'), { recursive: true });
const out = join(ROOT, 'public/downloads/com.kalmansforge.habit-tracker.streamDeckPlugin');
writeFileSync(out, zip(entries));
console.log(`Packaged ${entries.length} files -> ${relative(ROOT, out)}`);
