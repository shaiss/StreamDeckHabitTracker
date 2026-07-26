// The habit hue formula — a habit's color is its identity for life.
// Zero dependencies on purpose: the unit suite imports this directly.
// Copies of this formula live in the plugin's app.js and public/deck.html;
// tests/unit/hue.test.mjs guards against the three drifting apart.

// FNV-1a for spread, then skip the reserved violet band [245,285) — violet
// always means "the coach speaking", never a habit.
export function hueFor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let hue = h % 320;
  if (hue >= 245) hue += 40;
  return hue;
}
