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

// Docs/UI handoff detector (#115 / #121 / #138): flag text that hands a
// caller a keyed URL. Bare mentions of the legacy parameter (`?key=` in
// migration notes) with no path/URL in front stay allowed. Does not flag
// hkey=/keys=/keyboard=/monkey=/x-habit-key, or searchParams.get('key').
//
// Catches: ?key= and &key= on URLs/paths (including HTML-escaped &amp;key=
// and numeric entities &#38;/&#x26;), URL-encoded forms, string/template
// construction, URLSearchParams writers on USP-like receivers (including
// aliased `.searchParams` locals and template-literal names), plus
// URLSearchParams inits (object / array-of-pairs / string / template).
//
// Long-line safety (#138): concat / USP-receiver runs are bounded so a
// 30k+ no-whitespace token stays linear (the old keyed-url prefix was
// ~1.2s quadratic). Keyed-url matching is needle-first + linear token
// walk (prefix length is not capped — a 600+ char path still hits).

// Max run of string interior without whitespace (#138).
const MAX_STR_RUN = 512;
// `a.b.c.searchParams` — cap id length and chain depth (#138).
const MAX_USP_ID = 64;
const MAX_USP_DEPTH = 6;

// Receivers that look like URLSearchParams (not Map / localStorage / …).
const USP_WRITER_RECEIVER =
  String.raw`(?:q|params|searchParams|(?:[A-Za-z_$][\w$]{0,${MAX_USP_ID - 1}}\.){1,${MAX_USP_DEPTH}}searchParams)`;
// Name argument: 'key' / "key" / `key`
const KEY_NAME_LIT = String.raw`['"\`]key['"\`]`;

/** Token delimiter set (same stop chars as the old KEY_LINK_PREFIX_RE). */
function isKeyLinkDelim(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '"' ||
    c === "'" || c === '`' || c === ')' || c === ']' || c === '>';
}

/**
 * URL / absolute path / *.html prefix for a keyed query (shape only).
 * Index form so multi-needle scans never re-slice a growing `before` string.
 */
function isKeyLinkPrefixRange(text, start, end) {
  if (end <= start) return false;
  if (text[start] === '/') return true;
  // https?:// — fixed-window head check (O(1)).
  if (end - start >= 7) {
    const a = text[start];
    const b = text[start + 1];
    const c = text[start + 2];
    const d = text[start + 3];
    if ((a === 'h' || a === 'H') && (b === 't' || b === 'T') &&
        (c === 't' || c === 'T') && (d === 'p' || d === 'P')) {
      let i = start + 4;
      if (i < end && (text[i] === 's' || text[i] === 'S')) i++;
      if (i + 2 < end && text[i] === ':' && text[i + 1] === '/' && text[i + 2] === '/') {
        return true;
      }
    }
  }
  if (end - start >= 5 && /^\.html$/i.test(text.slice(end - 5, end))) return true;
  return false;
}

/** True when [start, end) is a ?… or %3F… query run with no delimiters. */
function isQueryRun(text, start, end) {
  if (end <= start) return false;
  if (text[start] === '?') return true;
  if (end - start >= 3 && text[start] === '%' && text[start + 1] === '3' &&
      (text[start + 2] === 'F' || text[start + 2] === 'f')) {
    return true;
  }
  return false;
}

/**
 * Keyed-url hits via needle scan + per-token state (linear in text length).
 * Finds ?key= / &key= / &amp;key= / &#38;key= / &#x26;key= / %3Fkey%3D / %26key%3D
 * only when a URL/path/.html prefix abuts the query start (or the amp for
 * abutting &key= forms). Token bounds are computed once per token so many
 * needles in one no-whitespace run stay O(n) (#138 review).
 */
