import { test } from 'node:test';
import assert from 'node:assert/strict';
import { face, hueFor } from '../../streamdeck-plugin/src/faces.mjs';

const decode = (uri) => {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
};

test('face() returns a well-formed SVG data URI with glyph, label, and badge', () => {
  const svg = decode(face('🌊', 'Flow', 200, 'AI 1'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/);
  assert.ok(svg.includes('🌊'), 'emoji glyph present');
  assert.ok(svg.includes('>Flow<'), 'label present');
  assert.ok(svg.includes('AI 1'), 'badge present');
  assert.ok(svg.includes('linearGradient'), 'night base gradient');
  assert.ok(svg.includes('radialGradient'), 'votive halo');
  assert.ok(!/hsla?\(/.test(svg), 'no hsl()/hsla() — rasterizer compatibility');
});

test('labels are truncated to 12 chars and long labels shrink the font', () => {
  const svg = decode(face('✨', 'Hydration Break Time', 100, ''));
  assert.ok(svg.includes('>Hydration Br<'), 'label truncated at 12');
  assert.ok(svg.includes('font-size="17"'), 'long label uses the 17px size');
  const short = decode(face('✨', 'Eat', 100, ''));
  assert.ok(short.includes('font-size="20"'), 'short label uses the 20px size');
});

test('AI-generated strings are XML-escaped, not injected', () => {
  const svg = decode(face('<script>', 'a&b"c', 10, '<x>'));
  assert.ok(!svg.includes('<script>'), 'raw markup must not survive');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('a&amp;b&quot;c'));
});

test('no badge means no badge element', () => {
  const svg = decode(face('✨', 'Slot 1', 222, ''));
  assert.ok(!svg.includes('text-anchor="end"'), 'badge text is the only end-anchored element');
});

test('hueFor is the shared tools/lib-hue.mjs formula', async () => {
  const lib = await import('../../tools/lib-hue.mjs');
  for (const n of ['Pee', 'Eat', 'Flow', 'Walk']) assert.equal(hueFor(n), lib.hueFor(n));
});
