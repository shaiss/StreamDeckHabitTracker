#!/usr/bin/env node
// Renders an animated GIF key icon per habit (+ the Stats key) at 288x288.
// Chromium (playwright-core) draws CSS keyframe animations; each frame is
// captured by seeking the Web Animations API clock (deterministic, no timing
// jitter), decoded with pngjs, and assembled into a palette-quantized,
// infinitely-looping GIF with gifenc. Output -> icons/animated/<name>.gif
//
//   npm i playwright-core pngjs gifenc --no-save   # one-time, if regenerating
//   node tools/make-animations.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXE =
  process.env.CHROME_PATH ||
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const SIZE = 288;      // GIF pixel size (Stream Deck downsamples to the key)
const FRAMES = 24;     // frames per loop
const FPS = 12.5;      // 24 / 12.5 = 1.92s loop
const DUR_MS = (FRAMES / FPS) * 1000;
const DELAY_MS = 1000 / FPS; // per-frame GIF delay

const COLORS = {
  Pee: ['#f6c445', '#d68a06'],
  Poop: ['#a9764e', '#5e3a20'],
  Eat: ['#ff7a59', '#e03a2f'],
  Drink: ['#5aa0ff', '#2160e6'],
  Exercise: ['#4fd98a', '#12915a'],
  _dashboard: ['#9aa0aa', '#3a3f47'],
  _default: ['#6b7280', '#374151']
};

// Per-habit motion. Every @keyframes must start and end on the same pose so
// the loop is seamless. All animations run with duration DUR_MS, infinite.
const MOTIONS = {
  // gentle side-to-side rock
  Pee: `.e{animation:rock ${DUR_MS}ms ease-in-out infinite}
        @keyframes rock{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-7deg)}75%{transform:rotate(7deg)}}`,
  // squash-and-stretch bounce
  Poop: `.e{animation:boing ${DUR_MS}ms ease-in-out infinite;transform-origin:50% 100%}
         @keyframes boing{0%,100%{transform:translateY(0) scale(1,1)}30%{transform:translateY(-16px) scale(.96,1.05)}50%{transform:translateY(0) scale(1.06,.92)}65%{transform:translateY(-6px) scale(.99,1.02)}80%{transform:translateY(0) scale(1,1)}}`,
  // appetite pulse + tilt
  Eat: `.e{animation:munch ${DUR_MS}ms ease-in-out infinite}
        @keyframes munch{0%,100%{transform:scale(1) rotate(0deg)}25%{transform:scale(1.1) rotate(-5deg)}50%{transform:scale(1) rotate(0deg)}75%{transform:scale(1.1) rotate(5deg)}}`,
  // droplet bobs while a ripple ring expands beneath it
  Drink: `.e{animation:bob ${DUR_MS}ms ease-in-out infinite}
          @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-18px)}}
          .fx{position:absolute;left:50%;top:63%;width:120px;height:34px;margin-left:-60px;
              border:6px solid rgba(255,255,255,.65);border-radius:50%;
              animation:ripple ${DUR_MS}ms ease-out infinite}
          @keyframes ripple{0%,45%{transform:scale(.25);opacity:0}55%{opacity:.8}100%{transform:scale(1.15);opacity:0}}`,
  // runner bounce with a ground shadow that squashes in counterpoint
  Exercise: `.e{animation:run ${DUR_MS}ms ease-in-out infinite}
             @keyframes run{0%,100%{transform:translateY(0) rotate(0deg)}25%{transform:translateY(-14px) rotate(-3deg)}50%{transform:translateY(0) rotate(0deg)}75%{transform:translateY(-14px) rotate(3deg)}}
             .fx{position:absolute;left:50%;top:66%;width:110px;height:20px;margin-left:-55px;
                 background:rgba(0,0,0,.28);border-radius:50%;filter:blur(6px);
                 animation:shadow ${DUR_MS}ms ease-in-out infinite}
             @keyframes shadow{0%,50%,100%{transform:scale(1)}25%,75%{transform:scale(.72);opacity:.6}}`,
  _default: `.e{animation:pulse ${DUR_MS}ms ease-in-out infinite}
             @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}`
};

