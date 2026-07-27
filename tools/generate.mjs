#!/usr/bin/env node
// Turns your deployed Apps Script URL + config/habits.json into:
//   1) dist/urls.txt        - exact URLs to paste into each button (100% reliable path)
//   2) dist/Habit Tracker.streamDeckProfile - a double-click-to-import profile (convenience)
//
// Usage:
//   node tools/generate.mjs "https://script.google.com/macros/s/XXXX/exec"
//   node tools/generate.mjs "https://.../exec" --key=k9x2q      # if you set a SECRET
//   node tools/generate.mjs "https://.../exec" --model=xl       # deck model (see below)
//   node tools/generate.mjs "https://.../exec" --pages=2        # multi-page profile (#51)
//
// Zero dependencies. Needs only Node 16+.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zip } from './lib-zip.mjs';
import { loadHabits } from './lib-habits.mjs';

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
const PLUGIN_HABIT = 'com.shaiss.habit-tracker.habit';
const PLUGIN_SLOT = 'com.shaiss.habit-tracker.slot';
const siteOrigin = (() => { try { return new URL(execBase).origin; } catch { return ''; } })();

// AI slot keys: fill whatever key cells remain after habits + Stats, up to 4.
// Override with --slots=N (0 disables). Computed after habits load.
const slotsOpt = getOpt('slots');
const capacity = cols * rows;

// --pages=N (default 1, so existing invocations are unchanged): emit a
// multi-page profile (issue #51). Page 0 keeps today's layout; pages 1+ are
// Coach pages filled with the wider slot range (5..16 — see issue #52; the
// server resolves those against habits:coach:page). Navigation is entirely
// built-in Elgato actions, no plugin code — shapes verified on hardware by
// tools/spike-multipage.mjs (#42).
const pageCount = Math.max(1, Math.min(4, parseInt(getOpt('pages'), 10) || 1));

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

// v3.0 profiles embed icons as real PNG files inside each page's Images/
// folder (NOT data URIs — Stream Deck rejects them). Returns the raw PNG
// Buffer plus the relative Images/<file>.png ref a state should cite, or
// null when there's no icon for this name. PNG-only: GIFs aren't a valid
// Images/ entry, so even without --static we read the still PNG.
const ICON_REFS = new Map(); // name -> { ref, buffer }  (dedupes shared icons)
const iconImage = (name) => {
  if (ICON_REFS.has(name)) return ICON_REFS.get(name);
  const png = join(ROOT, 'icons', `${name}.png`);
  if (!existsSync(png)) return null;
  const slug = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'icon';
  const ref = `Images/${slug}.png`;
  const entry = { ref, buffer: readFileSync(png) };
  ICON_REFS.set(name, entry);
  return entry;
};

// ---- read habits (live list first — the habit manager is the source of truth)
const { habits, source: habitsSource } = await loadHabits(siteOrigin, ROOT);

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
// v3.0 layout: one populated page (the deck) + one extra empty "Default"
// page the app requires (referenced from Pages.Default, NOT Pages.Pages).
// On-disk page folders are uppercase UUIDs; the outer manifest cites them
// in lowercase, matching how Stream Deck itself writes profiles.
const profileUuid = randomUUID().toUpperCase();
const pageUuids = Array.from({ length: pageCount }, () => randomUUID().toUpperCase());
const defaultPageUuid = randomUUID().toUpperCase();
const folder = `${profileUuid}.sdProfile`;

// v3.0 page Controllers[].Actions is keyed "col,row" (column first). Habits
// fill row-major, top-left first, matching how the keys read on the deck.
// One cursor PER PAGE (issue #51); on multi-page layouts the bottom-row outer
// corners are reserved for navigation — 0,rows-1 previous and cols-1,rows-1
// next, matching the muscle memory of the owner's Default Profile.
const pageActions = pageUuids.map(() => ({}));
const cursors = pageUuids.map(() => 0);
const cellAt = (col, row) => `${col},${row}`;
const reservedFor = (p) => {
  const r = new Set();
  if (pageCount === 1) return r;
  if (p > 0) r.add(cellAt(0, rows - 1));                 // previous
  if (p < pageCount - 1) r.add(cellAt(cols - 1, rows - 1)); // next
  return r;
};
const place = (action, page = 0) => {
  const reserved = reservedFor(page);
  while (cursors[page] < capacity) {
    const cell = cellAt(cursors[page] % cols, Math.floor(cursors[page] / cols));
    cursors[page]++;
    if (reserved.has(cell) || pageActions[page][cell]) continue;
    pageActions[page][cell] = action;
    return true;
  }
  return false; // page full — caller decides whether that matters
};

