// Regression pins for #115 coach-experiment.yml hygiene. The YAML already
// landed on tip with least-privilege permissions and HABIT_KEY via env —
// these tests stop a silent regress (secret expanded into run: text, missing
// permissions: {}, or ?key= creeping back into the experiment URL).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = join(ROOT, '.github/workflows/coach-experiment.yml');

function loadWorkflow() {
  assert.ok(existsSync(WORKFLOW), 'coach-experiment.yml must exist');
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.ok(text.trim().length > 0, 'coach-experiment.yml must be non-empty');
  return text;
}

/** Slice of the file before the top-level `jobs:` key. */
function preambleBeforeJobs(text) {
  const m = text.match(/^jobs:\s*$/m);
  assert.ok(m, 'workflow must declare a top-level jobs: key');
  return text.slice(0, m.index);
}

/**
 * Extract the shell body of every top-level `run: |` / `run: >` block under
 * steps (and plain `run: "..."` / `run: '...'` / single-line `run:`). Used so
 * we can assert the secret is never expanded into script text, while still
 * allowing `HABIT_KEY: ${{ secrets.HABIT_KEY }}` under `env:`.
 */
function runScriptBodies(text) {
  const bodies = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = line.match(/^(\s*)run:\s*[|>]-?\s*$/);
    if (block) {
      const indent = block[1].length;
      const chunk = [];
      for (let j = i + 1; j < lines.length; j++) {
        const L = lines[j];
        if (L.trim() === '') {
          chunk.push(L);
          continue;
        }
        const lead = L.match(/^(\s*)/)[1].length;
        if (lead <= indent) break;
        chunk.push(L);
        i = j;
      }
      bodies.push(chunk.join('\n'));
      continue;
    }
    const inline = line.match(/^\s*run:\s*(.+)$/);
    if (inline) bodies.push(inline[1]);
  }
  return bodies;
}

test('coach-experiment.yml exists and is non-empty', () => {
  loadWorkflow();
});

test('top-level permissions: {} appears before jobs: (#115 least privilege)', () => {
  const text = loadWorkflow();
  const preamble = preambleBeforeJobs(text);
  // Empty mapping — `permissions: {}` or a multi-line empty `permissions:` with
  // no grant keys before jobs:. Prefer the compact form that tip already uses.
  assert.match(
    preamble,
    /^permissions:\s*(?:\{\s*\}|$)/m,
    'expected top-level permissions: {} (or empty mapping) before jobs:'
  );
  // Must not grant anything before jobs: (no contents: / actions: / etc.).
  assert.doesNotMatch(
    preamble,
    /^permissions:\s*\n(?:[ \t]+[a-z-]+:[ \t]*.+\n)+/m,
    'permissions must stay empty — no grant keys before jobs:'
  );
});

test('HABIT_KEY is supplied via env: and not expanded inside run: script text', () => {
  const text = loadWorkflow();
  // Secret enters only via the step env block.
  assert.match(
    text,
    /^\s*HABIT_KEY:\s*\$\{\{\s*secrets\.HABIT_KEY\s*\}\}\s*$/m,
    'HABIT_KEY must be set from secrets under an env: block'
  );
  assert.match(
    text,
    /^\s*env:\s*$/m,
    'workflow step must declare an env: block for HABIT_KEY'
  );

  const bodies = runScriptBodies(text);
  assert.ok(bodies.length > 0, 'expected at least one run: script body');
  for (const body of bodies) {
    assert.doesNotMatch(
      body,
      /\$\{\{\s*secrets\.HABIT_KEY\s*\}\}/,
      'run: script body must not contain ${{ secrets.HABIT_KEY }} ' +
        '(secret must not be expanded into script text)'
    );
  }
});

test('experiment curl uses x-habit-key header, not ?key= in the URL', () => {
  const text = loadWorkflow();
  const bodies = runScriptBodies(text);
  const joined = bodies.join('\n');

  assert.match(
    joined,
    /x-habit-key/,
    'curl/request must send the x-habit-key header'
  );
  // Experiment URL is built as $BASE/api/experiment?... — never append ?key=.
  assert.doesNotMatch(
    joined,
    /[?&]key=/,
    'experiment URL must not carry ?key= / &key= (use x-habit-key header)'
  );
  assert.match(
    joined,
    /\/api\/experiment\?/,
    'run script should hit /api/experiment'
  );
});
