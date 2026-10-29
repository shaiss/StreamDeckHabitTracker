// Shared HTML escaper for every HabitDeck page.
// Escapes all five characters that can break text or an attribute value:
// & < > " '
// Attribute values on these pages are double-quoted; ' is still escaped so a
// later single-quoted interpolation cannot break out. & is first so the
// entities this function emits are not double-encoded.
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
