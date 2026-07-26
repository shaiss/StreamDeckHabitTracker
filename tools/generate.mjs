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
import { deflateRawSync } from 'node:zlib';

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
  any: ''
};
const COLS = { original: 5, mk2: 5, mini: 3, xl: 8, any: 5 };
const deviceModel = MODELS[modelArg] ?? MODELS.mk2;
const cols = COLS[modelArg] ?? COLS.mk2;

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

// ---- 1) urls.txt (guaranteed manual path) ---------------------------------
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const rows = habits.map((h) => `${(h.emoji || '').padEnd(2)} ${h.label.padEnd(12)} ${buildUrl(h)}`);
const urlsTxt =
  `Web Request buttons (Method: GET). One per key.\n` +
  `Plugin: "Web Requests" by data-enabler (install from the Stream Deck Marketplace).\n\n` +
  habits.map((h) => `Title: ${h.emoji} ${h.label}\n  URL: ${buildUrl(h)}\n  Method: GET`).join('\n\n') +
  (dashboardUrl
    ? `\n\n--- Dashboard key (optional) ---\n` +
      `Action: System -> Website (built-in). Opens the dashboard in a browser.\n` +
      `Title: 📊 Stats\n  URL: ${dashboardUrl}`
    : '') +
  `\n\nIcons: animated GIFs in icons/animated/, stills in icons/ (drag one onto a key to set its image).\n`;
writeFileSync(join(ROOT, 'dist/urls.txt'), urlsTxt);

// ---- 2) .streamDeckProfile (convenience) ----------------------------------
const profileUuid = randomUUID().toUpperCase();
const pageUuid = randomUUID().toUpperCase();
const folder = `${profileUuid}.sdProfile`;

const actions = {};
habits.forEach((h, i) => {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const img = iconDataUri(h.name);
  actions[`${col},${row}`] = {
    ActionID: randomUUID().toUpperCase(),
    Name: 'HTTP Request',
    Settings: { url: buildUrl(h), method: 'GET', contentType: '', headers: '', body: '' },
    State: 0,
    States: [
      {
        FFamily: '',
        FSize: '14',
        FStyle: '',
        FUnderline: 'off',
        Image: img,
        Title: `${h.emoji} ${h.label}`,
        TitleAlignment: 'middle',
        TitleColor: '#ffffff',
        // The icon already has the label baked in; only show a text title as a
        // fallback when there's no icon.
        TitleShow: img ? false : true
      }
    ],
    UUID: 'gg.datagram.web-requests.http'
  };
});

// 6th key: open the dashboard in a browser (built-in Website action).
if (dashboardUrl) {
  const i = habits.length;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const img = iconDataUri('_dashboard');
  actions[`${col},${row}`] = {
    ActionID: randomUUID().toUpperCase(),
    Name: 'Website',
    Settings: { path: dashboardUrl, openInBrowser: true },
    State: 0,
    States: [
      {
        FFamily: '',
        FSize: '14',
        FStyle: '',
        FUnderline: 'off',
        Image: img,
        Title: '📊 Stats',
        TitleAlignment: 'middle',
        TitleColor: '#ffffff',
        TitleShow: img ? false : true
      }
    ],
    UUID: 'com.elgato.streamdeck.system.website'
  };
}

const outerManifest = {
  AppIdentifier: '',
  DeviceModel: deviceModel,
  DeviceUUID: '',
  Name: 'Habit Tracker',
  Pages: { Current: pageUuid, Pages: [pageUuid] },
  Version: '1.0'
};
const pageManifest = {
  Actions: actions,
  DeviceModel: deviceModel,
  DeviceUUID: '',
  Name: 'Habit Tracker',
  Version: '1.0'
};

const files = [
  { name: `${folder}/manifest.json`, data: Buffer.from(JSON.stringify(outerManifest, null, 2)) },
  {
    name: `${folder}/Profiles/${pageUuid}/manifest.json`,
    data: Buffer.from(JSON.stringify(pageManifest, null, 2))
  }
];
writeFileSync(join(ROOT, 'dist/Habit Tracker.streamDeckProfile'), zip(files));

// ---- report ---------------------------------------------------------------
console.log('\nGenerated in dist/:');
console.log('  - urls.txt                      (paste these into your buttons - always works)');
console.log('  - Habit Tracker.streamDeckProfile  (double-click to import - convenience)\n');
console.log(`Base URL : ${execBase}`);
const iconsFound = habits.filter((h) => iconDataUri(h.name)).length;
const animCount = useStatic
  ? 0
  : habits.filter((h) => existsSync(join(ROOT, 'icons/animated', `${h.name}.gif`))).length;
console.log(
  `Habits   : ${habits.length}   Deck: ${modelArg} (${cols} cols)   Key: ${key ? 'yes' : 'none'}`
);
console.log(
  `Icons    : ${iconsFound}/${habits.length} embedded (${animCount} animated)   Dashboard key: ${dashboardUrl || 'off'}\n`
);
for (const r of rows) console.log('  ' + r);
if (dashboardUrl) console.log('  📊 Stats        ' + dashboardUrl);
console.log('');

// ---- tiny zero-dep ZIP writer (DEFLATE) -----------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const time = 0;
  const date = 0x21; // 1980-01-01, stable output
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    offset += lh.length + name.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c);
    cdSize += c.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}
