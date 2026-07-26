#!/usr/bin/env node
// Turns your deployed Apps Script URL + config/habits.json into:
//   1) dist/urls.txt        - exact URLs to paste into each button (100% reliable path)
//   2) dist/Habit Tracker.streamDeckProfile - a double-click-to-import profile (convenience)
//
// Usage:
//   node tools/generate.mjs "https://script.google.com/macros/s/XXXX/exec"
//   node tools/generate.mjs "https://.../exec" --key=k9x2q      # if you set a SECRET
//   node tools/generate.mjs "https://.../exec" --model=xl       # deck model (see below)
//
// Zero dependencies. Needs only Node 16+.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zip } from './lib-zip.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--'));
const getOpt = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const key = getOpt('key');
const modelArg = (getOpt('model') || 'mk2').toLowerCase();

// Stream Deck hardware model IDs. Empty is accepted by the app and prompts
// you to pick a device at import time, which is the safest default.
const MODELS = {
  original: '20GAA9901', // Stream Deck (6 keys wide, 15 total, original)
  mk2: '20GBA9901',      // Stream Deck MK.2 (15 keys) - most common
  mini: '20GAI9901',     // Stream Deck Mini (6 keys)
  xl: '20GAT9901',       // Stream Deck XL (32 keys)
  neo: '',               // Stream Deck Neo (8 keys, 4x2) - app asks for device at import
  any: ''
};
const COLS = { original: 5, mk2: 5, mini: 3, xl: 8, neo: 4, any: 5 };
const ROWS = { original: 3, mk2: 3, mini: 2, xl: 4, neo: 2, any: 3 };
const deviceModel = MODELS[modelArg] ?? MODELS.mk2;
const cols = COLS[modelArg] ?? COLS.mk2;
const rows = ROWS[modelArg] ?? ROWS.mk2;

// Per-habit key colors (mirrors tools/make-icons.mjs; baked into plugin settings).
const HABIT_COLORS = {
  Pee: ['#f6c445', '#d68a06'],
  Poop: ['#a9764e', '#5e3a20'],
  Eat: ['#ff7a59', '#e03a2f'],
  Drink: ['#5aa0ff', '#2160e6'],
  Exercise: ['#4fd98a', '#12915a'],
  _default: ['#6b7280', '#374151']
};

if (!base || !/^https?:\/\//.test(base)) {
  console.error(
    'Usage: node tools/generate.mjs "https://script.google.com/macros/s/XXXX/exec" [--key=SECRET] [--model=mk2|xl|mini|original|any]'
  );
  process.exit(1);
}
const execBase = base.replace(/\?.*$/, '').replace(/\/+$/, '');

// Dashboard key: opens a URL in the browser. Defaults to the site root of the
// log endpoint (e.g. https://host/api/log -> https://host/). --no-dashboard skips.
const noDashboard = args.includes('--no-dashboard');
let dashboardUrl = getOpt('dashboard');
if (!dashboardUrl && !noDashboard) {
  try { dashboardUrl = new URL(execBase).origin + '/'; } catch { /* leave unset */ }
}

// --plugin: emit keys for our own "Habit Tracker AI" plugin (live-updating AI
// slot faces) instead of the third-party Web Requests plugin.
const usePlugin = args.includes('--plugin');
const PLUGIN_HABIT = 'com.kalmansforge.habit-tracker.habit';
const PLUGIN_SLOT = 'com.kalmansforge.habit-tracker.slot';
const siteOrigin = (() => { try { return new URL(execBase).origin; } catch { return ''; } })();

// AI slot keys: fill whatever key cells remain after habits + Stats, up to 4.
// Override with --slots=N (0 disables). Computed after habits load.
const slotsOpt = getOpt('slots');
const capacity = cols * rows;

// --outfile / --name: write the profile somewhere specific (used to publish
// hosted artifacts into public/downloads/).
const outFile = getOpt('outfile');
const profileName = getOpt('name') || 'Habit Tracker';