function findKeyedUrlHits(text) {
  const hits = [];
  // Candidate starts of a key= handoff (the [?&%] or &amp;/&#… before "key").
  const needle =
    /(?:\?|%3[Ff]|&(?:amp;)?|&#(?:x0*26|0*38);|%26)key(?:%3[Dd]|=)/gi;
  let m;
  // Per-token cache: bounds + last ?/%3F before the current scan cursor.
  let tokenStart = -1;
  let tokenEnd = -1;
  let lastQAt = -1;
  let scannedTo = -1;
  let line = 1;
  let lineAt = 0;
  while ((m = needle.exec(text))) {
    const at = m.index;
    const tok = m[0];

    if (at >= tokenEnd) {
      // Enter a new token: walk bounds once (amortized O(n) over the file).
      tokenStart = at;
      while (tokenStart > 0 && !isKeyLinkDelim(text[tokenStart - 1])) tokenStart--;
      tokenEnd = at;
      while (tokenEnd < text.length && !isKeyLinkDelim(text[tokenEnd])) tokenEnd++;
      lastQAt = -1;
      scannedTo = tokenStart;
    }

    // Advance within the token, recording the rightmost ?/%3F before `at`.
    while (scannedTo < at) {
      const c = text[scannedTo];
      if (c === '?') lastQAt = scannedTo;
      else if (c === '%' && scannedTo + 2 < at && text[scannedTo + 1] === '3' &&
               (text[scannedTo + 2] === 'F' || text[scannedTo + 2] === 'f')) {
        lastQAt = scannedTo;
      }
      scannedTo++;
    }

    let ok = false;
    if (/^(?:\?|%3[Ff])/i.test(tok)) {
      // path?key= — prefix must end exactly at `at`.
      ok = isKeyLinkPrefixRange(text, tokenStart, at);
    } else if (isKeyLinkPrefixRange(text, tokenStart, at)) {
      // &key= / &amp;key= / &#38;key= / %26key= abutting the path.
      ok = true;
    } else if (lastQAt >= tokenStart &&
               isKeyLinkPrefixRange(text, tokenStart, lastQAt) &&
               isQueryRun(text, lastQAt, at)) {
      // path?foo=1&key= — query run after a valid prefix.
      ok = true;
    }
    if (!ok) continue;

    while (lineAt < at) {
      if (text[lineAt] === '\n') line++;
      lineAt++;
    }
    const snipFrom = Math.max(0, at - 48);
    hits.push({
      line,
      rule: 'keyed url',
      match: text.slice(snipFrom, at + tok.length).slice(0, 96),
      index: at
    });
  }
  return hits;
}

const KEY_LINK_RULES = [
  // '?key=' +  /  "&key=" +  /  `?key=` +  — also mid-string `'…&key=' + k`
  // Interior run is bounded (#138) so a long quoted token stays linear.
  { name: 'concat ?key=', re: new RegExp(String.raw`(['"\`])[^'"\`\n]{0,${MAX_STR_RUN}}\?key=\1\s*\+`, 'g') },
  { name: 'concat &key=', re: new RegExp(String.raw`(['"\`])[^'"\`\n]{0,${MAX_STR_RUN}}&(?:amp;|#(?:x0*26|0*38);)?key=\1\s*\+`, 'g') },
  // `...?key=${` / `...&key=${` / `...&amp;key=${` / `...&#38;key=${`
  // Single-line &key= (base behavior) union multiline-with-opener: the
  // single-line rule catches tagged/JSX/nested/bang/export/throw forms that
  // the opener list would miss; the multiline rule allows newlines inside a
  // real template start without spanning past a closing backtick. Distinct
  // names (#138) so the same hit is not reported twice under one label.
  { name: 'template ?key=', re: new RegExp(String.raw`\`[^\`\n]{0,${MAX_STR_RUN}}\?key=\$\{`, 'g') },
  { name: 'template &key= single-line', re: new RegExp(String.raw`\`[^\`\n]{0,${MAX_STR_RUN}}&(?:amp;|#(?:x0*26|0*38);)?key=\$\{`, 'g') },
  {
    name: 'template &key= multiline',
    re: /(?:^|[=(+,[?:|&]|(?:return|await|yield)\s*|=>\s*)\s*`[^`]*&(?:amp;|#(?:x0*26|0*38);)?key=\$\{/g
  },
  // '?' + 'key=' / "&" + "key=" (same or mixed quotes)
  { name: 'split concat key=', re: /(['"`])([?&])\1\s*\+\s*(['"`])key=\3/g },
  // URLSearchParams writers (#121/#138). Receivers constrained so
  // Map/localStorage/etc. .set('key', …) is not flagged; template-literal
  // names (`key`) match too. generate.mjs-style `q.set('key', …)` still hits
  // (allowlisted for that file — see KEY_LINK_ALLOWLIST).
  { name: 'searchParams.set key', re: new RegExp(String.raw`\b${USP_WRITER_RECEIVER}\s*\.\s*set\s*\(\s*${KEY_NAME_LIT}\s*,`, 'g') },
  { name: 'searchParams.append key', re: new RegExp(String.raw`\b${USP_WRITER_RECEIVER}\s*\.\s*append\s*\(\s*${KEY_NAME_LIT}\s*,`, 'g') },
  // Array-of-pairs: URLSearchParams([['key', k]])
  {
    name: 'URLSearchParams pair init',
    re: /URLSearchParams\s*\(\s*\[\s*\[\s*['"`]key['"`]\s*,/g
  },
  // String concat init: URLSearchParams('key=' + k) / ("key=" + k)
  {
    name: 'URLSearchParams string concat',
    re: /URLSearchParams\s*\(\s*(['"])key=\1\s*\+/g
  },
  // Template init: URLSearchParams(`key=${k}`)
  {
    name: 'URLSearchParams template init',
    re: /URLSearchParams\s*\(\s*`key=\$\{/g
  }
];

/**
 * Depth-aware URLSearchParams({ … }) key-property scan (#138 review).
 * Single forward pass with a brace stack so unmatched `URLSearchParams({`
 * openers never rescan to EOF (repeated malformed inits stay linear), while
 * nested calls / nested objects that contain a `key` property still hit and
 * a later statement's `{ key }` cannot false-positive.
 */
function findUrlSearchParamsKeyInits(text) {
  const hits = [];
  const startRe = /URLSearchParams\s*\(\s*\{/g;
  // Property-name only (after `{` or `,`), not values like `{ habit: key }`.
  const keyProp =
    /(?<=[{,])\s*(?:(?:['"]key['"]|\bkey)|\[\s*[`'"]key[`'"]\s*\])\s*[,}:]/g;
  // braceAt → match index for USP object-init openers.
  const uspAt = new Map();
  let m;
  while ((m = startRe.exec(text))) {
    uspAt.set(m.index + m[0].length - 1, m.index);
  }
  if (uspAt.size === 0) return hits;

  const stack = []; // { braceAt, matchIndex } — every `{`, USP ones carry matchIndex
  let inStr = null;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') {
      const matchIndex = uspAt.get(i);
      stack.push({
        braceAt: i,
        matchIndex: matchIndex === undefined ? -1 : matchIndex
      });
    } else if (c === '}') {
      if (stack.length === 0) continue;
      const open = stack.pop();
      if (open.matchIndex < 0) continue;
      const span = text.slice(open.braceAt, i + 1);
      keyProp.lastIndex = 0;
      if (!keyProp.test(span)) continue;
      pushHit(hits, text, open.matchIndex, 'URLSearchParams key init',
        text.slice(open.matchIndex, Math.min(text.length, open.matchIndex + i - open.braceAt + 1)));
    }
  }
  return hits;
}

/**
 * #138 open decision: tools/generate.mjs still embeds ?key= into Web Requests
 * Settings via `q.set('key', key)` when --key / withKey is set. Do not move
 * that to a header in this change — filter those hits when scanning that file.
 * Match is the stable snippet findKeyLinkHandoffs reports (slice 0..96).
 */
export const KEY_LINK_ALLOWLIST = [
  { file: 'tools/generate.mjs', rule: 'searchParams.set key', match: "q.set('key'," }
];

/** True when a handoff hit is an intentional, documented exception (#138). */
export function isAllowedKeyLink(file, hit) {
  // Exact repo-relative path only — not a suffix match (would also accept
  // public/tools/generate.mjs under the public/**/*.mjs handoff scan).
  const norm = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return KEY_LINK_ALLOWLIST.some(
    (a) =>
      norm === a.file &&
      hit.rule === a.rule &&
      String(hit.match || '').startsWith(a.match)
  );
}

/** Identifiers bound to URLSearchParams in `text` (ctor or `.searchParams`). */
function urlSearchParamsIds(text) {
  const ids = new Set();
  // const/let/var and bare assigns in any statement context (if/&&/(…)/…),
  // but not property writes (`obj.x = new URLSearchParams`).
  const fromNew =
    /(?:\b(?:const|let|var)\s+|(?:^|[^\w$.]))([A-Za-z_$][\w$]*)\s*=\s*new\s+URLSearchParams\b/g;
  // Aliased searchParams: `const sp = url.searchParams` / `sp = u.searchParams`
  // (#138). Bound the receiver chain so long id runs stay linear.
  const fromAlias = new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+|(?:^|[^\w$.]))([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]{0,${MAX_USP_ID - 1}}(?:\.[A-Za-z_$][\w$]{0,${MAX_USP_ID - 1}}){0,${MAX_USP_DEPTH}}\.searchParams\b`,
    'g'
  );
  let m;
  while ((m = fromNew.exec(text))) ids.add(m[1]);
  while ((m = fromAlias.exec(text))) ids.add(m[1]);
  return ids;
}

function pushHit(hits, text, index, rule, match) {
  const line = text.slice(0, index).split('\n').length;
  hits.push({ line, rule, match: String(match).slice(0, 96), index });
}

/** Flag docs/UI text that hands callers a keyed URL (?key= / &key= forms). */
export function findKeyLinkHandoffs(text) {
  const hits = [];
  for (const h of findKeyedUrlHits(text)) hits.push(h);
  for (const h of findUrlSearchParamsKeyInits(text)) hits.push(h);
  for (const { name, re } of KEY_LINK_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      pushHit(hits, text, m.index, name, m[0]);
    }
  }
  // Writers on locals assigned from `new URLSearchParams` or `*.searchParams`
  // (beyond q/params/searchParams / *.searchParams). Skip names the fixed
  // receiver regex already covers so we don't double-report.
  const builtin = new Set(['q', 'params', 'searchParams']);
  for (const id of urlSearchParamsIds(text)) {
    if (builtin.has(id)) continue;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [method, rule] of [
      ['set', 'searchParams.set key'],
      ['append', 'searchParams.append key']
    ]) {
      const re = new RegExp(
        String.raw`\b${esc}\s*\.\s*${method}\s*\(\s*${KEY_NAME_LIT}\s*,`,
        'g'
      );
      let m;
      while ((m = re.exec(text))) {
        pushHit(hits, text, m.index, rule, m[0]);
      }
    }
  }
  // Dedupe by (index, rule) — distinct template rule names avoid the #138
  // double-report under one label; still collapse exact duplicates.
  const seen = new Set();
  return hits.filter((h) => {
    const k = (h.index ?? -1) + '\0' + h.rule + '\0' + h.match;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
