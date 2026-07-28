// Drift guard for the web design language (design/WEB-UX.md, issue #65).
//
// Prose does not hold a line; a test does. This is the web counterpart of
// hue.test.mjs: it reads the web surface as TEXT and asserts the rules the
// guide states, so a page cannot quietly grow a fourth grey or a fifth radius.
//
// The allowlists below are deliberately narrow — exact literals in exact
// files, never a blanket file exemption. Widening one is a design decision and
// should be argued for in design/WEB-UX.md §7 first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

const THEME = 'public/theme.css';
const PAGES = ['public/index.html', 'public/habits.html', 'public/mind.html', 'public/deck.html'];
const SURFACE = [THEME, 'public/nav.js', ...PAGES];

// Every token design/WEB-UX.md §2 names, and whether §2 promises a light value.
const TOKENS = {
  '--bg': true, '--bg2': true, '--card': true, '--card2': true, '--line': true,
  '--fg': true, '--ink2': true, '--muted': true,
  '--accent': true, '--violet': false, '--violet-deep': false, '--violet-ink': true,
  '--on-violet': false, '--amber': true, '--series': true, '--good': true, '--bad': true,
  '--grad-coach': false, '--chrome': true, '--shadow-pop': true,
  '--r-lg': false, '--r-md': false, '--r-sm': false,
  '--s1': false, '--s2': false, '--s3': false, '--s4': false, '--s5': false, '--s6': false,
  '--font': false
};

// ---------------------------------------------------------------- 1. tokens
test('every token the guide names is declared in theme.css', () => {
  const css = read(THEME);
  const night = css.slice(0, css.indexOf('@media'));
  for (const t of Object.keys(TOKENS)) {
    assert.ok(new RegExp(`\\${t}\\s*:`).test(night), `${t} is missing its night declaration`);
  }
});

test('tokens that must invert for light mode actually do', () => {
  const css = read(THEME);
  const light = css.slice(css.indexOf('@media'));
  // These carry text and fail 4.5:1 on a white card at their night value, so a
  // missing light override is a real accessibility regression, not a nit.
  for (const t of ['--violet-ink', '--amber', '--good', '--bad', '--series', '--accent']) {
    assert.ok(new RegExp(`\\${t}\\s*:`).test(light), `${t} must be overridden for light mode`);
  }
});