// Built-in page navigation. Exact shape lifted from a real ProfilesV3 profile
// (see tools/spike-multipage.mjs): Settings is empty, States is a single EMPTY
// object (the app supplies the chevron art itself), plus a Plugin block naming
// the Pages plugin. No plugin code of ours is involved in navigation at all.
const navKey = (dir) => ({
  ActionID: randomUUID().toUpperCase(), LinkedTitle: true,
  Name: dir === 'next' ? 'Next Page' : 'Previous Page',
  Plugin: { Name: 'Pages', UUID: 'com.elgato.streamdeck.page', Version: '1.0' },
  Resources: null, Settings: {}, State: 0, States: [{}],
  UUID: `com.elgato.streamdeck.page.${dir}`
});
// Build a single state. `imgName` is an icon name (resolved to an Images/
// ref via iconImage); pass null when the key has no icon (title-only state).
const states = (imgName, title) => {
  const img = imgName ? iconImage(imgName) : null;
  // Icons carry their own label; show a text title only when there's no icon.
  const state = { ShowTitle: !img, TitleAlignment: 'middle', TitleColor: '#ffffff' };
  if (img) state.Image = img.ref;
  else state.Title = title;
  return [state];
};

// Plugin-flavor keys carry NO baked image: Stream Deck treats a profile image
// as a user customization and silently vetoes every plugin setImage — the key
// would never repaint. The plugin paints live faces seconds after connecting;
// until then the manifest's default action images cover the gap.
const liveStates = () => [{ ShowTitle: false, TitleAlignment: 'middle', TitleColor: '#ffffff' }];

// Habit keys.
habits.forEach((h, i) => {
  place(
    usePlugin
      ? {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'Habit Key',
          // index = position: the plugin resolves the CURRENT habit at this
          // position from /api/slots, so habit-manager edits repaint the key.
          Settings: { base: siteOrigin, index: i, ...(key ? { key } : {}) },
          Resources: null,
          State: 0,
          States: liveStates(),
          UUID: PLUGIN_HABIT
        }
      : {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'HTTP Request',
          Settings: { url: buildUrl(h), method: 'GET', contentType: '', headers: '', body: '' },
          Resources: null,
          State: 0,
          States: states(h.name, `${h.emoji} ${h.label}`),
          UUID: 'gg.datagram.web-requests.http'
        }
  );
});

// Stats key: open the dashboard in a browser (built-in Website action).
if (dashboardUrl) {
  place({
    ActionID: randomUUID().toUpperCase(),
    LinkedTitle: true,
    Name: 'Website',
    Settings: { path: dashboardUrl, openInBrowser: true },
    Resources: null,
    State: 0,
    States: states('_dashboard', '📊 Stats'),
    UUID: 'com.elgato.streamdeck.system.website'
  });
}

// AI slot keys.
for (let n = 1; n <= slotCount; n++) {
  place(
    usePlugin
      ? {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'AI Slot Key',
          Settings: { base: siteOrigin, slot: n, ...(key ? { key } : {}) },
          Resources: null,
          State: 0,
          States: liveStates(),
          UUID: PLUGIN_SLOT
        }
      : {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'HTTP Request',
          Settings: { url: buildSlotUrl(n), method: 'GET', contentType: '', headers: '', body: '' },
          Resources: null,
          State: 0,
          States: states(`Slot${n}`, `✨ AI ${n}`),
          UUID: 'gg.datagram.web-requests.http'
        }
  );
}

// Coach pages (pages 1+): the wider slot range, numbered on from the front
// four. /api/log resolves 5..16 against habits:coach:page (issue #52), so key
// numbering is one integer namespace across pages. Image-less states on every
// page — the setImage veto applies per key, not per profile.
let coachSlot = 5;
for (let p = 1; p < pageCount; p++) {
  while (coachSlot <= 16) {
    const n = coachSlot;
    const action = usePlugin
      ? {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'AI Slot Key',
          Settings: { base: siteOrigin, slot: n, ...(key ? { key } : {}) },
          Resources: null,
          State: 0,
          States: liveStates(),
          UUID: PLUGIN_SLOT
        }
      : {
          ActionID: randomUUID().toUpperCase(),
          LinkedTitle: true,
          Name: 'HTTP Request',
          Settings: { url: buildSlotUrl(n), method: 'GET', contentType: '', headers: '', body: '' },
          Resources: null,
          State: 0,
          States: states(null, `✨ AI ${n}`),
          UUID: 'gg.datagram.web-requests.http'
        };
    if (!place(action, p)) break; // page full — spill to the next page
    coachSlot++;
  }
}

