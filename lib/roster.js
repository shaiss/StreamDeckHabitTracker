// Self-managing roster: the coach proposes changes to the FIXED habit list —
// additions worth a permanent key, retirements for habits that have gone
// stale — and the human approves or dismisses each one.
//
// Nothing here ever applies itself. A proposal becomes a roster change only
// when api/roster.js records a human decision, retirement is soft (the habit
// moves to an archive and can be restored), and the tap log is never touched:
// past entries keep their names, so history stays truthful after a retirement.
//
// Every function is pure so the decision rules are testable without Redis
// (tests/unit/roster.test.mjs). The Redis doc lives at `habits:roster`.

export const MAX_PENDING = 3;
export const MAX_ROSTER = 10; // mirrors validateHabits() in habits.js
export const MIN_ROSTER = 1;
const MAX_ARCHIVE = 20;
const MAX_REJECTED = 40;

// The same id rule validateHabits() enforces — an approved proposal must
// always produce a roster that still validates.
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;

const lc = (s) => String(s || '').toLowerCase();
const key = (kind, name) => `${kind}:${lc(name)}`;
const origin = (o) => (o === 'coach' ? 'coach' : 'human');

export function normalizeRoster(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return {
    proposals: Array.isArray(d.proposals) ? d.proposals.filter(Boolean) : [],
    archive: Array.isArray(d.archive) ? d.archive.filter(Boolean) : [],
    rejected: Array.isArray(d.rejected) ? d.rejected.map(lc) : [],
    lastRunAt: Number(d.lastRunAt) || 0,
    model: String(d.model || ''),
    engine: String(d.engine || '')
  };
}

// Dismissals are memory: the coach sees them on the next pass and stops
// re-asking for something the human already said no to.
function remember(rejected, p) {
  const k = key(p.kind, p.name);
  return [k, ...rejected.filter((r) => r !== k)].slice(0, MAX_REJECTED);
}

// Turn raw model output into proposals that are safe to queue. Anything the
// human couldn't sanely approve is dropped rather than repaired.
export function sanitizeProposals(raw, { habits = [], rejected = [], pending = [], now = Date.now() } = {}) {
  const onRoster = new Map(habits.map((h) => [lc(h.name), h]));
  const taken = new Set([...pending.map((p) => key(p.kind, p.name)), ...rejected.map(lc)]);
  const room = Math.max(0, MAX_PENDING - pending.length);
  // Projected roster size, counting what is already queued: a batch can never
  // propose its way past the 1..10 bounds, whatever order the human approves in.
  let size = habits.length +
    pending.filter((p) => p.kind === 'add').length -
    pending.filter((p) => p.kind === 'retire').length;

  const out = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (out.length >= room) break;
    if (!it || typeof it !== 'object') continue;
    const kind = it.kind === 'retire' ? 'retire' : it.kind === 'add' ? 'add' : null;
    if (!kind) continue;
    const name = String(it.name || it.habit || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    if (!ID_RE.test(name)) continue;
    const k = key(kind, name);
    if (taken.has(k)) continue;

    const existing = onRoster.get(lc(name));
    if (kind === 'add') {
      if (existing || size >= MAX_ROSTER) continue;
      size++;
    } else {
      if (!existing || size <= MIN_ROSTER) continue;
      size--;
    }
    taken.add(k);
    out.push({
      id: `${kind}-${lc(name)}-${now}-${out.length}`,
      kind,
      name,
      // A retirement is shown exactly as the key looks on the deck today; the
      // model only gets to name the target.
      emoji: String((kind === 'retire' ? existing.emoji : it.emoji) || '✨').slice(0, 8),
      label: String((kind === 'retire' ? existing.label : it.label) || name).slice(0, 12),
      origin: kind === 'retire' ? origin(existing.origin) : 'coach',
      reason: String(it.reason || '').slice(0, 240),
      createdAt: now
    });
  }
  return out;
}

// Record a human decision. Returns { habits, roster, applied } on success or
// { error } — `habits` is returned by reference when the roster is unchanged.
export function applyDecision({ habits, roster, id, decision, now = Date.now() }) {
  const doc = normalizeRoster(roster);
  const p = doc.proposals.find((x) => x.id === id);
  if (!p) return { error: 'That proposal is no longer pending.' };
  const proposals = doc.proposals.filter((x) => x !== p);

  if (decision === 'dismiss') {
    return {
      habits,
      roster: { ...doc, proposals, rejected: remember(doc.rejected, p) },
      applied: { ...p, status: 'dismissed' }
    };
  }
  if (decision !== 'approve') return { error: 'Decision must be "approve" or "dismiss".' };

  const idx = habits.findIndex((h) => lc(h.name) === lc(p.name));

  if (p.kind === 'add') {
    if (idx >= 0) return { error: `${p.name} is already on your roster.` };
    if (habits.length >= MAX_ROSTER) {
      return { error: `Your roster is full (${MAX_ROSTER} habits) — retire one first.` };
    }
    return {
      habits: [...habits, { name: p.name, emoji: p.emoji, label: p.label, origin: 'coach' }],
      // Approving an add for something previously retired un-archives it.
      roster: { ...doc, proposals, archive: doc.archive.filter((a) => lc(a.name) !== lc(p.name)) },
      applied: { ...p, status: 'approved' }
    };
  }

  if (idx < 0) return { error: `${p.name} is no longer on your roster.` };
  if (habits.length <= MIN_ROSTER) return { error: 'That is your last habit — keep at least one.' };
  const gone = habits[idx];
  return {
    habits: habits.filter((_, i) => i !== idx),
    roster: {
      ...doc,
      proposals,
      // Soft retirement: the key leaves the deck, the record stays.
      archive: [
        {
          name: gone.name,
          emoji: gone.emoji,
          label: gone.label,
          origin: origin(gone.origin),
          reason: p.reason,
          retiredAt: now
        },
        ...doc.archive.filter((a) => lc(a.name) !== lc(gone.name))
      ].slice(0, MAX_ARCHIVE)
    },
    applied: { ...p, status: 'approved' }
  };
}

// Put a retired habit back on the roster, keeping the origin it had before.
export function restoreFromArchive({ habits, roster, name }) {
  const doc = normalizeRoster(roster);
  const item = doc.archive.find((a) => lc(a.name) === lc(name));
  if (!item) return { error: 'That habit is not in the archive.' };
  if (habits.some((h) => lc(h.name) === lc(name))) {
    return { error: `${item.name} is already on your roster.` };
  }
  if (habits.length >= MAX_ROSTER) {
    return { error: `Your roster is full (${MAX_ROSTER} habits) — retire one first.` };
  }
  return {
    habits: [...habits, { name: item.name, emoji: item.emoji, label: item.label, origin: origin(item.origin) }],
    roster: { ...doc, archive: doc.archive.filter((a) => a !== item) },
    applied: { ...item, status: 'restored' }
  };
}
