#!/usr/bin/env node
// Renders the plugin's manifest images and packages the .sdPlugin folder into
// public/downloads/com.shaiss.habit-tracker.streamDeckPlugin (a zip).
//
// Build pins live in package.json devDependencies (+ overrides.ws) so a clean
// checkout reproduces bin/plugin.js (#108):
//
//   rm -rf node_modules && npm ci
//   npm run build:plugin          # == node tools/build-plugin.mjs --no-images
//
// Verified sha256 of bin/plugin.js from that path on this tip (two clean
// rebuilds byte-identical):
//   a50e4ce517c6fbca3876cf453f865bab54faccdd381805c551697ccd8b29908c
// (Hash is tree-dependent — re-verify after merging source changes that
// affect the plugin bundle.)
//
// Full image regenerate (needs Chromium at CHROME_PATH or /opt/pw-browsers):
//   node tools/build-plugin.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { zip } from './lib-zip.mjs';
import { bundlePlugin } from './bundle-plugin.mjs';
import { scanFile } from './lib-secret-scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PLUGIN_DIR = join(ROOT, 'streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin');
const IMAGES = join(PLUGIN_DIR, 'images');
const EXE =
  process.env.CHROME_PATH ||
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

function tile(emoji, hue, size, label, sat = 72) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden;
    background:linear-gradient(180deg,#141827 0%,#0a0c13 100%)}
    .halo{position:absolute;inset:0;background:radial-gradient(circle at 50% 38%, hsla(${hue},${sat}%,58%,.6) 0%, transparent 68%)}
    .w{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-family:'DejaVu Sans',sans-serif}
    .e{font-size:${Math.round(size * (label ? 0.42 : 0.56))}px;line-height:1;
       filter:drop-shadow(0 ${size / 48}px ${size / 36}px rgba(0,0,0,.45))}
    .l{font-size:${Math.round(size * 0.14)}px;font-weight:600;color:#e9edf4;margin-top:${size / 36}px;
       letter-spacing:.04em;text-shadow:0 2px 4px rgba(0,0,0,.55)}
  </style></head><body><div class="halo"></div><div class="w"><div class="e">${emoji}</div>${label ? `<div class="l">${label}</div>` : ''}</div></body></html>`;
}

const VIOLET = 262;
const SILVER = 222;

const assets = [
  { file: 'plugin.png', size: 144, emoji: '✅', hue: VIOLET, label: '' },
  { file: 'category.png', size: 46, emoji: '✅', hue: VIOLET, label: '' },
  { file: 'habit_action.png', size: 40, emoji: '✅', hue: SILVER, label: '', sat: 26 },
  { file: 'slot_action.png', size: 40, emoji: '✨', hue: VIOLET, label: '' },
  { file: 'habit_key.png', size: 144, emoji: '✅', hue: SILVER, label: 'Habit', sat: 26 },
  { file: 'slot_key.png', size: 144, emoji: '✨', hue: VIOLET, label: 'AI Slot' },
  { file: 'coach_action.png', size: 40, emoji: '🧭', hue: VIOLET, label: '' },
  { file: 'coach_key.png', size: 144, emoji: '🧭', hue: VIOLET, label: 'Coach' }
];

// --no-images: bundle + repackage WITHOUT re-rendering the manifest art.
// The committed baseline was rendered against Noto Color Emoji; a machine with
// Segoe UI Emoji (any Windows box) produces visibly different tiles, so a
// plugin-code change made there would silently rewrite the art as a side
// effect. Rebuild images only where the baseline font lives.
const renderImages = !process.argv.includes('--no-images');
if (renderImages) {
  mkdirSync(IMAGES, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const a of assets) {
    const page = await browser.newPage({ viewport: { width: a.size, height: a.size }, deviceScaleFactor: 1 });
    await page.setContent(tile(a.emoji, a.hue, a.size, a.label, a.sat ?? 72), { waitUntil: 'load' });
    await page.screenshot({ path: join(IMAGES, a.file) });
    await page.close();
    console.log('  rendered images/' + a.file);
  }
  await browser.close();
} else {
  console.log('  skipped image render (--no-images)');
}

await bundlePlugin();
console.log('  bundled bin/plugin.js');

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
  name: 'com.shaiss.habit-tracker.sdPlugin/' + relative(PLUGIN_DIR, p).split('\\').join('/'),
  data: readFileSync(p)
}));
// Hard stop (#112 prep): the zip is public. If any packaged file carries key
// material (a keyed profile copied into profiles/, a literal x-habit-key),
// refuse to build rather than ship it.
const leaks = entries.flatMap((e) => scanFile(e.name, e.data));
if (leaks.length) {
  console.error('Refusing to package: key-like material found:\n' +
    leaks.map((h) => '  ' + h.file + (h.line ? ':' + h.line : '') + ' (' + h.rule + ')').join('\n'));
  process.exit(1);
}
mkdirSync(join(ROOT, 'public/downloads'), { recursive: true });
const out = join(ROOT, 'public/downloads/com.shaiss.habit-tracker.streamDeckPlugin');
writeFileSync(out, zip(entries));
console.log(`Packaged ${entries.length} files -> ${relative(ROOT, out)}`);
