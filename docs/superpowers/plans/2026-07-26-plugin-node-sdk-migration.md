# Stream Deck Plugin → Node.js SDK Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy HTML/QtWebEngine plugin runtime with Elgato's modern Node.js SDK (`@elgato/streamdeck` 2.1.0), preserving both action UUIDs, the settings shape, the server API, and profile compatibility — eliminating the entire hidden-page/Worker/renderer-crash failure class.

**Architecture:** The plugin becomes a Node process the Stream Deck app spawns (no embedded browser). Source lives in `streamdeck-plugin/src/` as three focused ESM modules — `faces.mjs` (pure SVG key-face generator), `scheduler.mjs` (pure wall-clock deadline bookkeeping), `plugin.mjs` (SDK wiring + poll/tap/render) — bundled by esbuild into `com.shaiss.habit-tracker.sdPlugin/bin/plugin.js` (a committed artifact, like everything in `public/downloads/`). Key faces switch from canvas-PNG to SVG data URIs rendered by the Stream Deck app. The poll architecture (deadlines, single-flight guard with expiry, tap-recheck chain, `?deck=` heartbeat) ports as-is because it defends against hung backends, not just throttled pages.

**Tech Stack:** Node 24 runtime (Stream Deck-bundled), `@elgato/streamdeck` 2.1.0 (build-time dep, bundled), esbuild (build-time), `ws` (test-only, arrives as SDK dep), node:test.

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript, no framework — plain `.mjs` source.
- `package.json` runtime deps stay untouched (Vercel build must stay trivial). SDK + esbuild are tool deps installed `--no-save`: `npm i playwright-core pngjs gifenc esbuild @elgato/streamdeck --no-save`.
- Action UUIDs frozen: `com.shaiss.habit-tracker.habit`, `com.shaiss.habit-tracker.slot`.
- Settings shapes frozen: habit `{ base, index, key? }`, slot `{ base, slot, key? }` (what `tools/generate.mjs` writes into profiles).
- Server query contract frozen: taps `GET <base>/api/log?hkey=<index+1>|slot=<n>[&key=]`; polls `GET <base>/api/slots?deck=<version>&keys=<n>[&key=]`.
- Hue formula parity: plugin faces must use `tools/lib-hue.mjs` (FNV-1a, `% 320`, violet-band skip at 245) — `tests/unit/hue.test.mjs` guards this.
- Manifest: `Version` 2.0.0, `CodePath` `bin/plugin.js`, `Nodejs: { "Version": "24" }`, `Software.MinimumVersion` `"7.1"` (Node-SDK floor per Elgato docs; target machine runs 7.5.0).
- Unit tests stay zero-dependency (`npm test` must pass with no `npm install`); only e2e may import installed packages.
- Built artifacts are committed: `bin/plugin.js`, `public/downloads/*.streamDeckPlugin`, profile. They never rebuild themselves.
- `tools/setup.ps1` and `tools/generate.mjs` are NOT modified (zip layout and Settings shape are unchanged).
- Unicode escapes (`\u{1F6BD}` style not needed — source files may contain emoji literals like existing code does).

---

### Task 1: `faces.mjs` — pure SVG key-face generator

**Files:**
- Create: `streamdeck-plugin/src/faces.mjs`
- Create: `tests/unit/faces.test.mjs`
- Modify: `tests/unit/hue.test.mjs:19` (drift guard repoint)

**Interfaces:**
- Consumes: `hueFor(name)` from `tools/lib-hue.mjs` (exists).
- Produces: `face(emoji, label, hue, badge, sat = 72) → string` (a `data:image/svg+xml;base64,…` URI), re-export of `hueFor`. Used by Task 3/4's `plugin.mjs`.

