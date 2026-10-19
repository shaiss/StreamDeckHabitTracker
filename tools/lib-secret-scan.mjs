// Key-leak scanner (#112 prep). The repo is PUBLIC: HABIT_KEY must never be
// committed or shipped. Used by tests/unit/no-committed-keys.test.mjs (CI)
// and as a hard guard in build-plugin.mjs / generate.mjs. Zero deps.
//
// Flags, in plain text:
//   --key=<value>           unless the value is a placeholder
//   [?&]key=<value>         literal URL keys (code that concatenates is fine)
//   x-habit-key: <value>    a hardcoded header value (JSON/JS or curl style)
//   HABIT_KEY=<value>       an env assignment with a literal value
// and, inside .streamDeckProfile / .streamDeckPlugin zips (inflated):
//   any action Settings carrying a non-empty "key" or "habitKey".
import { inflateRawSync } from 'node:zlib';

// Values that are obviously documentation, not secrets.
const PLACEHOLDER = /^(?:<[^>]*>|\.\.\.|…|SECRET|YOUR[_-]?KEY|\$\{?[A-Za-z_][\w]*\}?|%[A-Za-z_]+%|\$env:[A-Za-z_]+|xxx+|\[redacted\])$/i;
const isPlaceholder = (v) => !v || PLACEHOLDER.test(v);

const RULES = [
  { name: '--key=', re: /--key=([^\s"'`)\]]+)/g },
  { name: '?key=', re: /[?&]key=([A-Za-z0-9_\-.~%]{6,})/g },
  { name: 'x-habit-key value', re: /["']?x-habit-key["']?\s*[:=]\s*["'`]([^"'`\s]+)["'`]/gi },
  { name: 'x-habit-key header', re: /x-habit-key:\s*([^\s"'`]+)/gi },
  { name: 'HABIT_KEY=', re: /\bHABIT_KEY\s*=\s*["']?([^\s"'`;]+)/g }
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
      if (/^[+$({]/.test(v)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file, line, rule: name });
    }
  }
  return hits;
}

// Minimal ZIP reader (local headers; DEFLATE or stored) — enough for the
// archives tools/lib-zip.mjs writes.
export function unzipEntries(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const xlen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const start = i + 30 + nlen + xlen;
    const raw = buf.slice(start, start + csize);
    let data;
    try { data = method === 8 ? inflateRawSync(raw) : raw; } catch { data = Buffer.alloc(0); }
    out.push({ name, data });
    i = start + csize;
  }
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
const TEXTY = /\.(json|txt|js|mjs|html|md|ps1|sh|yml|yaml)$/i;

export function scanArchive(buf, file) {
  const hits = [];
  for (const e of unzipEntries(buf)) {
    const name = file + '!' + e.name;
    if (ZIPPED.test(e.name)) { hits.push(...scanArchive(e.data, name)); continue; }
    if (!TEXTY.test(e.name)) continue;
    const text = e.data.toString('utf8');
    hits.push(...scanText(text, name));
    if (/\.json$/i.test(e.name)) {
      try { hits.push(...settingsHits(JSON.parse(text), name)); } catch { /* not JSON */ }
    }
  }
  return hits;
}

export function scanFile(name, buf) {
  if (ZIPPED.test(name)) return scanArchive(buf, name);
  if (buf.includes(0)) return [];   // binary (png, gif)
  return scanText(buf.toString('utf8'), name);
}
