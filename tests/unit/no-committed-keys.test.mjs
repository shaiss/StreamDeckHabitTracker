// CI guard (#112 prep): fail if anything key-like is committed. The repo is
// PUBLIC — HABIT_KEY belongs in Vercel env (Production), the browser's
// sessionStorage, and the Stream Deck app's global settings. Never here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, scanFile } from '../../tools/lib-secret-scan.mjs';
import { zip } from '../../tools/lib-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Fixtures are assembled at runtime so this file never matches itself.
const K = 'key';
const FAKE = 'Zq' + '7rT' + '9wLp';

test('tracked tree carries no HABIT_KEY material', () => {
  // Fail closed (Cipher L1): no git, no file list, or an unreadable file is a
  // failure — never a silent pass.
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  assert.ok(files.length > 50, 'git ls-files returned too few files: ' + files.length);
  const hits = [];
  for (const f of files) {
    let buf;
    try { buf = readFileSync(join(ROOT, f)); } catch (e) {
      if (e && e.code === 'ENOENT') continue;   // deleted in the working tree, not yet committed
      throw e;
    }
    hits.push(...scanFile(f, buf));
  }
  assert.deepEqual(hits, [], 'key-like values committed:\n' +
    hits.map((h) => `  ${h.file}:${h.line} (${h.rule})`).join('\n'));
});

test('scanner flags literal keys in every shape', () => {
  const bad = [
    'node tools/generate.mjs https://x/api/log --plugin --' + K + '=' + FAKE,
    'https://example.test/api/log?habit=Water&' + K + '=' + FAKE,
    "fetch(u, { headers: { 'x-habit-" + K + "': '" + FAKE + "' } })",
    'curl -H "x-habit-' + K + ': ' + FAKE + '" https://x/api/log',
    'HABIT_' + K.toUpperCase() + '=' + FAKE
  ];
  for (const s of bad) assert.ok(scanText(s).length > 0, 'missed: ' + s);
});

test('scanner allows placeholders and code that builds the value', () => {
  const ok = [
    'node tools/generate.mjs <prod>/api/log --plugin --' + K + '=<SECRET>',
    'append ?' + K + '=... when HABIT_KEY is set',
    "'&" + K + "=' + encodeURIComponent(secret)",
    "headers[KEY_HEADER] = " + K,
    'HABIT_' + K.toUpperCase() + '=<SECRET>',
    'x-habit-' + K + ': <SECRET>'
  ];
  for (const s of ok) assert.deepEqual(scanText(s), [], 'false positive: ' + s);
});

test('scanner looks inside profiles/zips for keyed Settings', () => {
  const manifest = JSON.stringify({ Actions: { '0,0': { Settings: { base: 'https://x', index: 0, [K]: FAKE } } } });
  const prof = zip([{ name: 'P.sdProfile/Profiles/A/manifest.json', data: Buffer.from(manifest) }]);
  assert.ok(scanFile('x.streamDeckProfile', prof).length > 0);
  const plugin = zip([{ name: 'com.x.sdPlugin/profiles/x.streamDeckProfile', data: prof }]);
  assert.ok(scanFile('x.streamDeckPlugin', plugin).length > 0, 'nested profile inside plugin zip');
  const clean = zip([{ name: 'P.sdProfile/manifest.json', data: Buffer.from(JSON.stringify({ Settings: { base: 'https://x' } })) }]);
  assert.deepEqual(scanFile('x.streamDeckProfile', clean), []);
});

test('fail-closed: corrupt, truncated, or odd archives are flagged', () => {
  const good = zip([{ name: 'P/manifest.json', data: Buffer.from('{}') }]);
  assert.deepEqual(scanFile('x.streamDeckProfile', good), []);
  assert.ok(scanFile('x.streamDeckProfile', Buffer.from('not a zip')).length > 0, 'garbage');
  assert.ok(scanFile('x.streamDeckProfile', good.slice(0, good.length - 30)).length > 0, 'truncated');
  const corrupt = Buffer.from(good);
  corrupt[40] ^= 0xff; corrupt[41] ^= 0xff;            // inside the deflate stream
  assert.ok(scanFile('x.streamDeckProfile', corrupt).length > 0, 'corrupt deflate');
});

test('fail-closed: non-text archive entries and stray binaries are flagged', () => {
  const blob = zip([{ name: 'P/blob.bin', data: Buffer.from([0, 1, 2, 3]) }]);
  assert.ok(scanFile('x.streamDeckPlugin', blob).length > 0, 'unknown binary entry');
  const fakePng = zip([{ name: 'P/a.png', data: Buffer.from('plain text pretending') }]);
  assert.ok(scanFile('x.streamDeckPlugin', fakePng).length > 0, 'png without magic');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.deepEqual(scanFile('a.png', png), []);
  assert.ok(scanFile('a.bin', Buffer.from([0, 0, 1])).length > 0, 'unknown binary file');
  const pngWithText = Buffer.concat([png, Buffer.from('tEXt HABIT_' + K.toUpperCase() + '=' + FAKE)]);
  assert.ok(scanFile('a.png', pngWithText).length > 0, 'key in image metadata');
});

test('bare key-like constants are caught outside profiles', () => {
  const bad = [
    "const HABIT_" + K.toUpperCase() + " = '" + FAKE + "';",
    'habit' + 'Key: "' + FAKE + '"',
    '{ "habit' + 'Key": "' + FAKE + '" }',
    "const SEC" + "RET = '" + FAKE + "';"
  ];
  for (const s of bad) assert.ok(scanText(s).length > 0, 'missed: ' + s);
  const ok = ["const SEC" + "RET = 'CHANGE_ME';", 'habit' + "Key: '<SECRET>'"];
  for (const s of ok) assert.deepEqual(scanText(s), [], 'false positive: ' + s);
});

test('value scan finds a committed value without printing it', () => {
  // A string that IS in the tree stands in for a leaked key.
  const stand = 'stream-deck-habit-tracker' + '.vercel.app';
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'tools/scan-value.mjs')],
      { cwd: ROOT, env: { ...process.env, HABIT_KEY: stand }, stdio: 'pipe' }).toString();
  } catch (e) { code = e.status; out = String(e.stdout) + String(e.stderr); }
  assert.equal(code, 1);
  assert.ok(!out.includes(stand), 'must never echo the value');
  const clean = execFileSync(process.execPath, [join(ROOT, 'tools/scan-value.mjs')],
    { cwd: ROOT, env: { ...process.env, HABIT_KEY: 'zz-' + Date.now() + '-not-in-tree' } }).toString();
  assert.match(clean, /Value scan clean/);
});

test('no docs or UI hand out URL-key links', () => {
  const files = execFileSync('git', ['ls-files', '*.md', 'public/*.html', 'public/*.js'], { cwd: ROOT })
    .toString().split('\n').filter((f) => f && !f.startsWith('docs/superpowers/'));
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /deck\.html\?key=|\[&key=/, f + ' suggests a ?key= link');
  }
});