function habitHtml(emoji, label, [c1, c2], motionCss) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${SIZE}px;height:${SIZE}px;overflow:hidden;
      background:radial-gradient(circle at 50% 33%, ${c1}, ${c2})}
    .k{position:absolute;inset:0;display:flex;flex-direction:column;
       align-items:center;justify-content:center;gap:2px;padding-bottom:20px;
       font-family:'DejaVu Sans','Liberation Sans',sans-serif}
    .e{font-size:150px;line-height:1;filter:drop-shadow(0 5px 7px rgba(0,0,0,.35));z-index:2}
    .l{font-size:${label.length > 7 ? 34 : 46}px;font-weight:700;color:#fff;
       letter-spacing:.5px;text-shadow:0 2px 6px rgba(0,0,0,.55);z-index:2}
    ${motionCss}
  </style></head><body><div class="k"><div class="fx"></div><div class="e">${emoji}</div><div class="l">${label}</div></div></body></html>`;
}

// Stats key: real CSS bars that grow in a staggered loop (no emoji needed).
function statsHtml([c1, c2]) {
  const bar = (x, h, color, delayFrac) =>
    `.b${x}{left:${x}px;background:${color};--h:${h}px;animation-delay:${Math.round(-DUR_MS * delayFrac)}ms}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${SIZE}px;height:${SIZE}px;overflow:hidden;
      background:radial-gradient(circle at 50% 33%, ${c1}, ${c2})}
    .k{position:absolute;inset:0;font-family:'DejaVu Sans','Liberation Sans',sans-serif}
    .bar{position:absolute;bottom:104px;width:44px;border-radius:8px 8px 3px 3px;
         height:var(--h);transform-origin:50% 100%;
         box-shadow:0 4px 10px rgba(0,0,0,.3);
         animation:grow ${DUR_MS}ms ease-in-out infinite}
    @keyframes grow{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
    .base{position:absolute;left:44px;right:44px;bottom:96px;height:6px;
          background:rgba(255,255,255,.85);border-radius:3px}
    ${bar(62, 120, '#8bd450', 0)}
    ${bar(122, 150, '#ff6a5e', 0.18)}
    ${bar(182, 96, '#54a8ff', 0.36)}
    .l{position:absolute;left:0;right:0;bottom:26px;text-align:center;
       font-size:46px;font-weight:700;color:#fff;letter-spacing:.5px;
       text-shadow:0 2px 6px rgba(0,0,0,.55)}
  </style></head><body><div class="k">
    <div class="bar b62"></div><div class="bar b122"></div><div class="bar b182"></div>
    <div class="base"></div><div class="l">Stats</div>
  </div></body></html>`;
}

async function captureGif(page, html, outPath, probeDir) {
  await page.setContent(html, { waitUntil: 'load' });
  // Pause every animation, then seek the shared clock frame by frame.
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  const gif = GIFEncoder(); // writes an infinite-loop NETSCAPE ext by default
  for (let i = 0; i < FRAMES; i++) {
    const t = (i / FRAMES) * DUR_MS;
    await page.evaluate((ms) => {
      document.getAnimations().forEach((a) => (a.currentTime = ms));
    }, t);
    const buf = await page.screenshot();
    const { data, width, height } = PNG.sync.read(buf); // RGBA bytes
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      delay: DELAY_MS
    });
    // Keep two raw frames per icon for visual QA.
    if (probeDir && (i === 0 || i === FRAMES / 2)) {
      writeFileSync(join(probeDir, `${outPath.split('/').pop()}.f${i}.png`), buf);
    }
  }
  gif.finish();
  writeFileSync(outPath, gif.bytes());
}

const OUT = join(ROOT, 'icons/animated');
mkdirSync(OUT, { recursive: true });
const { habits } = JSON.parse(readFileSync(join(ROOT, 'config/habits.json'), 'utf8'));
// Probe frames for visual QA go to the scratchpad if provided, else skipped.
const probeDir = process.env.PROBE_DIR || '';
if (probeDir) mkdirSync(probeDir, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });

for (const h of habits) {
  const colors = COLORS[h.name] || COLORS._default;
  const motion = MOTIONS[h.name] || MOTIONS._default;
  await captureGif(page, habitHtml(h.emoji, h.label, colors, motion), join(OUT, `${h.name}.gif`), probeDir);
  console.log(`  wrote icons/animated/${h.name}.gif`);
}
await captureGif(page, statsHtml(COLORS._dashboard), join(OUT, '_dashboard.gif'), probeDir);
console.log('  wrote icons/animated/_dashboard.gif');

await browser.close();
console.log(`Done: ${habits.length + 1} GIFs (${FRAMES} frames @ ${FPS}fps, ${(DUR_MS / 1000).toFixed(2)}s loop).`);
