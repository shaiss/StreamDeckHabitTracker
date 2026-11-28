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

/** Compact empty mapping only — a bare `permissions:` line is not enough. */
const EMPTY_PERMISSIONS_RE = /^permissions:\s*\{\s*\}\s*$/m;
/** Curl header option, not a comment that merely mentions the header name. */
const HABIT_KEY_HEADER_RE = new RegExp('-H\\s+["\']x-habit-key:');
const SECRET_IN_RUN_RE = /\$\{\{\s*secrets\.HABIT_KEY\s*\}\}/;

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

function assertCompactEmptyPermissions(preamble) {
  assert.match(
    preamble,
    EMPTY_PERMISSIONS_RE,
    'expected top-level permissions: {} before jobs:'
  );
}

/**
 * Extract the shell body of every `run: |` / `run: >` block under steps
 * (and plain `run: "..."` / `run: '...'` / single-line `run:`), including
 * list-item forms (`- run: |` / `- run: …`). Used so we can assert the
 * secret is never expanded into script text, while still allowing
 * `HABIT_KEY: ${{ secrets.HABIT_KEY }}` under `env:`.
 *
 * Body indent is measured from the column where `run` starts, not from the
 * start of the line, so a leading `- ` does not swallow or skip the body.
 */
function runScriptBodies(text) {
  const bodies = [];
  const lines = text.split('\n');
  // Optional list marker, then `run:`. Capture ends just before `run`
  // so callers can take indent from that column.
  const runPrefix = /^(\s*(?:-\s+)?)run:/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prefix = line.match(runPrefix);
    if (!prefix) continue;
    const runColumn = prefix[1].length;
    const after = line.slice(line.indexOf('run:') + 'run:'.length);
    const block = after.match(/^\s*[|>]-?\s*$/);
    if (block) {
      const chunk = [];
      for (let j = i + 1; j < lines.length; j++) {
        const L = lines[j];
        if (L.trim() === '') {
          chunk.push(L);
          continue;
        }
        const lead = L.match(/^(\s*)/)[1].length;
        if (lead <= runColumn) break;
        chunk.push(L);
        i = j;
      }
      bodies.push(chunk.join('\n'));
      continue;
    }
    const inline = after.match(/^\s*(.+)$/);
    if (inline) bodies.push(inline[1]);
  }
  return bodies;
}

function assertNoSecretInRunBodies(bodies) {
  assert.ok(bodies.length > 0, 'expected at least one run: script body');
  for (const body of bodies) {
    assert.doesNotMatch(
      body,
      SECRET_IN_RUN_RE,
      'run: script body must not contain ${{ secrets.HABIT_KEY }} ' +
        '(secret must not be expanded into script text)'
    );
  }
}

/** Join run bodies, dropping comment-only lines, for request-option checks. */
function requestCommandText(bodies) {
  return bodies
    .join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('coach-experiment.yml exists and is non-empty', () => {
  loadWorkflow();
});

test('top-level permissions: {} appears before jobs: (#115 least privilege)', () => {
  const text = loadWorkflow();
  const preamble = preambleBeforeJobs(text);
  assertCompactEmptyPermissions(preamble);
});

test('permissions check rejects a grant hidden after a comment', () => {
  const preamble = [
    'name: example',
    'permissions:',
    '  # Request repository access',
    '  contents: write',
    '',
  ].join('\n');
  assert.throws(
    () => assertCompactEmptyPermissions(preamble),
    /permissions: \{\}/
  );
  assertCompactEmptyPermissions('name: example\npermissions: {}\n');
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

  assertNoSecretInRunBodies(runScriptBodies(text));
});

test('runScriptBodies extracts list-item - run: steps, including secret interpolation', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - run: echo "${{ secrets.HABIT_KEY }}"',
    '      - run: |',
    '          echo "block body"',
    '      - name: named',
    '        run: echo "named body"',
  ].join('\n');
  const bodies = runScriptBodies(yaml);
  const inlineSecret = bodies.filter((b) => SECRET_IN_RUN_RE.test(b));
  assert.equal(
    inlineSecret.length,
    1,
    'list-item `- run: echo "${{ secrets.HABIT_KEY }}"` must be extracted'
  );
  assert.match(inlineSecret[0], /echo "\$\{\{ secrets\.HABIT_KEY \}\}"/);
  assert.ok(
    bodies.some((b) => b.includes('echo "block body"')),
    'list-item `- run: |` block body must be extracted'
  );
  assert.ok(
    bodies.some((b) => b.includes('echo "named body"')),
    'indented `run:` under a named step must still be extracted'
  );
  assert.throws(
    () => assertNoSecretInRunBodies(bodies),
    /secrets\.HABIT_KEY/,
    'extracted list-item secret interpolation must fail the secret check'
  );
});

test('experiment curl uses x-habit-key header, not ?key= in the URL', () => {
  const text = loadWorkflow();
  const bodies = runScriptBodies(text);
  const joined = bodies.join('\n');
  const requestCommands = requestCommandText(bodies);

  assert.match(
    requestCommands,
    HABIT_KEY_HEADER_RE,
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

test('x-habit-key assertion matches the header option, not a comment', () => {
  const commentOnly = requestCommandText([
    'URL="$BASE/api/experiment?run=1"',
    '# The key rides in the x-habit-key header, never the URL',
    'curl -sS --max-time 120 "$URL"',
  ]);
  assert.doesNotMatch(
    commentOnly,
    HABIT_KEY_HEADER_RE,
    'a comment mentioning x-habit-key must not satisfy the header check'
  );
  assert.throws(
    () =>
      assert.match(
        commentOnly,
        HABIT_KEY_HEADER_RE,
        'curl/request must send the x-habit-key header'
      ),
    /x-habit-key/
  );
  const withHeader = requestCommandText([
    '# The key rides in the x-habit-key header, never the URL',
    'curl -sS --max-time 120 -H "x-habit-key: $HABIT_KEY" "$URL"',
  ]);
  assert.match(withHeader, HABIT_KEY_HEADER_RE);
});