// Embed a key icon as a data URI (baked into the profile). Prefers the
// animated GIF in icons/animated/ unless --static is passed; falls back to
// the still PNG in icons/.
const useStatic = args.includes('--static');
const iconDataUri = (name) => {
  const gif = join(ROOT, 'icons/animated', `${name}.gif`);
  if (!useStatic && existsSync(gif)) {
    return 'data:image/gif;base64,' + readFileSync(gif).toString('base64');
  }
  const png = join(ROOT, 'icons', `${name}.png`);
  return existsSync(png) ? 'data:image/png;base64,' + readFileSync(png).toString('base64') : '';
};

// ---- read habits ----------------------------------------------------------
const { habits } = JSON.parse(readFileSync(join(ROOT, 'config/habits.json'), 'utf8'));
if (!Array.isArray(habits) || habits.length === 0) {
  console.error('config/habits.json has no habits.');
  process.exit(1);
}

const buildUrl = (h) => {
  const q = new URLSearchParams({ habit: h.name });
  if (key) q.set('key', key);
  return `${execBase}?${q.toString()}`;
};
const buildSlotUrl = (n) => {
  const q = new URLSearchParams({ slot: String(n) });
  if (key) q.set('key', key);
  return `${execBase}?${q.toString()}`;
};

const slotCount = slotsOpt !== undefined
  ? Math.max(0, Math.min(4, parseInt(slotsOpt, 10) || 0))
  : Math.max(0, Math.min(4, capacity - habits.length - (dashboardUrl ? 1 : 0)));

// ---- 1) urls.txt (guaranteed manual path) ---------------------------------
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const reportRows = habits.map((h) => `${(h.emoji || '').padEnd(2)} ${h.label.padEnd(12)} ${buildUrl(h)}`);
const urlsTxt =
  `Web Request buttons (Method: GET). One per key.\n` +
  `Plugin: "Web Requests" by data-enabler (install from the Stream Deck Marketplace).\n\n` +
  habits.map((h) => `Title: ${h.emoji} ${h.label}\n  URL: ${buildUrl(h)}\n  Method: GET`).join('\n\n') +
  (dashboardUrl
    ? `\n\n--- Dashboard key (optional) ---\n` +
      `Action: System -> Website (built-in). Opens the dashboard in a browser.\n` +
      `Title: 📊 Stats\n  URL: ${dashboardUrl}`
    : '') +
  (slotCount > 0
    ? `\n\n--- AI slot keys (the AI decides what these log; see the dashboard) ---\n` +
      Array.from({ length: slotCount }, (_, i) =>
        `Title: ✨ AI ${i + 1}\n  URL: ${buildSlotUrl(i + 1)}\n  Method: GET`
      ).join('\n')
    : '') +
  `\n\nIcons: animated GIFs in icons/animated/, stills in icons/ (drag one onto a key to set its image).\n`;
writeFileSync(join(ROOT, 'dist/urls.txt'), urlsTxt);

// ---- 2) .streamDeckProfile (convenience) ----------------------------------
const profileUuid = randomUUID().toUpperCase();
const pageUuid = randomUUID().toUpperCase();
const folder = `${profileUuid}.sdProfile`;

const actions = {};
let cell = 0;
const place = (action) => {
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  actions[`${col},${row}`] = action;
  cell++;
};
const states = (img, title) => [
  {
    FFamily: '',
    FSize: '14',
    FStyle: '',
    FUnderline: 'off',
    Image: img,
    Title: title,
    TitleAlignment: 'middle',
    TitleColor: '#ffffff',
    // Icons carry their own label; show a text title only when there's no icon.
    TitleShow: img ? false : true
  }
];

