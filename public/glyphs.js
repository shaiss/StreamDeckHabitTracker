// Shared verb→glyph grammar (study §2.5 / issue #77).
//
// One file both renderers read: faces.mjs (hardware SVG) and deck.html
// (virtual deck) import this module so they cannot disagree on which glyph a
// verb gets. Lives under public/ so the virtual deck can import it with no
// build step; Node (plugin, lib/question.js, unit tests) imports the same
// path. Adding a verb here is how the set grows — do not fork a copy.
//
// Verbs, not nouns. One glyph per verb. The subset the coach needs today is
// the Approval Gate + Choice Picker workhorses; the rest of §2.5 is reserved
// so later children (E, etc.) do not invent a parallel map.

export const VERB_GLYPHS = Object.freeze({
  approve: '✓',
  reject: '✕',
  defer: '→',
  details: '…',
  back: '‹',
  // Reserved for later patterns; present so the grammar is one table.
  run: '▶',
  stop: '■',
  options: '▤',
  drill: '⊕'
});

// Circled indices ①②③④ — Choice Picker badges (study §3.2). Numbers live
// here, never inline in the label (§2.4).
export const CHOICE_BADGES = Object.freeze(['①', '②', '③', '④']);

// Approval Gate (§3.1): always this three-key shape, always this order —
// affirmative left, escape-hatch center, negative right. Position is
// load-bearing; do not reorder per question.
export const GATE_ORDER = Object.freeze(['approve', 'details', 'deny']);

export const GATE_FACE = Object.freeze({
  approve: Object.freeze({
    verb: 'approve', label: 'APPROVE', answer: 'yes', glyphTint: 'success'
  }),
  details: Object.freeze({
    verb: 'details', label: 'DETAILS', answer: 'details'
  }),
  deny: Object.freeze({
    verb: 'reject', label: 'DENY', answer: 'no'
  })
});

export const MAX_LABEL_WORDS = 2;

export function glyphFor(verb) {
  return VERB_GLYPHS[verb] || '';
}

// 1-based index → badge. Out of range falls back to the decimal, still a
// badge, never spliced into the label.
export function choiceBadge(index) {
  const i = Number(index);
  if (i >= 1 && i <= CHOICE_BADGES.length) return CHOICE_BADGES[i - 1];
  return Number.isFinite(i) && i > 0 ? String(i) : '';
}

// §2.4: ≤2 words, uppercase, digits stripped so they cannot ride the label.
export function faceLabel(raw, fallback = '') {
  const cleaned = String(raw || '').replace(/[0-9]+/g, ' ').replace(/[^A-Za-z\s'-]/g, ' ');
  const words = cleaned.trim().split(/\s+/).filter(Boolean).slice(0, MAX_LABEL_WORDS);
  const s = (words.join(' ') || String(fallback || '')).toUpperCase();
  return s.slice(0, 12);
}

function gatePaint(role) {
  const spec = GATE_FACE[role];
  if (!spec) return null;
  return {
    glyph: glyphFor(spec.verb),
    label: spec.label,
    badge: '',
    glyphTint: spec.glyphTint || null,
    grammar: true,
    mono: true,
    verb: spec.verb,
    role
  };
}

// Map a slot def onto glyph + label + badge + tint. Both renderers call this
// so a yes/no cannot paint as 👍/👎 in one place and ✓/✕ in the other.
export function questionPaint(def) {
  if (!def) return null;
  if (def.pattern === 'gate' && def.gateRole) return gatePaint(def.gateRole);
  if (def.pattern === 'picker' || def.choiceIndex) {
    const i = def.choiceIndex || 1;
    return {
      glyph: glyphFor('options'),
      label: faceLabel(def.label, def.habit || 'OPT'),
      badge: choiceBadge(i),
      glyphTint: null,
      grammar: true,
      mono: true,
      verb: 'options',
      role: 'choice'
    };
  }
  if (def.answer === 'yes' || def.verb === 'approve') return gatePaint('approve');
  if (def.answer === 'no' || def.verb === 'reject') return gatePaint('deny');
  if (def.answer === 'details' || def.verb === 'details') return gatePaint('details');
  return {
    glyph: glyphFor('details') || def.emoji || '❓',
    label: faceLabel(def.label, def.habit || ''),
    badge: '',
    glyphTint: null,
    grammar: true,
    mono: true,
    verb: 'details',
    role: null
  };
}

export function isDetailsKey(def) {
  if (!def) return false;
  return def.gateRole === 'details' || def.verb === 'details' || def.answer === 'details';
}
