// Output-quality scorers (issue #11): rule-based, deterministic, no model
// calls. Score a coach reply's RAW parsed slots (pre-sanitize) so we measure
// the model's discipline, not the sanitizer's cleanup. All scores 0..1.
import { BASE_HABITS } from './ai.js';

const DEFAULT_FIXED = new Set(BASE_HABITS.map((h) => h.name.toLowerCase()));

// Reasons should reference the human's actual data, not read like a fortune
// cookie. Heuristic: numbers/times, "you/your", or a habit name.
function reasonSpecificity(reason, fixed) {
  const r = String(reason || '');
  if (!r) return 0;
  let score = 0;
  if (/\d/.test(r) || /\b(am|pm|morning|tonight|yesterday|today)\b/i.test(r)) score += 0.5;
  if (/\byou(r|'re|'ve)?\b/i.test(r)) score += 0.3;
  if ([...fixed].some((h) => r.toLowerCase().includes(h))) score += 0.2;
  return Math.min(1, score);
}

// items: the raw parsed slots array (may be malformed). parseOk: whether JSON
// extraction succeeded at all.
export function scoreOutput(items, { parseOk = true, fixedNames } = {}) {
  const fixed = fixedNames ? new Set(fixedNames.map((n) => String(n).toLowerCase())) : DEFAULT_FIXED;
  if (!parseOk) {
    return { jsonValid: 0, schemaValid: 0, noDuplicates: 0, labelFit: 0, specificity: 0, composite: 0 };
  }
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) {
    return { jsonValid: 1, schemaValid: 0, noDuplicates: 1, labelFit: 0, specificity: 0, composite: 0.2 };
  }
  let schemaOk = 0, dupFree = 0, labelOk = 0, spec = 0;
  const seen = new Set();
  for (const it of arr) {
    const habit = String(it?.habit || '');
    const wellFormed =
      /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(habit) &&
      typeof it?.emoji === 'string' && it.emoji.length > 0 &&
      typeof it?.label === 'string' && it.label.length > 0;
    if (wellFormed) schemaOk++;
    const key = habit.toLowerCase();
    if (key && !fixed.has(key) && !seen.has(key)) dupFree++;
    seen.add(key);
    if (it?.label && String(it.label).length <= 10) labelOk++;
    spec += reasonSpecificity(it?.reason, fixed);
  }
  const n = arr.length;
  const out = {
    jsonValid: 1,
    schemaValid: +(schemaOk / n).toFixed(2),
    noDuplicates: +(dupFree / n).toFixed(2),
    labelFit: +(labelOk / n).toFixed(2),
    specificity: +(spec / n).toFixed(2)
  };
  out.composite = +(
    0.25 * out.jsonValid +
    0.25 * out.schemaValid +
    0.2 * out.noDuplicates +
    0.1 * out.labelFit +
    0.2 * out.specificity
  ).toFixed(3);
  return out;
}