// Habit keys.
habits.forEach((h, i) => {
  const img = iconDataUri(h.name);
  const [c1, c2] = HABIT_COLORS[h.name] || HABIT_COLORS._default;
  place(
    usePlugin
      ? {
          ActionID: randomUUID().toUpperCase(),
          Name: 'Habit Key',
          // index = position: the plugin resolves the CURRENT habit at this
          // position from /api/slots, so habit-manager edits repaint the key.
          // The rest is an offline/first-render fallback.
          Settings: { base: siteOrigin, index: i, habit: h.name, emoji: h.emoji, label: h.label, c1, c2, ...(key ? { key } : {}) },
          State: 0,
          States: states(img, `${h.emoji} ${h.label}`),
          UUID: PLUGIN_HABIT
        }
      : {
          ActionID: randomUUID().toUpperCase(),
          Name: 'HTTP Request',
          Settings: { url: buildUrl(h), method: 'GET', contentType: '', headers: '', body: '' },
          State: 0,
          States: states(img, `${h.emoji} ${h.label}`),
          UUID: 'gg.datagram.web-requests.http'
        }
  );
});

// Stats key: open the dashboard in a browser (built-in Website action).
if (dashboardUrl) {
  place({
    ActionID: randomUUID().toUpperCase(),
    Name: 'Website',
    Settings: { path: dashboardUrl, openInBrowser: true },
    State: 0,
    States: states(iconDataUri('_dashboard'), '📊 Stats'),
    UUID: 'com.elgato.streamdeck.system.website'
  });
}

// AI slot keys.
for (let n = 1; n <= slotCount; n++) {
  const img = iconDataUri(`Slot${n}`);
  place(
    usePlugin
      ? {
          ActionID: randomUUID().toUpperCase(),
          Name: 'AI Slot Key',
          Settings: { base: siteOrigin, slot: n, ...(key ? { key } : {}) },
          State: 0,
          States: states(img, `✨ AI ${n}`),
          UUID: PLUGIN_SLOT
        }
      : {
          ActionID: randomUUID().toUpperCase(),
          Name: 'HTTP Request',
          Settings: { url: buildSlotUrl(n), method: 'GET', contentType: '', headers: '', body: '' },
          State: 0,
          States: states(img, `✨ AI ${n}`),
          UUID: 'gg.datagram.web-requests.http'
        }
  );
}

const outerManifest = {
  AppIdentifier: '',
  DeviceModel: deviceModel,
  DeviceUUID: '',
  Name: profileName,
  Pages: { Current: pageUuid, Pages: [pageUuid] },
  Version: '1.0'
};
const pageManifest = {
  Actions: actions,
  DeviceModel: deviceModel,
  DeviceUUID: '',
  Name: profileName,
  Version: '1.0'
};

const files = [
  { name: `${folder}/manifest.json`, data: Buffer.from(JSON.stringify(outerManifest, null, 2)) },
  {
    name: `${folder}/Profiles/${pageUuid}/manifest.json`,
    data: Buffer.from(JSON.stringify(pageManifest, null, 2))
  }
];
const profilePath = outFile || join(ROOT, 'dist/Habit Tracker.streamDeckProfile');
writeFileSync(profilePath, zip(files));

// ---- report ---------------------------------------------------------------
console.log(`\nWrote ${profilePath}`);
console.log(`  + dist/urls.txt (manual fallback)\n`);
console.log(`Base URL : ${execBase}`);
const iconsFound = habits.filter((h) => iconDataUri(h.name)).length;
const animCount = useStatic
  ? 0
  : habits.filter((h) => existsSync(join(ROOT, 'icons/animated', `${h.name}.gif`))).length;
console.log(
  `Habits   : ${habits.length}   Deck: ${modelArg} (${cols}x${rows})   Flavor: ${usePlugin ? 'HabitTrackerAI plugin' : 'Web Requests plugin'}   Key: ${key ? 'yes' : 'none'}`
);
console.log(
  `Icons    : ${iconsFound}/${habits.length} embedded (${animCount} animated)   AI slots: ${slotCount}   Dashboard key: ${dashboardUrl || 'off'}\n`
);
for (const r of reportRows) console.log('  ' + r);
if (dashboardUrl) console.log('  📊 Stats        ' + dashboardUrl);
for (let n = 1; n <= slotCount; n++) console.log(`  ✨ AI Slot ${n}    ${buildSlotUrl(n)}`);
console.log('');

