// Key-leak scanner (#112 prep). The repo is PUBLIC: HABIT_KEY must never be
// committed or shipped. Used by tests/unit/no-committed-keys.test.mjs (CI)
// and as a hard guard in build-plugin.mjs / generate.mjs. Zero deps.
//
// Flags, in plain text:
//   --key=<value>           unless the value is a placeholder
//   [?&]key=<value>         literal URL keys (code that concatenates is fine)
//   x-habit-key: <value>    a hardcoded header value (JSON/JS or curl style)
//   HABIT_KEY=<value>       an env assignment with a literal value
//   HABIT_KEY/habitKey/SECRET = '<value>'   a bare constant, anywhere
// and, inside .streamDeckProfile / .streamDeckPlugin zips (inflated):
//   any action Settings carrying a non-empty "key" or "habitKey".
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// Values that are obviously documentation, not secrets.
const PLACEHOLDER = /^(?:<[^>]*>|\.\.\.|…|SECRET|CHANGE[_-]?ME|YOUR[_-]?KEY|\$\{?[A-Za-z_][\w]*\}?|%[A-Za-z_]+%|\$env:[A-Za-z_]+|xxx+|\[redacted\])$/i;
const isPlaceholder = (v) => !v || PLACEHOLDER.test(v);

const RULES = [
  { name: '--key=', re: /--key=([^\s"'`)\]]+)/g },
  { name: '?key=', re: /[?&]key=([A-Za-z0-9_\-.~%]{6,})/g },
  { name: 'x-habit-key value', re: /["']?x-habit-key["']?\s*[:=]\s*["'`]([^"'`\s]+)["'`]/gi },
  { name: 'x-habit-key header', re: /x-habit-key:\s*([^\s"'`]+)/gi },
  { name: 'HABIT_KEY=', re: /\bHABIT_KEY\s*=\s*["']?([^\s"'`;]+)/g },
  // Bare constants anywhere in text, not just inside profiles (Cipher L1):
  // const HABIT_KEY = '…', habitKey: "…", { "habitKey": "…" }, SECRET = '…'.
  // Value must look like a token (≥6 chars, no spaces) — prose and regex
  // source are not keys.
  { name: 'key constant', re: /\b(?:HABIT_KEY|habitKey|habit_key|HABITKEY|SECRET)["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-.~+/=]{6,})["'`]/g }
];

export function scanText(text, file = '') {
  const hits = [];
  for (const { name, re } of RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let v = m[1].replace(/[,.;:]+$/, '');
      if (isPlaceholder(v)) continue;
      // Code, not data: `?key=' + x`, template `${k}`, `=$KEY`.
      if (/^[+$({\\[]/.test(v)) continue;   // also regex source like \s*(…)
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file, line, rule: name });
    }
  }
  return hits;
}

// Minimal ZIP reader (local headers; DEFLATE or stored) — enough for the
// archives tools/lib-zip.mjs writes. FAIL-CLOSED (Cipher L1): anything it
// cannot fully read throws, and the caller reports it as a hit.
export function unzipEntries(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    if (i + 30 > buf.length) throw new Error('truncated local header');
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const usize = buf.readUInt32LE(i + 22);
    const nlen = buf.readUInt16LE(i + 26);
    const xlen = buf.readUInt16LE(i + 28);
    if (flags & 0x08) throw new Error('data-descriptor entries are not supported');
    if (flags & 0x01) throw new Error('encrypted entry');
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const start = i + 30 + nlen + xlen;
    if (start + csize > buf.length) throw new Error('truncated entry ' + name);
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 8) data = inflateRawSync(raw);       // throws on corrupt data
    else if (method === 0) data = raw;
    else throw new Error('unsupported compression method ' + method + ' for ' + name);
    if (data.length !== usize) throw new Error('size mismatch for ' + name);
    out.push({ name, data });
    i = start + csize;
  }
  // Whatever follows the last entry must be the central directory, closed by
  // an end-of-central-directory record that counts exactly these entries.
  if (i + 4 > buf.length || buf.readUInt32LE(i) !== 0x02014b50) {
    throw new Error(out.length ? 'unexpected bytes after entries' : 'not a zip archive');
  }
  const eocd = buf.length - 22;
  if (eocd < i || buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('missing end-of-central-directory');
  if (buf.readUInt16LE(eocd + 10) !== out.length) throw new Error('entry count mismatch');
  return out;
}

function settingsHits(json, file) {
  const hits = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.Settings && typeof o.Settings === 'object') {
      for (const f of ['key', 'habitKey']) {
        const v = o.Settings[f];
        if (typeof v === 'string' && v.trim() && !isPlaceholder(v.trim())) hits.push({ file, line: 0, rule: 'profile Settings.' + f });
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return hits;
}

const ZIPPED = /\.(streamDeckProfile|streamDeckPlugin)$/;
const TEXTY = /\.(json|txt|js|mjs|cjs|html|css|md|ps1|sh|yml|yaml|gs|svg|gitignore)$|(^|\/)(LICENSE|\.gitignore)$/i;
// Binary formats we accept, each only with the right magic bytes.
const IMAGES = [
  { re: /\.png$/i, magic: [0x89, 0x50, 0x4e, 0x47] },
  { re: /\.gif$/i, magic: [0x47, 0x49, 0x46, 0x38] },
  { re: /\.jpe?g$/i, magic: [0xff, 0xd8, 0xff] }
];

function scanImage(name, buf) {
  const kind = IMAGES.find((k) => k.re.test(name));
  if (!kind) return null;
  if (!kind.magic.every((b, j) => buf[j] === b)) return [{ file: name, line: 0, rule: 'image with wrong magic bytes' }];
  // Metadata chunks (PNG tEXt, GIF comments) are text too.
  return scanText(buf.toString('latin1'), name).map((h) => ({ ...h, line: 0 }));
}

export function scanArchive(buf, file) {
  let entries;
  try { entries = unzipEntries(buf); } catch (e) {
    return [{ file, line: 0, rule: 'unreadable archive: ' + e.message }];
  }
  const hits = [];
  for (const e of entries) {
    const name = file + '!' + e.name;
    if (e.name.endsWith('/') && e.data.length === 0) continue;   // directory entry
    if (ZIPPED.test(e.name)) { hits.push(...scanArchive(e.data, name)); continue; }
    const img = scanImage(e.name, e.data);
    if (img) { hits.push(...img); continue; }
    if (!TEXTY.test(e.name) || e.data.includes(0)) {
      hits.push({ file: name, line: 0, rule: 'unscannable (non-text) archive entry' });
      continue;
    }
    const text = e.data.toString('utf8');
    hits.push(...scanText(text, name));
    if (/\.json$/i.test(e.name)) {
      try { hits.push(...settingsHits(JSON.parse(text), name)); } catch {
        hits.push({ file: name, line: 0, rule: 'unparseable JSON in archive' });
      }
    }
  }
  return hits;
}

export function scanFile(name, buf) {
  if (ZIPPED.test(name)) return scanArchive(buf, name);
  const img = scanImage(name, buf);
  if (img) return img;
  // Unknown binaries are not text just because they lack a NUL. Only the
  // extensions this repo actually commits are scanned as text; everything
  // else (and any NUL) fails closed. PNG/GIF/JPEG are handled above.
  if (!TEXTY.test(name) || buf.includes(0)) {
    return [{ file: name, line: 0, rule: 'unscannable binary file' }];
  }
  return scanText(buf.toString('utf8'), name);
}

// Missing working-tree files (deleted, not yet committed) are skipped.
// Any other read error propagates — a scan that cannot read is a failure.
export function readIfPresent(path) {
  try { return readFileSync(path); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// Byte needles for a secret value: raw, encodeURIComponent, URLSearchParams
// form encoding (plus-for-space and its percent escapes), and the
// encodeURIComponent form with spaces turned into '+'.
export function valueNeedles(value) {
  const form = new URLSearchParams();
  form.set('k', value);
  const formEnc = form.toString().slice(2);
  const uri = encodeURIComponent(value);
  const plusSpace = uri.replace(/%20/g, '+');
  return [...new Set([value, uri, formEnc, plusSpace])].map((v) => Buffer.from(v, 'utf8'));
}
