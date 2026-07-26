// Load the habit list for artifact generation. The LIVE list (/api/habits —
// what the habit manager edits) is the source of truth; config/habits.json is
// only a fallback for environments that can't reach the deployment (and the
// seed for first-ever boot). A fallback is LOUD because building artifacts
// from a stale list is exactly the bug this file exists to prevent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function loadHabits(origin, root) {
  const url = String(origin || '').replace(/\/+$/, '') + '/api/habits';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!Array.isArray(j.habits) || !j.habits.length) throw new Error('empty habit list');
    return { habits: j.habits, source: url };
  } catch (err) {
    const { habits } = JSON.parse(readFileSync(join(root, 'config/habits.json'), 'utf8'));
    console.warn(`⚠  Could not fetch ${url} (${err.message}) — using config/habits.json (${habits.length} habits).`);
    console.warn('   If the live list differs (habit-manager edits), these artifacts will be STALE.');
    console.warn('   Sync config/habits.json from the live API first, or run where the deployment is reachable.');
    return { habits, source: 'config/habits.json (FALLBACK)' };
  }
}
