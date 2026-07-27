#!/usr/bin/env node
// SPIKE ARTIFACT — issue #42. Throwaway, not part of the build.
//
// Emits a THREE-page .streamDeckProfile so the page taxonomy from the #42
// proposal can be felt on real hardware before anything is committed to.
// tools/generate.mjs deliberately emits exactly one page; rather than fork it,
// this stands alone so the production generator stays honest about what it
// currently supports.
//
//   node tools/spike-multipage.mjs [--base=https://…] [--out=dist/spike.streamDeckProfile]
//
// Page taxonomy under test — pages divide by TAP LATENCY, not by topic:
//   1 "Ritual"  the reflexive layer. Habits + Stats + the two front AI slots.
//               Nothing here may ever sit behind a page flip.
//   2 "Coach"   the considered layer. All four AI slots with room to breathe,
//               plus the coach's own keys.
//   3 "Manage"  the rare layer. Roster decisions, dashboards, setup.
//
// Everything on-disk here was read off Shai's real ProfilesV3 rather than
// guessed — see the NAV shape below.
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zip } from './lib-zip.mjs';
import { loadHabits } from './lib-habits.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=').slice(1).join('=');

const BASE = arg('base', 'https://stream-deck-habit-tracker.vercel.app');
const OUT = arg('out', join(ROOT, 'dist/HabitTracker-3page-SPIKE.streamDeckProfile'));
const COLS = 5, ROWS = 3;

const { habits } = await loadHabits(BASE, ROOT);
console.log(`habits (${habits.length}): ${habits.map((h) => h.name).join(', ')}`);

const uuid = () => randomUUID().toUpperCase();
const profileUuid = uuid();
const folder = `${profileUuid}.sdProfile`;

// ---- key builders ---------------------------------------------------------

// ⚠️ Plugin keys carry NO baked image: SD 7.x treats a profile image as a user
// customization and silently vetoes every setImage, so the key would never
// repaint. Same rule as generate.mjs's liveStates().
const live = () => [{ ShowTitle: false, TitleAlignment: 'middle', TitleColor: '#ffffff' }];
const titled = (t) => [{ ShowTitle: true, Title: t, TitleAlignment: 'middle', TitleColor: '#ffffff' }];

const habitKey = (index) => ({
  ActionID: uuid(), LinkedTitle: true, Name: 'Habit Key',
  Settings: { base: BASE, index },
  Resources: null, State: 0, States: live(),
  UUID: 'com.shaiss.habit-tracker.habit'
});

const slotKey = (slot) => ({
  ActionID: uuid(), LinkedTitle: true, Name: 'AI Slot Key',
  Settings: { base: BASE, slot },
  Resources: null, State: 0, States: live(),
  UUID: 'com.shaiss.habit-tracker.slot'
});

const webKey = (title, url) => ({
  ActionID: uuid(), LinkedTitle: true, Name: 'Website',
  Settings: { path: url }, Resources: null, State: 0, States: titled(title),
  UUID: 'com.elgato.streamdeck.system.website'
});

// Built-in page navigation. Exact shape lifted from a real ProfilesV3 profile:
// Settings is empty, States is a single EMPTY object (the app supplies the
// chevron art itself), and a Plugin block names the Pages plugin. No plugin
// code of ours is involved in navigation at all.
const navKey = (dir) => ({
  ActionID: uuid(), LinkedTitle: true,
  Name: dir === 'next' ? 'Next Page' : 'Previous Page',
  Plugin: { Name: 'Pages', UUID: 'com.elgato.streamdeck.page', Version: '1.0' },
  Resources: null, Settings: {}, State: 0, States: [{}],
  UUID: `com.elgato.streamdeck.page.${dir}`
});

// ---- pages ----------------------------------------------------------------

// Actions are keyed "col,row". A page is built from an explicit map so the
// layout is readable here instead of implied by a fill order.
function page(place) {
  const actions = {};
  for (const [cell, action] of Object.entries(place)) if (action) actions[cell] = action;
  return { Controllers: [{ Actions: actions, Type: 'Keypad' }], Icon: '', Name: '' };
}

const at = (col, row) => `${col},${row}`;

// Page 1 — Ritual. Habits fill row-major from the top-left; the two front AI
// slots take the tail. Next-page lives bottom-right, the corner your thumb
// already rests on.
const ritual = {};
let cell = 0;
for (const _ of habits) {
  ritual[at(cell % COLS, Math.floor(cell / COLS))] = habitKey(cell);
  cell++;
}
// Reserve the bottom row's outer corners for navigation before filling.
const RESERVED = new Set([at(0, ROWS - 1), at(COLS - 1, ROWS - 1)]);
const nextFree = () => {
  while (cell < COLS * ROWS) {
    const c = at(cell % COLS, Math.floor(cell / COLS));
    cell++;
    if (!RESERVED.has(c) && !ritual[c]) return c;
  }
  return null;
};
ritual[nextFree()] = webKey('📊 Stats', BASE + '/');
ritual[nextFree()] = slotKey(1);
ritual[nextFree()] = slotKey(2);
ritual[at(COLS - 1, ROWS - 1)] = navKey('next');

// Page 2 — Coach. All four slots, spaced out, with the coach's own keys.
const coach = {
  [at(1, 0)]: slotKey(1), [at(2, 0)]: slotKey(2), [at(3, 0)]: slotKey(3),
  [at(2, 1)]: slotKey(4),
  [at(0, ROWS - 1)]: navKey('previous'),
  [at(COLS - 1, ROWS - 1)]: navKey('next')
};

// Page 3 — Manage. Rare, deliberate, and safely behind two flips.
const manage = {
  [at(1, 0)]: webKey('🧠 Mind', BASE + '/mind.html'),
  [at(2, 0)]: webKey('🗂 Habits', BASE + '/habits.html'),
  [at(3, 0)]: webKey('🎛 Deck', BASE + '/deck.html'),
  [at(0, ROWS - 1)]: navKey('previous')
};

const pages = [
  { id: uuid(), manifest: page(ritual) },
  { id: uuid(), manifest: page(coach) },
  { id: uuid(), manifest: page(manage) }
];
// The app also wants an empty fallback page, referenced from Pages.Default and
// deliberately NOT listed in Pages.Pages.
const defaultPage = { id: uuid(), manifest: page({}) };

const outer = {
  Device: { Model: '20GBA9901', UUID: '' },   // MK.2
  Name: 'Habit Tracker AI (3-page SPIKE)',
  Pages: {
    Current: pages[0].id.toLowerCase(),
    Default: defaultPage.id.toLowerCase(),
    Pages: pages.map((p) => p.id.toLowerCase())
  },
  Version: '3.0'
};

const files = [
  { name: `${folder}/manifest.json`, data: Buffer.from(JSON.stringify(outer, null, 2)) },
  ...[...pages, defaultPage].map((p) => ({
    name: `${folder}/Profiles/${p.id}/manifest.json`,
    data: Buffer.from(JSON.stringify(p.manifest, null, 2))
  }))
];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip(files));

console.log(`\nWrote ${OUT}`);
pages.forEach((p, i) => {
  const n = Object.keys(p.manifest.Controllers[0].Actions).length;
  console.log(`  page ${i + 1}: ${n} keys`);
});
console.log('\nImport it, then flip with the bottom-corner keys. Nothing in the');
console.log('plugin knows pages exist — navigation is entirely built-in actions.');
