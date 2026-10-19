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
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  } catch {
    return; // not a git checkout (e.g. a tarball) — nothing to scan
  }
  const hits = [];
  for (const f of files) {
    let buf;
    try { buf = readFileSync(join(ROOT, f)); } catch { continue; }
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
