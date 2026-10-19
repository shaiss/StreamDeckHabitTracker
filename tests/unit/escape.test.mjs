// The one escaper every HabitDeck page imports. Five characters, & first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc } from '../../public/escape.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('esc encodes & < > " \' and nothing else', () => {
  assert.equal(esc('plain'), 'plain');
  assert.equal(esc('a&b'), 'a&amp;b');
  assert.equal(esc('a<b'), 'a&lt;b');
  assert.equal(esc('a>b'), 'a&gt;b');
  assert.equal(esc('a"b'), 'a&quot;b');
  assert.equal(esc("a'b"), 'a&#39;b');
  assert.equal(
    esc(`Fish & "Chips" <tag> 'ok'`),
    'Fish &amp; &quot;Chips&quot; &lt;tag&gt; &#39;ok&#39;'
  );
});

test('esc encodes & before the entities it emits', () => {
  assert.equal(esc('&lt;'), '&amp;lt;');
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('&'), '&amp;');
});

test('esc stringifies non-strings', () => {
  assert.equal(esc(null), 'null');
  assert.equal(esc(undefined), 'undefined');
  assert.equal(esc(2), '2');
});

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('every page script uses the shared escaper and defines no local one', () => {
  const pages = [
    'public/index.js',
    'public/habits.js',
    'public/mind.js',
    'public/deck.js',
    'public/design/ai-human-bridge/key-language.js'
  ];
  for (const f of pages) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /import \{ esc \} from '\/escape\.js'/, f);
    assert.doesNotMatch(src, /(?:const|let|function)\s+esc\b/, f + ' still defines its own esc');
  }
  for (const p of walk(join(ROOT, 'public'))) {
    if (extname(p) !== '.html') continue;
    const src = readFileSync(p, 'utf8');
    assert.doesNotMatch(src, /(?:const|let|function)\s+esc\b/, p + ' still defines esc');
  }
});