// Navigation keys land on the reserved corners last, so fills can't take them.
for (let p = 0; p < pageCount; p++) {
  if (p > 0) pageActions[p][cellAt(0, rows - 1)] = navKey('previous');
  if (p < pageCount - 1) pageActions[p][cellAt(cols - 1, rows - 1)] = navKey('next');
}

// ---- v3.0 manifests -------------------------------------------------------
// Outer: Device object + Pages (Current is a real page; Default is the empty
// fallback page, deliberately NOT listed in Pages.Pages). Version MUST be
// "3.0" or the app's v1.0 importer chokes on the (intentionally absent)
// top-level Actions key.
const outerManifest = {
  Device: { Model: deviceModel, UUID: '' },
  Name: profileName,
  Pages: {
    Current: pageUuids[0].toLowerCase(),
    Default: defaultPageUuid.toLowerCase(),
    Pages: pageUuids.map((u) => u.toLowerCase())
  },
  Version: '3.0'
};
// Page: actions live inside Controllers[].Actions, keyed "col,row". An empty
// page (the Default fallback) uses Actions: null.
const pageManifest = (actions) => ({
  Controllers: [{ Actions: actions, Type: 'Keypad' }],
  Icon: '',
  Name: ''
});
const defaultPageManifest = {
  Controllers: [{ Actions: null, Type: 'Keypad' }],
  Icon: '',
  Name: ''
};

// Icon files: one PNG per referenced icon name, inside page 0's Images/ —
// coach pages carry only image-less plugin keys or title-only states, so
// icons never appear beyond the front page.
const imageFiles = [...ICON_REFS.values()].map((e) => ({
  name: `${folder}/Profiles/${pageUuids[0]}/Images/${e.ref.split('/').pop()}`,
  data: e.buffer
}));

const files = [
  { name: `${folder}/manifest.json`, data: Buffer.from(JSON.stringify(outerManifest, null, 2)) },
  ...pageUuids.map((u, p) => ({
    name: `${folder}/Profiles/${u}/manifest.json`,
    data: Buffer.from(JSON.stringify(pageManifest(pageActions[p]), null, 2))
  })),
  ...imageFiles,
  {
    name: `${folder}/Profiles/${defaultPageUuid}/manifest.json`,
    data: Buffer.from(JSON.stringify(defaultPageManifest, null, 2))
  }
];
const profilePath = outFile || join(ROOT, 'dist/Habit Tracker.streamDeckProfile');
writeFileSync(profilePath, zip(files));

// ---- report ---------------------------------------------------------------
console.log(`\nWrote ${profilePath}`);
console.log(`  + dist/urls.txt (manual fallback)\n`);
console.log(`Base URL : ${execBase}`);
console.log(`Habits   : from ${habitsSource}`);
const iconsFound = habits.filter((h) => iconDataUri(h.name)).length;
const animCount = useStatic
  ? 0
  : habits.filter((h) => existsSync(join(ROOT, 'icons/animated', `${h.name}.gif`))).length;
console.log(
  `Habits   : ${habits.length}   Deck: ${modelArg} (${cols}x${rows})   Pages: ${pageCount}   Flavor: ${usePlugin ? 'HabitTrackerAI plugin' : 'Web Requests plugin'}   Key: ${key ? 'yes' : 'none'}`
);
if (pageCount > 1) {
  pageActions.forEach((a, p) => console.log(`  page ${p}: ${Object.keys(a).length} keys`));
}
console.log(
  `Icons    : ${iconsFound}/${habits.length} embedded (${animCount} animated)   AI slots: ${slotCount}   Dashboard key: ${dashboardUrl || 'off'}\n`
);
for (const r of reportRows) console.log('  ' + r);
if (dashboardUrl) console.log('  📊 Stats        ' + dashboardUrl);
for (let n = 1; n <= slotCount; n++) console.log(`  ✨ AI Slot ${n}    ${buildSlotUrl(n)}`);
console.log('');