Design notes for the implementer: this ports `face()` from the old canvas code (`app.js:318-361`) to SVG. HSL colors are pre-converted to hex because SVG rasterizers vary in `hsl()`/`hsla()` support. The label shadow becomes a dark offset text copy (no SVG `<filter>` — support is uncertain in the app's rasterizer). All interpolated text is XML-escaped: habit labels/emoji are AI-generated strings.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/faces.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { face, hueFor } from '../../streamdeck-plugin/src/faces.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/faces.test.mjs`
Expected: FAIL — `Cannot find module ...streamdeck-plugin/src/faces.mjs`

- [ ] **Step 3: Write the implementation**

```js
// streamdeck-plugin/src/faces.mjs
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
```

- [ ] **Step 4: Repoint the hue drift guard**

In `tests/unit/hue.test.mjs`, replace the third test with:

```js
test('plugin and virtual deck embed the identical FNV-1a formula (drift guard)', () => {
  // The Node plugin imports the shared module instead of embedding a copy —
  // assert the import so a future rewrite can't silently fork the formula.
  const faces = readFileSync(new URL('../../streamdeck-plugin/src/faces.mjs', import.meta.url), 'utf8');
  assert.ok(faces.includes("from '../../tools/lib-hue.mjs'"), 'faces.mjs must import the shared hue formula');
  for (const f of ['public/deck.html', 'tools/lib-hue.mjs']) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    for (const marker of ['2166136261', '16777619', '% 320', '245']) {
      assert.ok(src.includes(marker), `${f} missing hue-formula marker ${marker}`);
    }
  }
});
```

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS (all suites, including the repointed drift guard — `app.js` still exists at this point but is no longer referenced by tests).

- [ ] **Step 6: Commit**

```bash
git add streamdeck-plugin/src/faces.mjs tests/unit/faces.test.mjs tests/unit/hue.test.mjs
git commit -m "feat(plugin): SVG key-face generator sharing the canonical hue formula"
```

---

### Task 2: `scheduler.mjs` — wall-clock deadline bookkeeping

**Files:**
- Create: `streamdeck-plugin/src/scheduler.mjs`
- Create: `tests/unit/scheduler.test.mjs`

**Interfaces:**
- Produces: `createScheduler({ pollMs, timeoutMs, recheckMs }) → { pump(now), pollStarted(now), pollSettled(seq), tapped(now), forcePoll() }`. `pump(now)` returns `{ expired: boolean, poll: boolean }`. Used by Task 4's `plugin.mjs`.

Design notes: this is the old `pump()`/`refreshSlots()` guard state (`app.js:220-268`) extracted pure. In Node timers are reliable, but the deadline design still defends against a *hung backend*: the single-flight guard is a deadline, a stuck poll expires and is retried, and its late settle is orphaned by a sequence number. Tap rechecks stay because the coach's reactive pass lands seconds after `/api/log` answers.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/scheduler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../streamdeck-plugin/src/scheduler.mjs';

const mk = () => createScheduler({ pollMs: 15000, timeoutMs: 10000, recheckMs: [2000, 5000] });

test('polls immediately at boot, then honors the poll interval', () => {
  const s = mk();
  assert.deepEqual(s.pump(1000), { expired: false, poll: true });
  const seq = s.pollStarted(1000);
  assert.equal(s.pump(2000).poll, false, 'in-flight blocks a second poll');
  assert.ok(s.pollSettled(seq));
  assert.equal(s.pump(3000).poll, false, 'not due again until pollMs elapses');
  assert.equal(s.pump(16001).poll, true);
});

test('a hung poll expires after timeoutMs, is retried, and its late settle is orphaned', () => {
  const s = mk();
  s.pump(1000);
  const stuck = s.pollStarted(1000);
  assert.equal(s.pump(9000).expired, false, 'not expired yet');
  const r = s.pump(11001);
  assert.equal(r.expired, true, 'guard expired');
  assert.equal(r.poll, true, 'retry allowed in the same pump');
  const retry = s.pollStarted(11001);
  assert.equal(s.pollSettled(stuck), false, 'late settle of the orphan is ignored');
  assert.ok(s.pollSettled(retry), 'the retry settles normally');
});

test('a tap forces an immediate poll and schedules the recheck chain', () => {
  const s = mk();
  s.pump(1000);
  s.pollSettled(s.pollStarted(1000));   // routine poll done; next due at 16000
  s.tapped(2000);
  assert.equal(s.pump(2001).poll, true, 'tap zeroes the routine deadline');
  s.pollSettled(s.pollStarted(2001));   // next routine poll now due at 17001
  assert.equal(s.pump(3000).poll, false);
  assert.equal(s.pump(4001).poll, true, 'first recheck (tap+2000) came due');
  s.pollSettled(s.pollStarted(4001));
  assert.equal(s.pump(7001).poll, true, 'second recheck (tap+5000) came due');
});

test('forcePoll zeroes the routine deadline (wake/device-connect path)', () => {
  const s = mk();
  s.pump(1000);
  s.pollSettled(s.pollStarted(1000));
  s.forcePoll();
  assert.equal(s.pump(1002).poll, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/scheduler.test.mjs`
Expected: FAIL — `Cannot find module ...streamdeck-plugin/src/scheduler.mjs`

- [ ] **Step 3: Write the implementation**

