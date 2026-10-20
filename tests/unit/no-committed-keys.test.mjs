// CI guard (#112 prep): fail if anything key-like is committed. The repo is
// PUBLIC — HABIT_KEY belongs in Vercel env (Production), the browser's
// sessionStorage, and the Stream Deck app's global settings. Never here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIfPresent, scanText, scanFile, valueNeedles, findKeyLinkHandoffs } from '../../tools/lib-secret-scan.mjs';
import { keyedOutputAllowed, writeKeyedOutput } from '../../tools/lib-keyed-output.mjs';
import { zip } from '../../tools/lib-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Fixtures are assembled at runtime so this file never matches itself.
const K = 'key';
const FAKE = 'Zq' + '7rT' + '9wLp';
const QK = '?' + K + '=';
const AK = '&' + K + '=';

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

test('fail-closed: unknown binary without a NUL byte is not scanned as text', () => {
  const noNul = Buffer.from([0x01, 0x02, 0xff, 0xfe, 0x80, 0x7f]);
  assert.equal(noNul.includes(0), false);
  const hit = scanFile('blob.bin', noNul);
  assert.ok(hit.some((h) => h.rule === 'unscannable binary file'), 'extensionless-of-binary');
  assert.ok(scanFile('font.woff', Buffer.from('OTTO not a real font')).some((h) => h.rule === 'unscannable binary file'));
  // Supported text and recognized images still pass when they are clean.
  assert.deepEqual(scanFile('note.txt', Buffer.from('hello\n')), []);
  assert.deepEqual(scanFile('LICENSE', Buffer.from('MIT\n')), []);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.deepEqual(scanFile('a.gif', gif), []);
  assert.deepEqual(scanFile('a.jpg', jpeg), []);
  assert.deepEqual(scanFile('a.jpeg', jpeg), []);
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

test('value needles cover form encoding of spaces and reserved characters', () => {
  const secret = 'p q!r(s)*t\'u';
  const needles = valueNeedles(secret).map((b) => b.toString('utf8'));
  const uri = encodeURIComponent(secret);
  const form = new URLSearchParams();
  form.set('k', secret);
  const formEnc = form.toString().slice(2);
  assert.notEqual(formEnc, uri, 'fixture must differ from encodeURIComponent');
  assert.match(formEnc, /\+/);
  assert.match(formEnc, /%21/);
  for (const n of [secret, uri, formEnc, uri.replace(/%20/g, '+')]) {
    assert.ok(needles.includes(n), 'missing needle ' + n);
    const only = Buffer.from('prefix?key=' + n + '&x=1');
    assert.ok(valueNeedles(secret).some((b) => only.includes(b)), 'buffer with only ' + n);
  }
  // A profile URL that carries just the form encoding must not depend on the
  // raw value or encodeURIComponent being present.
  const shipped = Buffer.from('https://example.test/api/log?' + form.toString());
  assert.equal(shipped.includes(Buffer.from(secret)), false);
  assert.equal(shipped.includes(Buffer.from(uri)), false);
  assert.ok(valueNeedles(secret).some((b) => shipped.includes(b)));
});

test('readIfPresent skips a missing file and rethrows other errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ht-read-'));
  try {
    assert.equal(readIfPresent(join(dir, 'gone.txt')), null);
    const present = join(dir, 'here.txt');
    writeFileSync(present, 'ok');
    assert.equal(readIfPresent(present).toString(), 'ok');
    assert.throws(() => readIfPresent(join(present, 'not-a-directory')), (e) => e && e.code !== 'ENOENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keyed --key output follows symlinks and stays inside dist/', () => {
  const generateSrc = readFileSync(join(ROOT, 'tools/generate.mjs'), 'utf8');
  assert.match(generateSrc, /keyedOutputAllowed\(profilePath, ROOT\)/);
  assert.match(generateSrc, /writeKeyedOutput\(profilePath, ROOT, profileBytes\)/);
  const root = mkdtempSync(join(tmpdir(), 'ht-key-'));
  try {
    mkdirSync(join(root, 'public/downloads'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'Habit Tracker.streamDeckProfile'), root), true);
    assert.equal(keyedOutputAllowed(join(root, 'public/downloads/x.streamDeckProfile'), root), false);
    assert.equal(keyedOutputAllowed(join(root, 'dist', '..', 'public', 'downloads', 'x.streamDeckProfile'), root), false);
    assert.equal(keyedOutputAllowed(join(tmpdir(), 'outside-' + Date.now() + '.streamDeckProfile'), root), true);
    rmSync(join(root, 'dist'), { recursive: true });
    symlinkSync(join(root, 'public/downloads'), join(root, 'dist'), 'dir');
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'Habit Tracker.streamDeckProfile'), root), false, 'symlinked dist/');
    rmSync(join(root, 'dist'));
    mkdirSync(join(root, 'dist'));
    symlinkSync(join(root, 'public/downloads'), join(root, 'dist', 'via'), 'dir');
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'via', 'p.streamDeckProfile'), root), false, 'symlinked child of dist/');
    writeFileSync(join(root, 'public/downloads/leaked.streamDeckProfile'), 'x');
    symlinkSync(join(root, 'public/downloads/leaked.streamDeckProfile'), join(root, 'dist', 'link.streamDeckProfile'));
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'link.streamDeckProfile'), root), false, 'symlinked outfile');
    // A dangling final symlink is not a missing file: its lexical path is
    // inside dist/, and writeFileSync would create the not-yet-existing target.
    const danglingTarget = join(root, 'public/downloads/not-yet.streamDeckProfile');
    symlinkSync(danglingTarget, join(root, 'dist', 'dangling.streamDeckProfile'));
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'dangling.streamDeckProfile'), root), false, 'dangling outfile symlink');
    symlinkSync(join(root, 'public/downloads/missing-dir'), join(root, 'dist', 'dangling-dir'));
    assert.equal(keyedOutputAllowed(join(root, 'dist', 'dangling-dir', 'p.streamDeckProfile'), root), false, 'dangling parent symlink');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keyed write rejects dangling symlinks and does not follow them', () => {
  const root = mkdtempSync(join(tmpdir(), 'ht-keyw-'));
  try {
    mkdirSync(join(root, 'public/downloads'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    const secret = Buffer.from('keyed-profile-bytes');
    const danglingTarget = join(root, 'public/downloads/not-yet.streamDeckProfile');
    const link = join(root, 'dist', 'dangling.streamDeckProfile');
    symlinkSync(danglingTarget, link);
    assert.throws(() => writeKeyedOutput(link, root, secret), (e) => e && e.code === 'EPERM');
    assert.equal(existsSync(danglingTarget), false, 'dangling target was created');
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'dangling link must stay unfollowed');

    const liveTarget = join(root, 'public/downloads/live.streamDeckProfile');
    writeFileSync(liveTarget, 'keep');
    const liveLink = join(root, 'dist', 'live.streamDeckProfile');
    symlinkSync(liveTarget, liveLink);
    assert.throws(() => writeKeyedOutput(liveLink, root, secret), (e) => e && e.code === 'EPERM');
    assert.equal(readFileSync(liveTarget, 'utf8'), 'keep');

    symlinkSync(join(root, 'public/downloads/missing-dir'), join(root, 'dist', 'dangling-dir'));
    assert.throws(
      () => writeKeyedOutput(join(root, 'dist', 'dangling-dir', 'p.streamDeckProfile'), root, secret),
      (e) => e && e.code === 'EPERM'
    );
    assert.equal(existsSync(join(root, 'public/downloads/missing-dir')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keyed write publishes through a pinned directory and not through a hardlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'ht-keypin-'));
  try {
    mkdirSync(join(root, 'public/downloads'), { recursive: true });
    mkdirSync(join(root, 'dist/nested'), { recursive: true });
    const secret = Buffer.from('pinned-secret');
    const out = join(root, 'dist', 'Habit Tracker.streamDeckProfile');
    writeKeyedOutput(out, root, secret);
    assert.equal(readFileSync(out).equals(secret), true);
    const st = lstatSync(out);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    assert.equal(st.nlink, 1);

    const nested = join(root, 'dist/nested/p.streamDeckProfile');
    writeKeyedOutput(nested, root, secret);
    assert.equal(readFileSync(nested).equals(secret), true);

    // A symlink whose target is also inside dist/ still passes the allow
    // check (the real path is inside dist/). writeFileSync would follow it
    // and overwrite the target; the pinned publish must replace the link.
    const inner = join(root, 'dist', 'inner.streamDeckProfile');
    writeFileSync(inner, 'inner');
    const alias = join(root, 'dist', 'alias.streamDeckProfile');
    symlinkSync(inner, alias);
    assert.equal(keyedOutputAllowed(alias, root), true);
    writeKeyedOutput(alias, root, secret);
    assert.equal(readFileSync(inner, 'utf8'), 'inner');
    assert.equal(lstatSync(alias).isSymbolicLink(), false);
    assert.equal(readFileSync(alias).equals(secret), true);

    const shipped = join(root, 'public/downloads/shared.streamDeckProfile');
    writeFileSync(shipped, 'shipped');
    const linked = join(root, 'dist', 'shared.streamDeckProfile');
    linkSync(shipped, linked);
    writeKeyedOutput(linked, root, secret);
    assert.equal(readFileSync(shipped, 'utf8'), 'shipped', 'hardlink target must not receive the secret');
    assert.equal(readFileSync(linked).equals(secret), true);
    assert.equal(lstatSync(linked).nlink, 1);

    const outside = join(tmpdir(), 'outside-' + Date.now() + '.streamDeckProfile');
    try {
      writeKeyedOutput(outside, root, secret);
      assert.equal(readFileSync(outside).equals(secret), true);
    } finally {
      rmSync(outside, { force: true });
    }

    assert.throws(
      () => writeKeyedOutput(join(root, 'public/downloads/x.streamDeckProfile'), root, secret),
      (e) => e && e.code === 'EPERM'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findKeyLinkHandoffs flags URL, encoded, concat, and template forms', () => {
  const bad = [
    'see https://example.test/api/log' + QK + 'SECRET',
    'open deck.html' + QK + 'x',
    'paste /api/log?habit=Water' + AK + 'x',
    // URL-encoded ?key= / &key=
    'https://example.test/api/log%3F' + K + '%3D' + FAKE,
    'https://example.test/x%3f' + K + '%3d' + FAKE,
    '/api/log%26' + K + '%3D' + FAKE,
    "const u = base + '" + QK + "' + secret",
    'const u = base + "' + AK + '" + secret',
    'const u = base + `' + QK + '` + secret',
    'const u = `/api/log' + QK + '${secret}`',
    'const u = `https://x/api/log?habit=Water' + AK + '${k}`',
    "const u = base + '?' + '" + K + "=' + secret",
    'const u = base + "&" + "' + K + '=" + secret',
    "const u = base + '?' + \"" + K + "=\" + secret"
  ];
  for (const s of bad) {
    assert.ok(findKeyLinkHandoffs(s).length > 0, 'missed handoff: ' + s);
  }
});

test('findKeyLinkHandoffs allows bare mentions and unrelated words', () => {
  const ok = [
    'The server still accepts ' + QK + ' during the transition.',
    'rejecting ' + QK + ' there is issue #115',
    'append ' + QK + '... when HABIT_KEY is set',
    'keyboard shortcuts and hotkey=1 stay fine',
    'passkey= or monkey= must not trip this',
    '/api/slots?deck=1&keys=15',
    '/api/log?hkey=1&intensity=high',
    "params.get('" + K + "')",
    'searchParams.get("' + K + '")',
    "headers['x-habit-" + K + "'] = secret",
    'Do not put HABIT_KEY in these URLs — send x-habit-key as a header'
  ];
  for (const s of ok) {
    assert.deepEqual(findKeyLinkHandoffs(s), [], 'false positive: ' + s);
  }
});

test('no docs or UI hand out URL-key links', () => {
  const files = execFileSync('git', ['ls-files', '*.md', 'public/*.html', 'public/*.js', 'public/*.ps1'], { cwd: ROOT })
    .toString().split('\n').filter((f) => f && !f.startsWith('docs/superpowers/'));
  // Bare mentions of the legacy parameter (`?key=` in migration notes) have
  // no path in front and stay allowed; construction and encoded forms do not.
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    const hits = findKeyLinkHandoffs(s);
    assert.deepEqual(hits, [], f + ' hands out a keyed URL:\n' +
      hits.map((h) => `  ${h.line}: ${h.rule} ${JSON.stringify(h.match)}`).join('\n'));
  }
});

test('generate --key keeps ?key= out of urls.txt and stdout', () => {
  // Source-level guard: public/manual URL builders default to withKey:false,
  // and only Web Requests profile Settings opt into withKey:true (those bytes
  // go through writeKeyedOutput; they are never printed).
  const src = readFileSync(join(ROOT, 'tools/generate.mjs'), 'utf8');
  assert.match(src, /withKey\s*=\s*false/);
  assert.match(src, /buildUrl\(h,\s*\{\s*withKey:\s*true\s*\}\)/);
  assert.match(src, /buildSlotUrl\(n,\s*\{\s*withKey:\s*true\s*\}\)/);
  // reportRows / urls.txt use the unkeyed form (no second arg).
  assert.match(src, /buildUrl\(h\)\}/);
  assert.match(src, /buildSlotUrl\(i \+ 1\)\}/);
  // Stdout report must use the same unkeyed builders (reportRows / buildSlotUrl
  // without withKey), never a raw q.set('key') beside the console.log loop.
  const reportAt = src.indexOf('// ---- report');
  assert.ok(reportAt >= 0, 'report marker missing in tools/generate.mjs');
  const report = src.slice(reportAt);
  assert.doesNotMatch(report, /withKey:\s*true/);
  assert.doesNotMatch(report, /\.set\(\s*['"]key['"]/);
});

test('generate --key runtime keeps key out of urls.txt and stdout', () => {
  // Runtime companion to the source-level guard above: a future edit could keep
  // the regexes green while still appending --key onto printed/manual URLs.
  // Dummy value only — never env, never a real secret. generate.mjs always
  // writes dist/urls.txt (+ a keyed profile under dist/); restore afterward.
  const fakeKey = 'Zq' + '7rT' + '9wLp';
  const urlsPath = join(ROOT, 'dist/urls.txt');
  const profilePath = join(ROOT, 'dist/Habit Tracker.streamDeckProfile');
  const prevUrls = existsSync(urlsPath) ? readFileSync(urlsPath) : null;
  const prevProfile = existsSync(profilePath) ? readFileSync(profilePath) : null;
  try {
    const stdout = execFileSync(process.execPath, [
      join(ROOT, 'tools/generate.mjs'),
      'http://127.0.0.1:9/api/log',
      '--' + K + '=' + fakeKey,
      '--static',
      '--slots=1',
      '--no-dashboard',
      '--model=mini'
    ], { cwd: ROOT, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!stdout.includes(QK), 'stdout contains ' + QK);
    assert.ok(!stdout.includes(AK), 'stdout contains ' + AK);
    assert.ok(!stdout.includes(fakeKey), 'stdout leaks --key value');
    const urls = readFileSync(urlsPath, 'utf8');
    assert.ok(!urls.includes(QK), 'urls.txt contains ' + QK);
    assert.ok(!urls.includes(AK), 'urls.txt contains ' + AK);
    assert.ok(!urls.includes(fakeKey), 'urls.txt leaks --key value');
  } finally {
    if (prevUrls) writeFileSync(urlsPath, prevUrls);
    else if (existsSync(urlsPath)) rmSync(urlsPath);
    if (prevProfile) writeFileSync(profilePath, prevProfile);
    else if (existsSync(profilePath)) rmSync(profilePath);
  }
});