test('no page references a token that does not exist', () => {
  const declared = new Set();
  for (const f of SURFACE) for (const m of read(f).matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
  for (const f of SURFACE) {
    for (const m of read(f).matchAll(/var\(\s*(--[\w-]+)/g)) {
      assert.ok(declared.has(m[1]), `${f} uses var(${m[1]}) but nothing declares it`);
    }
  }
});

// ------------------------------------------------------------ 2. raw colors
// A literal is allowed only where design/WEB-UX.md §7 sanctions an
// illustration. Everything else must name a token.
const HEX_ALLOW = {
  // §7.1 the photoreal device + §7.2 the key faces, which are a byte-parity
  // contract with streamdeck-plugin/src/faces.mjs and must NOT become tokens.
  'public/deck.html': [
    '#2a2c30', '#131417', '#0b0c0e',            // enclosure, bezel
    '#23262b', '#101216', '#0a0b0d',            // studio vignette
    '#0e0f12', '#17181b', '#060708',            // faceplate, stand
    '#000', '#050506', '#0c0d10', '#050607',    // key well, unlit key
    '#141827', '#0a0c13', '#12151f',            // key-face base gradient
    '#fff'                                      // key-face label ink
  ],
  // §7.4 the dreamscape's own night floor — the aurora's violet stop is
  // already expressed as color-mix(var(--violet)).
  'public/mind.html': ['#0d0f16', '#0a0b11']
};

test('no raw color outside a sanctioned illustration', () => {
  for (const f of SURFACE) {
    const allowed = new Set(HEX_ALLOW[f] || []);
    for (const m of read(f).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      if (f === THEME) continue;               // theme.css IS the palette
      assert.ok(allowed.has(m[0]), `${f}: raw color ${m[0]} — name a token or sanction it in §7`);
    }
  }
});

test('the three inks are the only greys', () => {
  // The drift this whole issue exists to stop: deck.html shipped #9aa0a6 and
  // #cfd3d8 as a private fourth and fifth grey.
  for (const f of SURFACE) {
    const src = read(f);
    for (const ghost of ['#9aa0a6', '#cfd3d8', '#e8eaed', '#1a1c1f']) {
      assert.ok(!src.includes(ghost), `${f} resurrected the off-system grey ${ghost}`);
    }
  }
});

// ----------------------------------------------------------- 3. the ladder
test('radii come from the ladder', () => {
  // Two exceptions, both geometry rather than surface (§4): the chart bar's
  // cap, and everything inside deck.html's device render.
  const RADIUS_ALLOW = {
    'public/index.html': ['border-radius:4px 4px 0 0'],
    'public/deck.html': null   // whole-file: every radius here is device geometry
  };
  for (const f of PAGES) {
    if (RADIUS_ALLOW[f] === null) continue;
    const allowed = RADIUS_ALLOW[f] || [];
    const src = read(f);
    for (const m of src.matchAll(/border-radius:\s*[^;\n}]+/g)) {
      const decl = m[0].replace(/\s+/g, ' ').trim();
      if (decl.includes('var(--r-') || decl.includes('50%') || decl.includes('inherit')) continue;
      const norm = decl.replace(/\s*:\s*/, ':');
      assert.ok(
        allowed.some((a) => norm.startsWith(a.replace(/\s*:\s*/, ':'))),
        `${f}: off-ladder ${decl} — use --r-lg / --r-md / --r-sm`
      );
    }
  }
});

// ------------------------------------------------------- 4. no duplication
test('a recipe is declared once', () => {
  const all = SURFACE.map(read).join('\n');
  const grads = [...all.matchAll(/linear-gradient\(135deg/g)].length;
  assert.equal(grads, 1, 'the coach gradient must only exist as --grad-coach');
  const fonts = [...all.matchAll(/-apple-system, BlinkMacSystemFont/g)].length;
  assert.equal(fonts, 1, 'the font stack must only exist as --font');
});

// --------------------------------------------- 5. key-face parity (§7.2)
test('the virtual deck still mirrors the plugin key faces', () => {
  const deck = read('public/deck.html');
  const faces = read('streamdeck-plugin/src/faces.mjs');
  const plugin = read('streamdeck-plugin/src/plugin.mjs');

  // Hue carries meaning across both renderers: violet = a suggestion, amber =
  // a nudge, magenta = a question. faces.mjs takes hue as a PARAMETER, so the
  // constants live in its caller — assert them where they actually are.
  for (const [what, decl, mark] of [
    ['violet slot', 'VIOLET_HUE = 262', 'hsla(262'],
    ['amber nudge', 'NUDGE_HUE = 38', 'hsla(38'],
    ['magenta question', 'QUESTION_HUE = 300', 'hsla(300']
  ]) {
    assert.ok(plugin.includes(decl), `plugin.mjs lost the ${what} hue`);
    assert.ok(deck.includes(mark), `deck.html lost the ${what} hue`);
  }

  // The halo is a fixed formula, not a look: same off-center origin and the
  // same escalation slopes on both sides.
  assert.ok(faces.includes('cy="0.36"'), 'faces.mjs moved the halo origin');
  assert.ok(deck.includes('circle at 50% 36%'), 'deck.html moved the halo origin');
  for (const [file, src, lightness, ring] of [
    ['faces.mjs', faces, '58 + 12 * urg', '0.3 + 0.5 * urg'],
    ['deck.html', deck, '58% + var(--urg,0) * 12%', '.3 + var(--urg,0) * .5']
  ]) {
    assert.ok(src.includes(lightness), `${file} changed the halo escalation slope`);
    assert.ok(src.includes(ring), `${file} changed the ring escalation slope`);
  }

  // The base gradient under every key face.
  for (const stop of ['#141827', '#0a0c13']) {
    assert.ok(faces.includes(stop), `faces.mjs lost the base stop ${stop}`);
    assert.ok(deck.includes(stop), `deck.html lost the base stop ${stop}`);
  }
});

// ------------------------------------------------- 6. the guide is honest
test('design/WEB-UX.md documents the exceptions the code actually takes', () => {
  const guide = read('design/WEB-UX.md');
  for (const claim of ['faces.mjs', 'lib-hue.mjs', 'ORB_COLORS', '--violet-ink', '--amber', '--grad-coach']) {
    assert.ok(guide.includes(claim), `the guide never mentions ${claim}`);
  }
  // Every sanctioned file in this test must be argued for in §7.
  for (const f of Object.keys(HEX_ALLOW)) {
    const page = f.split('/').pop();
    assert.ok(guide.includes(page), `${page} takes an exception the guide does not describe`);
  }
});