```js
// streamdeck-plugin/src/scheduler.mjs
// Wall-clock deadline bookkeeping for the slot poll — the pure core of the old
// page pump(). Every guard is a deadline, never a boolean: a backend that
// accepts a connection and goes silent must not be able to wedge the sync.
// `seq` orphans a stuck poll so its late settle can't clear the guard that now
// belongs to the retry.
export function createScheduler({ pollMs, timeoutMs, recheckMs }) {
  let nextPollAt = 0;      // routine-poll deadline; 0 = due now
  let rechecks = [];       // wall-clock deadlines queued by taps
  let inflightAt = 0;      // when the in-flight poll started; 0 = idle
  let seq = 0;             // poll generation

  return {
    pump(now) {
      let expired = false;
      if (inflightAt && now - inflightAt > timeoutMs) {
        inflightAt = 0;
        seq++;             // orphan the stuck poll
        expired = true;
      }
      let due = now >= nextPollAt;
      rechecks = rechecks.filter((t) => {
        if (now >= t) { due = true; return false; }
        return true;
      });
      return { expired, poll: due && !inflightAt };
    },
    pollStarted(now) {
      inflightAt = now;
      nextPollAt = now + pollMs;
      return ++seq;
    },
    pollSettled(s) {
      if (s !== seq) return false;   // pump() already gave up on this poll
      inflightAt = 0;
      return true;
    },
    tapped(now) {
      nextPollAt = 0;
      for (const d of recheckMs) rechecks.push(now + d);
    },
    forcePoll() { nextPollAt = 0; }
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/scheduler.test.mjs` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add streamdeck-plugin/src/scheduler.mjs tests/unit/scheduler.test.mjs
git commit -m "feat(plugin): pure wall-clock poll scheduler (single-flight deadline + tap rechecks)"
```

---

### Task 3: Manifest v2, esbuild bundler, and a hardware smoke spike

**Files:**
- Create: `tools/bundle-plugin.mjs`
- Create: `streamdeck-plugin/src/plugin.mjs` (skeleton — evolves in Task 4)
- Modify: `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/manifest.json`
- Create (generated, committed): `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js`

**Interfaces:**
- Produces: `bundlePlugin() → Promise<string>` (outfile path) exported from `tools/bundle-plugin.mjs`; also runnable as `node tools/bundle-plugin.mjs`. Consumed by Task 4's e2e (bundle smoke), Task 5's `build-plugin.mjs`.

This task exists to de-risk the ONE open rendering question early: does the Stream Deck app rasterize our SVG (gradients + color emoji via Segoe UI Emoji) acceptably on a real key? Everything else in the migration is mechanical.

- [ ] **Step 1: Install tool deps**

Run: `npm i esbuild @elgato/streamdeck --no-save`
Expected: installs cleanly; `package.json` unchanged (verify with `git diff package.json` → empty).

- [ ] **Step 2: Update the manifest**

Replace `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/manifest.json` with:

```json
{
  "SDKVersion": 2,
  "Author": "shaiss",
  "Name": "Habit Tracker AI",
  "Description": "Logs habit taps to your Habit Tracker endpoint. AI Slot keys repaint themselves automatically when the AI coach assigns new habits.",
  "URL": "https://github.com/shaiss/StreamDeckHabitTracker",
  "Version": "2.0.0",
  "CodePath": "bin/plugin.js",
  "Nodejs": { "Version": "24" },
  "Icon": "images/plugin",
  "Category": "Habit Tracker",
  "CategoryIcon": "images/category",
  "OS": [
    { "Platform": "windows", "MinimumVersion": "10" },
    { "Platform": "mac", "MinimumVersion": "12" }
  ],
  "Software": { "MinimumVersion": "7.1" },
  "Actions": [
    {
      "UUID": "com.shaiss.habit-tracker.habit",
      "Name": "Habit Key",
      "Tooltip": "Logs one tap of a fixed habit.",
      "Icon": "images/habit_action",
      "SupportedInMultiActions": false,
      "States": [{ "Image": "images/habit_key" }]
    },
    {
      "UUID": "com.shaiss.habit-tracker.slot",
      "Name": "AI Slot Key",
      "Tooltip": "Logs whatever habit the AI coach currently assigns to this slot. The key face updates automatically.",
      "Icon": "images/slot_action",
      "SupportedInMultiActions": false,
      "States": [{ "Image": "images/slot_key" }]
    }
  ]
}
```

(Version → 2.0.0 — new major runtime. Software floor 7.1 per Elgato's Node-SDK requirement. Mac floor 12 — Node 24 does not run on 10.15.)

- [ ] **Step 3: Write the bundler**

```js
// tools/bundle-plugin.mjs
// Bundles streamdeck-plugin/src/ into the .sdPlugin's bin/plugin.js.
// The output is a COMMITTED artifact (like public/downloads/): the packaged
// zip and any local install run it directly, so rebuild + re-commit after any
// src/ change. Requires: npm i esbuild @elgato/streamdeck --no-save
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function bundlePlugin() {
  const outfile = join(ROOT, 'streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js');
  await build({
    entryPoints: [join(ROOT, 'streamdeck-plugin/src/plugin.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile,
    // ws's optional native accelerators — not installed, must stay external.
    external: ['bufferutil', 'utf-8-validate'],
    // ws uses require() internally; give the ESM bundle a require shim.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: 'error'
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('bundled -> ' + (await bundlePlugin()));
}
```

- [ ] **Step 4: Write the skeleton plugin (hardware spike)**

```js
// streamdeck-plugin/src/plugin.mjs
// SPIKE (Task 3): registers both actions and paints a static SVG face, to
// prove the Node runtime + SVG rasterization on real hardware. Task 4 replaces
// this with the full port.
import streamDeck, { SingletonAction, action } from '@elgato/streamdeck';
import { face } from './faces.mjs';

const VIOLET_HUE = 262;
const SILVER_HUE = 222;

// Plain-JS equivalent of the @action decorator: apply it as a function. It
// stamps manifestId so registerAction() can route events.
function defineAction(uuid, handlers) {
  const cls = action({ UUID: uuid })(class extends SingletonAction {}) ||
    class extends SingletonAction {};
  const inst = new cls();
  if (!inst.manifestId) {
    try { inst.manifestId = uuid; } catch { Object.defineProperty(inst, 'manifestId', { value: uuid }); }
  }
  return Object.assign(inst, handlers);
}

const habit = defineAction('com.shaiss.habit-tracker.habit', {
  onWillAppear: (ev) => ev.action.setImage(face('✅', 'Node!', SILVER_HUE, '', 26)),
  onKeyDown: (ev) => ev.action.showOk()
});
const slot = defineAction('com.shaiss.habit-tracker.slot', {
  onWillAppear: (ev) => ev.action.setImage(face('🌊', 'SVG spike', VIOLET_HUE, 'AI')),
  onKeyDown: (ev) => ev.action.showOk()
});

streamDeck.actions.registerAction(habit);
streamDeck.actions.registerAction(slot);
await streamDeck.connect();
```

- [ ] **Step 5: Bundle and validate**

Run: `node tools/bundle-plugin.mjs` then `streamdeck validate "streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin"`
Expected: bundle written; validator passes (or reports only warnings — fix any errors it names before continuing).

- [ ] **Step 6: Install on the real deck and verify liveness**

```powershell
$dst = "$env:APPDATA\Elgato\StreamDeck\Plugins\com.shaiss.habit-tracker.sdPlugin"
Remove-Item -Recurse -Force $dst
Copy-Item -Recurse "streamdeck-plugin\com.shaiss.habit-tracker.sdPlugin" $dst
streamdeck restart com.shaiss.habit-tracker
```

Then tail `%APPDATA%\Elgato\StreamDeck\logs\StreamDeck.log`:
Expected: `[com.shaiss.habit-tracker] Plugin connected`, NO `code 18` lines, no `enterRestarting` loop. The habit/slot keys on the physical deck repaint with the spike faces.

- [ ] **Step 7: CHECKPOINT — human eyeball of SVG fidelity**

Ask the user: do the physical keys show the night gradient, the ring, a **color** emoji, and crisp label text? 
- If YES → proceed.
- If emoji renders monochrome/missing → fallback: in `faces.mjs`, replace the emoji `<text>` element with an embedded raster glyph — `<image x="41" y="14" width="62" height="62" href="data:image/png;base64,…"/>` where the PNG comes from a small build-time emoji atlas rendered by headless Chromium into `streamdeck-plugin/src/emoji-atlas.json` (emoji → base64 PNG map for the fixed habits plus the coach's common set; unknown emoji fall back to `✨`'s tile). Wire the atlas build into `tools/build-plugin.mjs` beside the existing icon rendering. This fallback is only implemented if the checkpoint fails.

- [ ] **Step 8: Commit**

```bash
git add streamdeck-plugin/src/plugin.mjs tools/bundle-plugin.mjs streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/manifest.json streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js
git commit -m "feat(plugin): Node 24 runtime manifest + esbuild bundler + hardware SVG spike"
```

---

### Task 4: Full port of the plugin behavior + new e2e suite

**Files:**
- Modify: `streamdeck-plugin/src/plugin.mjs` (replace spike)
- Replace: `tests/e2e/plugin.e2e.mjs` (new suite, no Chromium)
- Delete: `streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js`, `.../ticker.js`, `.../index.html`

**Interfaces:**
- Consumes: `face`/`hueFor` (Task 1), `createScheduler` (Task 2), `bundlePlugin` (Task 3).
- Produces: the final plugin entry. Timing constants overridable via env (`HT_POLL_MS`, `HT_TICK_MS`, `HT_POLL_TIMEOUT_MS`, `HT_RECHECK_MS`) so e2e runs in seconds — production defaults identical to the old plugin (15000/3000/10000/2,5,9,15,25s).

- [ ] **Step 1: Write the failing e2e suite**

Replace `tests/e2e/plugin.e2e.mjs` entirely with:

```js
// E2E regression tests for the Stream Deck plugin (Node runtime).
//
// Spawns the real plugin entry (src/plugin.mjs) against a mock Stream Deck
// WebSocket server + mock backend, asserting the behavioral contract:
//   1. registers with the app and paints both faces from live server state
//   2. a slot swap on the server repaints the physical key on its own beat
//   3. the poll identifies itself (?deck=<version>&keys=N) for the heartbeat
//   4. a tap logs server-side (?slot=N) and rechecks catch the reactive swap
//   5. a hung poll cannot wedge the sync — the guard expires and it retries
//   6. the esbuild bundle (bin/plugin.js) passes the same boot smoke
//
// Requires: npm i @elgato/streamdeck esbuild --no-save (ws arrives as an SDK
// dep). No Chromium — that need died with the HTML runtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const SRC = fileURLToPath(new URL('../../streamdeck-plugin/src/plugin.mjs', import.meta.url));
const BIN = fileURLToPath(new URL(
  '../../streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/bin/plugin.js', import.meta.url));

const HABITS = [
  { name: 'Pee', emoji: '🚽', label: 'Pee' },
  { name: 'Eat', emoji: '🍽', label: 'Eat' }
];
const SLOT_A = { habit: 'Flow', emoji: '🌊', label: 'Flow', reason: 'deep work', assignedAt: 1 };
const SLOT_B = { habit: 'Walk', emoji: '🚶', label: 'Walk', reason: 'afternoon', assignedAt: 2 };

let http, httpPort;
let slots, pollUrls, logUrls, hangPolls;
const hung = [];

before(async () => {
  http = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/slots') {
      pollUrls.push(req.url);
      if (hangPolls > 0) { hangPolls--; hung.push(res); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: true, habits: HABITS, suggestedAt: 1, slots }));
      return;
    }
    if (url === '/api/log') {
      logUrls.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => http.listen(0, r));
  httpPort = http.address().port;
});

after(() => {
  for (const res of hung) { try { res.destroy(); } catch { /* gone */ } }
  http?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, { timeout = 15_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Boot one plugin process against a fresh mock Stream Deck app.
async function boot({ entry = SRC } = {}) {
  slots = [SLOT_A, null, null, null];
  pollUrls = [];
  logUrls = [];
  hangPolls = 0;

  const wss = new WebSocketServer({ port: 0 });
  const wsPort = wss.address().port;
  const sent = [];            // messages the plugin sent to the "app"
  let sock = null;
  const ready = new Promise((resolve) => {
    wss.on('connection', (s) => {
      sock = s;
      s.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        sent.push(m);
        if (m.event === 'registerPlugin') resolve();
      });
    });
  });

  const info = {
    application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10.0', version: '7.5.0' },
    plugin: { uuid: 'com.shaiss.habit-tracker', version: '2.0.0' },
    devicePixelRatio: 1,
    colors: {},
    devices: []
  };
  const child = spawn(process.execPath, [
    entry, '-port', String(wsPort), '-pluginUUID', 'uuid-1',
    '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)
  ], {
    cwd: mkdtempSync(join(tmpdir(), 'ht-plugin-')),   // SDK log files land here
    env: {
      ...process.env,
      HT_POLL_MS: '800', HT_TICK_MS: '100',
      HT_POLL_TIMEOUT_MS: '600', HT_RECHECK_MS: '150,350'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  await Promise.race([ready, sleep(10_000).then(() => { throw new Error('no registerPlugin. output:\n' + out); })]);

  const emit = (ev) => sock.send(JSON.stringify(ev));
  const appear = (context, actionUuid, settings) => emit({
    event: 'willAppear', action: actionUuid, context, device: 'dev-1',
    payload: { settings, coordinates: { column: 0, row: 0 }, controller: 'Keypad', isInMultiAction: false }
  });
  appear('ctx-slot-1', 'com.shaiss.habit-tracker.slot', { base: `http://127.0.0.1:${httpPort}`, slot: 1 });
  appear('ctx-habit-0', 'com.shaiss.habit-tracker.habit', { base: `http://127.0.0.1:${httpPort}`, index: 0 });

  const images = () => sent.filter((m) => m.event === 'setImage');
  const done = () => { try { child.kill(); } catch { /* gone */ } wss.close(); };
  return { child, emit, images, sent, done, output: () => out };
}

test('registers and paints both faces from live server state (SVG)', async () => {
  const p = await boot();
  try {
    await until(() => pollUrls.length >= 1, { label: 'first poll' });
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    for (const m of p.images()) {
      assert.match(m.payload.image, /^data:image\/svg\+xml;base64,/);
    }
    const faces = p.images().map((m) =>
      Buffer.from(m.payload.image.split(',')[1], 'base64').toString('utf8'));
    assert.ok(faces.some((f) => f.includes('>Flow<')), 'slot face shows the assigned habit');
    assert.ok(faces.some((f) => f.includes('>Pee<')), 'habit face shows the live habit list');
  } finally { p.done(); }
});

test('a slot swap on the server repaints the key on its own beat', async () => {
  const p = await boot();
  try {
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    const before = p.images().length;
    slots = [SLOT_B, null, null, null];
    await until(() => p.images().length > before, { label: 'repaint after swap' });
    const last = p.images().at(-1);
    const svg = Buffer.from(last.payload.image.split(',')[1], 'base64').toString('utf8');
    assert.ok(svg.includes('>Walk<'), 'new assignment painted');
  } finally { p.done(); }
});

test('the poll identifies itself so the backend can report live hardware', async () => {
  const p = await boot();
  try {
    await until(() => pollUrls.length >= 1, { label: 'first poll' });
    for (const u of pollUrls) {
      assert.match(u, /[?&]deck=\d+\.\d+\.\d+/, 'every poll carries ?deck=<version>');
      assert.match(u, /[?&]keys=\d+\b/, 'every poll reports live key count');
    }
    await until(() => pollUrls.some((u) => /[?&]keys=2\b/.test(u)), { label: 'a poll reporting 2 keys' });
  } finally { p.done(); }
});

test('a tap logs server-side and rechecks catch the reactive swap', async () => {
  const p = await boot();
  try {
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    const polls = pollUrls.length;
    p.emit({ event: 'keyDown', action: 'com.shaiss.habit-tracker.slot', context: 'ctx-slot-1', device: 'dev-1', payload: { settings: {}, coordinates: { column: 0, row: 0 } } });
    await until(() => logUrls.length === 1, { label: 'the tap to log' });
    assert.match(logUrls[0], /[?&]slot=1\b/, 'slot taps resolve server-side');
    await until(() => pollUrls.length > polls + 1, { label: 'post-tap rechecks' });
    assert.ok(p.sent.some((m) => m.event === 'showOk'), 'tap acknowledged on the key');
  } finally { p.done(); }
});

test('a hung poll cannot wedge the sync — the guard expires and it retries', async () => {
  const p = await boot();
  try {
    await until(() => p.images().length >= 2, { label: 'initial faces' });
    const before = pollUrls.length;
    hangPolls = 1;
    p.emit({ event: 'deviceDidConnect', device: 'dev-1', deviceInfo: { name: 'Mock', type: 0, size: { columns: 5, rows: 3 } } });
    await until(() => pollUrls.length === before + 1, { label: 'the hung poll to start' });
    slots = [SLOT_B, null, null, null];
    await until(() => pollUrls.length > before + 1, { label: 'a retry after expiry', timeout: 20_000 });
    await until(() => {
      const last = p.images().at(-1);
      return last && Buffer.from(last.payload.image.split(',')[1], 'base64').toString('utf8').includes('>Walk<');
    }, { label: 'the swap to repaint' });
  } finally { p.done(); }
});

test('the esbuild bundle boots and paints (packaging smoke)', async () => {
  const { bundlePlugin } = await import('../../tools/bundle-plugin.mjs');
  await bundlePlugin();
  const p = await boot({ entry: BIN });
  try {
    await until(() => p.images().length >= 2, { label: 'bundle paints faces' });
  } finally { p.done(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- --test-name-pattern ""` — or directly `node --test tests/e2e/plugin.e2e.mjs`
Expected: FAIL — the spike plugin never polls (`timed out waiting for first poll`).

- [ ] **Step 3: Replace the spike with the full port**

Replace `streamdeck-plugin/src/plugin.mjs` entirely with:

```js
// Habit Tracker AI — Stream Deck plugin (Node runtime).
//
// Two actions:
//  - …habit  settings: { base, index (0-based position), key? }
//  - …slot   settings: { base, slot (1-4), key? }
//
// Everything renders from live server state: one poll of <base>/api/slots
// carries both the habit list and the AI slot assignments, so habit-manager
// edits and coach swaps repaint physical keys within one poll. Taps resolve
// server-side (?hkey= / ?slot=) so history records what the key showed.
//
// This runs as an ordinary Node process (Stream Deck ≥7.1 spawns it), so
// timers are reliable — the wall-clock deadline scheduler survives from the
// HTML-runtime era because it defends against a HUNG BACKEND, not a throttled
// page: the single-flight guard expires, retries, and orphans late settles.
import streamDeck, { SingletonAction, action } from '@elgato/streamdeck';
import { face, hueFor } from './faces.mjs';
import { createScheduler } from './scheduler.mjs';

const POLL_MS = +(process.env.HT_POLL_MS || 15000);
const TICK_MS = +(process.env.HT_TICK_MS || 3000);
const POLL_TIMEOUT_MS = +(process.env.HT_POLL_TIMEOUT_MS || 10000);
// The coach reacts to taps in a background pass; chain rechecks so one lands
// after the swap exists.
const RECHECK_MS = (process.env.HT_RECHECK_MS || '2000,5000,9000,15000,25000').split(',').map(Number);

const VIOLET_HUE = 262;   // reserved: the coach speaking
const NUDGE_HUE = 38;     // the coach speaking LOUDER — proactive nudges
const SILVER_HUE = 222;   // neutral / pending

// Reported to the server so the dashboard can show which build a physical
// deck runs; falls back for direct `node src/plugin.mjs` runs outside the app.
const VERSION = streamDeck.info?.plugin?.version || '2.0.0';

const keys = new Map();   // context id -> { kind: 'habit'|'slot', settings, action }
let slotCache = null;
let habitCache = null;

const sched = createScheduler({ pollMs: POLL_MS, timeoutMs: POLL_TIMEOUT_MS, recheckMs: RECHECK_MS });
let inflightCtrl = null;
let clock = null;

function startClock() {
  if (!clock) clock = setInterval(pump, TICK_MS);
}

function pump() {
  if (keys.size === 0) return;
  const now = Date.now();
  const { expired, poll } = sched.pump(now);
  if (expired && inflightCtrl) {
    try { inflightCtrl.abort(); } catch { /* best effort */ }
    inflightCtrl = null;
  }
  if (poll) refreshSlots(now);
}

function refreshSlots(now) {
  let base = null, secret = null;
  for (const k of keys.values()) {
    if (k.settings.base) { base = k.settings.base; secret = k.settings.key || null; break; }
  }
  if (!base) return;
  const seq = sched.pollStarted(now);
  // ?deck= marks this as the hardware plugin's poll so the server records the
  // heartbeat /api/health and the dashboard report; ?key= rides along because
  // that heartbeat is a write, gated by HABIT_KEY when set.
  const url = base.replace(/\/+$/, '') + '/api/slots?deck=' + encodeURIComponent(VERSION) +
    '&keys=' + keys.size + (secret ? '&key=' + encodeURIComponent(secret) : '');
  inflightCtrl = new AbortController();
  fetch(url, { signal: inflightCtrl.signal })
    .then((r) => r.json())
    .then((j) => {
      if (!sched.pollSettled(seq)) return;   // pump() already orphaned us
      inflightCtrl = null;
      const slots = j.slots || [];
      const habits = j.habits || [];
      const slotsChanged = !slotCache || JSON.stringify(slotCache) !== JSON.stringify(slots);
      const habitsChanged = !habitCache || JSON.stringify(habitCache) !== JSON.stringify(habits);
      slotCache = slots;
      habitCache = habits;
      for (const k of keys.values()) {
        // One bad face must not strand the rest of the deck on stale images.
        try {
          if (slotsChanged && k.kind === 'slot') render(k);
          if (habitsChanged && k.kind === 'habit') render(k);
        } catch { /* next poll retries this key */ }
      }
    })
    .catch(() => {
      if (sched.pollSettled(seq)) inflightCtrl = null;   // keep last faces on hiccups
    });
}

function render(k) {
  const s = k.settings;
  if (!s.base) { k.action.setImage(face('⚙️', 'setup', SILVER_HUE, '')); return; }
  if (k.kind === 'habit') {
    const idx = +s.index || 0;
    const def = habitCache ? habitCache[idx] : null;
    if (def) k.action.setImage(face(def.emoji || '•', def.label || def.habit, hueFor(def.name), ''));
    else if (habitCache) k.action.setImage(face('·', 'empty', SILVER_HUE, '', 22));  // removed in manager
    else k.action.setImage(face('⏳', '…', SILVER_HUE, '', 22));                     // first poll pending
    return;
  }
  const n = parseInt(s.slot, 10) || 1;
  const def = slotCache ? slotCache[n - 1] : null;
  if (def && def.nudge) {
    // Proactive nudge: amber halo + ❗ so the poke reads across the room.
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, NUDGE_HUE, '❗ ' + n, 90));
  } else if (def) {
    k.action.setImage(face(def.emoji || '✨', def.label || def.habit, VIOLET_HUE, 'AI ' + n));
  } else {
    k.action.setImage(face('✨', 'Slot ' + n, SILVER_HUE, 'AI', 22));
  }
}

function tap(k) {
  const s = k.settings;
  if (!s.base) { k.action.showAlert(); return; }
  const q = k.kind === 'slot'
    ? 'slot=' + encodeURIComponent(s.slot || 1)
    : 'hkey=' + encodeURIComponent((+s.index || 0) + 1);
  const url = s.base.replace(/\/+$/, '') + '/api/log?' + q +
    (s.key ? '&key=' + encodeURIComponent(s.key) : '');
  fetch(url)
    .then((r) => {
      if (r.ok) {
        k.action.showOk();
        sched.tapped(Date.now());   // watch for the reactive coach swap
        pump();
      } else { k.action.showAlert(); }
    })
    .catch(() => k.action.showAlert());
}

// Plain-JS equivalent of the @action decorator: apply it as a function so
// manifestId is stamped the supported way, with a belt-and-braces fallback.
function defineAction(uuid, kind) {
  const wrapped = action({ UUID: uuid })(class extends SingletonAction {});
  const inst = new (wrapped || class extends SingletonAction {})();
  if (!inst.manifestId) {
    try { inst.manifestId = uuid; } catch { Object.defineProperty(inst, 'manifestId', { value: uuid }); }
  }
  inst.onWillAppear = (ev) => {
    keys.set(ev.action.id, { kind, settings: ev.payload.settings || {}, action: ev.action });
    render(keys.get(ev.action.id));
    startClock();
    sched.forcePoll();   // a key just appeared — refresh now
    pump();
  };
  inst.onDidReceiveSettings = (ev) => {
    const k = keys.get(ev.action.id);
    if (k) { k.settings = ev.payload.settings || {}; render(k); }
    pump();
  };
  inst.onWillDisappear = (ev) => { keys.delete(ev.action.id); };
  inst.onKeyDown = (ev) => {
    const k = keys.get(ev.action.id);
    if (k) tap(k); else ev.action.showAlert();
    pump();
  };
  return inst;
}

streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.habit', 'habit'));
streamDeck.actions.registerAction(defineAction('com.shaiss.habit-tracker.slot', 'slot'));

// System wake / device reconnect = faces are certainly stale.
streamDeck.system.onSystemDidWakeUp?.(() => { sched.forcePoll(); pump(); });
streamDeck.devices.onDeviceDidConnect?.((_) => { sched.forcePoll(); pump(); });

await streamDeck.connect();
```

- [ ] **Step 4: Delete the legacy runtime files**

```bash
git rm streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/app.js streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/ticker.js streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin/index.html
```

- [ ] **Step 5: Run everything**

Run: `node --check streamdeck-plugin/src/plugin.mjs && npm test && node --test tests/e2e/plugin.e2e.mjs`
Expected: all PASS. If the SDK's event routing rejects the manual `defineAction` wiring (no `willAppear` reaching handlers), debug against the mock server output — the `manifestId` stamp is the first suspect (see `registerAction` throws in SDK docs).

- [ ] **Step 6: Rebundle, reinstall on hardware, verify live**

Run: `node tools/bundle-plugin.mjs`, redo the Task 3 Step 6 install, then tail the log.
Expected: `Plugin connected`, faces render from LIVE server state (real habits, real slot assignments), a physical tap logs a row and flashes the ✓.

- [ ] **Step 7: Commit**

```bash
git add -A streamdeck-plugin tests/e2e/plugin.e2e.mjs
git commit -m "feat(plugin)!: full port to the Node SDK — poll/tap/render parity, e2e without Chromium"
```

---

### Task 5: Packaging, CI, and docs

**Files:**
- Modify: `tools/build-plugin.mjs` (bundle before zip)
- Modify: `.github/workflows/ci.yml` (e2e deps)
- Modify: `CLAUDE.md` (commands, plugin section)

- [ ] **Step 1: Wire the bundler into the packager**

In `tools/build-plugin.mjs`, add after the imports:

```js
import { bundlePlugin } from './bundle-plugin.mjs';
```

and immediately before the `// Package:` comment (after the browser close):

```js
await bundlePlugin();
console.log('  bundled bin/plugin.js');
```

- [ ] **Step 2: Update CI**

In `.github/workflows/ci.yml`, replace the e2e install line:

```yaml
      - run: npm i playwright-core @elgato/streamdeck esbuild --no-save
```

(Chromium install stays — the habit-manager/nudge/deck-status suites still drive a browser. Unit job stays dependency-free.)

- [ ] **Step 3: Update CLAUDE.md**

- In the one-time install line, change to: `npm i playwright-core pngjs gifenc esbuild @elgato/streamdeck --no-save` and update the parenthetical to mention esbuild/@elgato/streamdeck are plugin build deps.
- Replace the entire **Stream Deck plugin** section (from `**Stream Deck plugin**` through the paragraph ending `…keeps the throttling fix honest.`) with:

```markdown
**Stream Deck plugin** (`streamdeck-plugin/`) — a **Node.js-runtime** plugin
(Stream Deck ≥7.1 spawns `bin/plugin.js` under its bundled Node 24; the legacy
HTML/QtWebEngine runtime and its Worker/throttling workarounds are gone — see
git history if archaeology calls). Source is `src/` (plain ESM, no TypeScript):
`faces.mjs` renders key faces as SVG data URIs (hue comes from the shared
`tools/lib-hue.mjs` — the unit drift guard enforces the import), `scheduler.mjs`
is the pure wall-clock poll scheduler, `plugin.mjs` wires both into
`@elgato/streamdeck`. Two actions, both live: `…habit` ({base, index}) and
`…slot` ({base, slot}); faces render from one `/api/slots` poll; taps resolve
server-side (`?hkey=`/`?slot=`). No property inspector; per-key Settings come
from the generator, unchanged shapes.

The deadline scheduler survives from the HTML era **on purpose**: it defends
against a hung backend, not a throttled page. The single-flight guard is a
deadline (`POLL_TIMEOUT_MS`), an expired poll is aborted + retried, and a
sequence number orphans its late settle. Taps push a chain of rechecks
(2/5/9/15/25s) because the reactive coach pass runs after `/api/log` answers.
The poll tags itself `?deck=<version>&keys=N` (plus `?key=` when `HABIT_KEY`
is set) — that heartbeat is the one write on an otherwise read-only endpoint
and it is what lets `/api/health` tell a dead plugin from a dead backend.
Timing constants are env-overridable (`HT_POLL_MS`, `HT_TICK_MS`,
`HT_POLL_TIMEOUT_MS`, `HT_RECHECK_MS`) so the e2e suite runs in seconds.

`bin/plugin.js` is an **esbuild bundle and a committed artifact** — rebuild
with `node tools/bundle-plugin.mjs` (or the full `node tools/build-plugin.mjs`)
after any `src/` change, or ship a stale plugin. `tests/e2e/plugin.e2e.mjs`
spawns the real entry against a mock Stream Deck WebSocket server + mock
backend (no Chromium needed for this suite) and includes a bundle boot smoke.
```

- [ ] **Step 4: Run suites, commit**

Run: `npm test && npm run test:e2e`
Expected: PASS.

```bash
git add tools/build-plugin.mjs .github/workflows/ci.yml CLAUDE.md
git commit -m "chore: wire plugin bundling into packaging, CI, and CLAUDE.md"
```

---

### Task 6: Rebuild distributed artifacts + final live verification

- [ ] **Step 1: Invoke the rebuild-artifacts skill** — it regenerates `public/downloads/com.shaiss.habit-tracker.streamDeckPlugin` (now containing `bin/plugin.js` + v2 manifest) and the hosted profile, and stages everything. Note: on this Windows machine there is no `/opt/pw-browsers/chromium`; set `CHROME_PATH` to a local Chrome/Chromium (e.g. `$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'`) before running the icon-rendering steps.

- [ ] **Step 2: Verify the zip contains the new runtime**

Run (PowerShell): expand the built `.streamDeckPlugin` into the scratchpad and assert `bin/plugin.js` exists, `app.js` does not, and `manifest.json` says `"Version": "2.0.0"` / `"CodePath": "bin/plugin.js"`.

- [ ] **Step 3: Full clean-install rehearsal on this machine**

Install the freshly built zip the way users get it (copy staged folder into `%APPDATA%\Elgato\StreamDeck\Plugins`, `streamdeck restart com.shaiss.habit-tracker`), then:
- StreamDeck.log shows `Plugin connected`, zero `code 18`.
- `/api/health` (via Vercel MCP `web_fetch_vercel_url` or direct fetch) shows a fresh `deck` heartbeat with the 2.0.0 version.
- Physical tap → row appears, ✓ flashes, slot swap repaints within the recheck chain.

- [ ] **Step 4: Commit artifacts**

```bash
git add public/downloads streamdeck-plugin/com.shaiss.habit-tracker.sdPlugin
git commit -m "build: rebuild plugin package + profile for the Node runtime"
```

- [ ] **Step 5: Hand off to the ship skill** (PR into the default branch, squash-merge, live probes) — only on the user's go.

---

## Deferred (explicitly out of scope)

- **Elgato MCP `ai_ready` exposure** (`invoke_plugin_method` tools): SD 7.4+ ships an MCP server; how a plugin marks actions/methods AI-callable is not yet in the SDK docs we can reach. Follow-up: inspect `streamdeck__list_actions` output for our v2 actions, then research the manifest/SDK surface. Do not block the migration on this.
- **Property inspector**: still none, by design.
- **Legacy SD 5/6 support**: dropped (Software.MinimumVersion 7.1). Single-user build; the user runs 7.5.0.

## Self-Review Notes

- Spec coverage: runtime swap ✅ (T3/T4), UUID/settings/API freeze ✅ (constraints + T3 manifest + T4 port), hue parity ✅ (T1), packaging ✅ (T3/T5/T6), tests ✅ (T1/T2/T4), CI ✅ (T5), docs ✅ (T5), hardware verification ✅ (T3/T4/T6).
- Type consistency: `face(emoji, label, hue, badge, sat?)`, `createScheduler({pollMs,timeoutMs,recheckMs})` with `pump/pollStarted/pollSettled/tapped/forcePoll`, `bundlePlugin()` — names match across tasks.
- Known risks called out in-task: SVG emoji fidelity (T3 checkpoint + fallback), manual `manifestId` stamping (T4 step 5 debug note), SDK event-name assumptions (`onSystemDidWakeUp`/`onDeviceDidConnect` guarded with `?.`).
