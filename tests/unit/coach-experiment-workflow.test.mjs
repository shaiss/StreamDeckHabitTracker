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

const SECRET_IN_RUN_RE = /\$\{\{\s*secrets\.HABIT_KEY\s*\}\}/;
const SECRET_ENV_RE = /^\$\{\{\s*secrets\.HABIT_KEY\s*\}\}$/;
// Header option must carry the HABIT_KEY expansion (double-quoted, or unquoted with no space after the colon).
// Built with RegExp so a source literal is not mistaken for a header value.
const HABIT_HEADER_NAME = '[Xx]-[Hh]abit-[Kk]ey';
const HABIT_HEADER_VALUE = '\\$\\{?HABIT_KEY\\}?';
const HABIT_KEY_HEADER_RE = new RegExp(
  '(?:--header(?:\\s+|=)|-H\\s+)(?:"' +
    HABIT_HEADER_NAME +
    ':\\s*' +
    HABIT_HEADER_VALUE +
    '"|' +
    HABIT_HEADER_NAME +
    ':' +
    HABIT_HEADER_VALUE +
    '(?![A-Za-z0-9_]))'
);
// `|` / `>` plus optional chomp/indent indicators and a trailing comment.
const BLOCK_HEADER_RE =
  /^(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?)\s*(?:#.*)?$/;

function loadWorkflow() {
  assert.ok(existsSync(WORKFLOW), 'coach-experiment.yml must exist');
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.ok(text.trim().length > 0, 'coach-experiment.yml must be non-empty');
  return text;
}

function leading(line) {
  return line.match(/^(\s*)/)[1].length;
}

/** Drop an unquoted `#` comment. `#` starts a comment only at the start of the string or after whitespace, so plain scalars may contain `#`. */
function stripYamlComment(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) break;
    out += c;
  }
  return out;
}

function unquote(s) {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFlowMap(s) {
  const t = stripYamlComment(s).trim();
  const open = t.indexOf('{');
  const close = t.lastIndexOf('}');
  if (open !== 0 || close < 0) return { _unparsed: t };
  const inner = t.slice(open + 1, close).trim();
  if (inner === '') return {};
  const map = {};
  for (const part of inner.split(',')) {
    const kv = part.match(/^\s*([^:]+):\s*(.*)$/);
    if (kv) map[kv[1].trim()] = unquote(stripYamlComment(kv[2]).trim());
  }
  return map;
}

function isBlockHeader(afterColon) {
  return BLOCK_HEADER_RE.test(afterColon.trim());
}

function blockIndentIndicator(header) {
  const m = header
    .trim()
    .match(/^[|>](?:([1-9])[+-]?|[+-]([1-9]))?\s*(?:#.*)?$/);
  if (!m) return 0;
  return Number(m[1] || m[2] || 0);
}

/** Slice of the file before the top-level `jobs:` key. */
function preambleBeforeJobs(text) {
  const m = text.match(/^jobs:\s*$/m);
  assert.ok(m, 'workflow must declare a top-level jobs: key');
  return text.slice(0, m.index);
}

function readBlockMapping(lines, start, parentKeyIndent) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    const L = lines[i];
    if (L.trim() === '' || /^\s*#/.test(L)) {
      i++;
      continue;
    }
    if (leading(L) <= parentKeyIndent) break;
    const kv = L.match(/^(\s*)([^:#\s][^:]*):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    map[kv[2].trim()] = unquote(stripYamlComment(kv[3]).trim());
    i++;
  }
  return { map, nextIndex: i };
}

function readBlockScalar(lines, headerIndex, keyIndent, header) {
  const indicated = blockIndentIndicator(header);
  let contentIndent = indicated > 0 ? keyIndent + indicated : null;
  const chunk = [];
  let i = headerIndex + 1;
  for (; i < lines.length; i++) {
    const L = lines[i];
    if (L.trim() === '') {
      chunk.push(L);
      continue;
    }
    const lead = leading(L);
    if (contentIndent == null) {
      if (lead <= keyIndent) break;
      contentIndent = lead;
    }
    if (lead < contentIndent) break;
    chunk.push(L);
  }
  return { body: chunk.join('\n'), nextIndex: i };
}

function applyPropertyFromLine(step, rest, lines, lineIndex, keyIndent) {
  const prop = rest.match(/^([^:#\s][^:]*):\s*(.*)$/);
  if (!prop) return lineIndex + 1;
  const key = prop[1].trim();
  const raw = prop[2];
  const trimmed = stripYamlComment(raw).trim();

  if (key === 'run') {
    if (isBlockHeader(raw.trim())) {
      const { body, nextIndex } = readBlockScalar(
        lines,
        lineIndex,
        keyIndent,
        raw.trim()
      );
      step.run = body;
      return nextIndex;
    }
    step.run = unquote(trimmed);
    return lineIndex + 1;
  }

  if (key === 'env') {
    if (trimmed.startsWith('{')) {
      step.env = parseFlowMap(trimmed);
      return lineIndex + 1;
    }
    if (trimmed === '') {
      const { map, nextIndex } = readBlockMapping(
        lines,
        lineIndex + 1,
        keyIndent
      );
      step.env = map;
      return nextIndex;
    }
    return lineIndex + 1;
  }

  return lineIndex + 1;
}

function readStep(lines, start, dashIndent, keyIndent) {
  const step = { env: {}, run: undefined };
  let i = applyPropertyFromLine(
    step,
    lines[start].slice(keyIndent),
    lines,
    start,
    keyIndent
  );
  while (i < lines.length) {
    const L = lines[i];
    if (L.trim() === '' || /^\s*#/.test(L)) {
      i++;
      continue;
    }
    const ind = leading(L);
    if (ind <= dashIndent || ind < keyIndent) break;
    if (ind === keyIndent) {
      i = applyPropertyFromLine(step, L.slice(keyIndent), lines, i, keyIndent);
      continue;
    }
    i++;
  }
  return { step, nextIndex: i };
}

/**
 * Walk `jobs.*.steps[]` into `{ env, run }` objects. `run` covers list-item
 * and mapping forms, including block scalars with chomp/indent indicators
 * and a trailing comment on the header (`run: | # …`).
 */
function parseWorkflowSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let i = 0;
  while (i < lines.length) {
    const sh = lines[i].match(/^(\s*)steps:\s*(?:#.*)?$/);
    if (!sh) {
      i++;
      continue;
    }
    const stepsIndent = sh[1].length;
    i++;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || /^\s*#/.test(raw)) {
        i++;
        continue;
      }
      if (leading(raw) <= stepsIndent) break;
      const item = raw.match(/^(\s*)-\s+(.*)$/);
      if (!item) break;
      const dashIndent = item[1].length;
      const keyIndent = raw.length - item[2].length;
      const { step, nextIndex } = readStep(lines, i, dashIndent, keyIndent);
      steps.push(step);
      i = nextIndex;
    }
  }
  return steps;
}

function runScriptBodies(text) {
  return parseWorkflowSteps(text)
    .map((s) => s.run)
    .filter((run) => run != null && run !== '');
}

function parseTopLevelPermissions(text) {
  const preamble = preambleBeforeJobs(text);
  const lines = preamble.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^permissions:\s*(.*)$/);
    if (!m) continue;
    const trimmed = stripYamlComment(m[1]).trim();
    if (trimmed.startsWith('{')) return parseFlowMap(trimmed);
    if (trimmed !== '') return { _invalid: trimmed };
    const { map } = readBlockMapping(lines, i + 1, 0);
    // A bare `permissions:` line is YAML null, not an empty mapping.
    if (Object.keys(map).length === 0) return { _bare: true };
    return map;
  }
  return undefined;
}

function assertEmptyPermissions(perms) {
  assert.deepEqual(perms, {}, 'expected top-level permissions: {}');
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

function experimentSteps(steps) {
  return steps.filter(
    (s) => typeof s.run === 'string' && /\/api\/experiment/.test(s.run)
  );
}

function assertHabitKeyOnExperimentStep(steps) {
  const exp = experimentSteps(steps);
  assert.ok(exp.length > 0, 'expected a step whose run calls /api/experiment');
  for (const s of exp) {
    assert.match(
      String(s.env?.HABIT_KEY ?? ''),
      SECRET_ENV_RE,
      'HABIT_KEY must be set from secrets in the experiment step env block'
    );
    assert.doesNotMatch(
      s.run,
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

/**
 * Tokenize a shell script: join backslash-newline continuations, skip
 * comments and heredoc bodies, and keep quote style on each word.
 */
function tokenizeShell(script) {
  const s = String(script);
  const tokens = [];
  let i = 0;
  const n = s.length;

  function skipContinuations() {
    let skipped = false;
    while (i < n && s[i] === '\\') {
      const nl = s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n');
      if (!nl) break;
      i++;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      skipped = true;
    }
    return skipped;
  }

  function skipHeredocBody(terminator, stripTabs) {
    while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
    if (s[i] === '\r') i++;
    if (s[i] === '\n') i++;
    while (i < n) {
      const start = i;
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      let line = s.slice(start, i);
      if (stripTabs) line = line.replace(/^\t+/, '');
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      if (line === terminator) break;
    }
  }

  function readWord() {
    let value = '';
    let sawSingle = false;
    let sawDouble = false;
    let sawUnquoted = false;
    while (i < n) {
      if (skipContinuations()) continue;
      const c = s[i];
      if (c === "'") {
        sawSingle = true;
        i++;
        while (i < n && s[i] !== "'") value += s[i++];
        if (s[i] === "'") i++;
        continue;
      }
      if (c === '"') {
        sawDouble = true;
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < n) {
            const nxt = s[i + 1];
            if (nxt === '\r' && s[i + 2] === '\n') {
              i += 3;
              continue;
            }
            if (nxt === '\n') {
              i += 2;
              continue;
            }
            if ('"$\\`'.includes(nxt)) {
              value += nxt;
              i += 2;
              continue;
            }
          }
          value += s[i++];
        }
        if (s[i] === '"') i++;
        continue;
      }
      if (c === '$' && s[i + 1] === '(') break;
      if (c === '#' && value === '' && !sawSingle && !sawDouble) break;
      if (/[\s;|&(){}<>`]/.test(c)) break;
      if (c === '\\') {
        i++;
        if (i < n) value += s[i++];
        sawUnquoted = true;
        continue;
      }
      value += c;
      sawUnquoted = true;
      i++;
    }
    let quote = null;
    if (sawSingle && !sawDouble && !sawUnquoted) quote = "'";
    else if (sawDouble && !sawSingle && !sawUnquoted) quote = '"';
    return { type: 'word', value, quote };
  }

  while (i < n) {
    if (s[i] === ' ' || s[i] === '\t') {
      i++;
      continue;
    }
    if (skipContinuations()) continue;
    if (s[i] === '\r') i++;
    if (s[i] === '\n') {
      tokens.push({ type: 'op', value: '\n' });
      i++;
      continue;
    }
    if (s[i] === '#') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (s[i] === '$' && s[i + 1] === '(') {
      tokens.push({ type: 'op', value: '$(' });
      i += 2;
      continue;
    }
    if (s[i] === '<' && s[i + 1] === '<') {
      i += 2;
      const stripTabs = s[i] === '-';
      if (stripTabs) i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      const term = readWord();
      tokens.push({ type: 'op', value: '<<' });
      skipHeredocBody(term.value, stripTabs);
      continue;
    }
    if ((s[i] === '&' || s[i] === '|') && s[i + 1] === s[i]) {
      tokens.push({ type: 'op', value: s[i] + s[i] });
      i += 2;
      continue;
    }
    if (/[;|&(){}<>`]/.test(s[i])) {
      tokens.push({ type: 'op', value: s[i] });
      i++;
      continue;
    }
    const word = readWord();
    if (word.value !== '' || word.quote) tokens.push(word);
    else i++;
  }
  return tokens;
}

function isCurlCommand(token) {
  return token.type === 'word' && /(?:^|\/)curl$/.test(token.value);
}

function isCommandPosition(tokens, index) {
  if (index === 0) return true;
  const prev = tokens[index - 1];
  if (prev.type !== 'op') return false;
  return prev.value !== '<' && prev.value !== '>' && prev.value !== '>>';
}

function parseCurlInvocations(script) {
  const tokens = tokenizeShell(script);
  const curls = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isCurlCommand(tokens[i]) || !isCommandPosition(tokens, i)) continue;
    const argv = [tokens[i]];
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.type === 'op') {
        if (t.value === '<<' || t.value === '<' || t.value === '>' || t.value === '>>') {
          j++;
          if (t.value !== '<<' && tokens[j] && tokens[j].type === 'word') j++;
          continue;
        }
        break;
      }
      argv.push(t);
      j++;
    }
    curls.push(argv);
    i = j - 1;
  }
  return curls;
}

function isExperimentUrlArg(token) {
  if (!token || token.type !== 'word') return false;
  if (/^\$\{?URL\}?$/.test(token.value)) return true;
  return /\/api\/experiment(?=$|[?&#])/.test(token.value);
}

function experimentCurlInvocations(script) {
  return parseCurlInvocations(script).filter((argv) =>
    argv.slice(1).some(isExperimentUrlArg)
  );
}

const HABIT_HEADER_VALUE_RE = new RegExp(
  '^' + HABIT_HEADER_NAME + ':\\s*' + HABIT_HEADER_VALUE + '$'
);
const HABIT_HEADER_VALUE_UNQUOTED_RE = new RegExp(
  '^' + HABIT_HEADER_NAME + ':' + HABIT_HEADER_VALUE + '$'
);

function isHabitKeyHeaderValue(token) {
  if (!token || token.type !== 'word') return false;
  if (token.quote === "'") return false;
  if (token.quote == null) return HABIT_HEADER_VALUE_UNQUOTED_RE.test(token.value);
  return HABIT_HEADER_VALUE_RE.test(token.value);
}

function curlHasHabitKeyHeader(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.type !== 'word') continue;
    if (a.value === '-H' || a.value === '--header') {
      if (isHabitKeyHeaderValue(argv[i + 1])) return true;
      continue;
    }
    const eq = a.value.match(/^--header=(.*)$/);
    if (eq) {
      // `--header="x-habit-key: $HABIT_KEY"` is one mixed word (quote null)
      // with a space after the colon; allow that attached double-quoted form.
      if (a.quote === "'") continue;
      if (
        HABIT_HEADER_VALUE_RE.test(eq[1]) ||
        HABIT_HEADER_VALUE_UNQUOTED_RE.test(eq[1])
      ) {
        return true;
      }
    }
  }
  return false;
}

function assertExperimentCurlSendsHabitKey(script) {
  const curls = experimentCurlInvocations(script);
  assert.ok(
    curls.length > 0,
    'expected a curl that requests $URL or /api/experiment'
  );
  for (const argv of curls) {
    assert.ok(
      curlHasHabitKeyHeader(argv),
      'curl/request must send the x-habit-key header with $HABIT_KEY'
    );
  }
}

function assertHabitKeyHeaderOnExperimentSteps(steps) {
  const exp = experimentSteps(steps);
  assert.ok(exp.length > 0, 'expected a step whose run calls /api/experiment');
  for (const s of exp) {
    assertExperimentCurlSendsHabitKey(s.run);
  }
}

/** Build a one-step experiment workflow with a URL assignment and the given run lines. */
function experimentStepYaml(runLines) {
  return [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - name: experiment',
    '        env:',
    '          HABIT_KEY: ${{ secrets.HABIT_KEY }}',
    '        run: |',
    '          URL="$BASE/api/experiment?run=1"',
    ...runLines.map((l) => '          ' + l),
  ].join('\n');
}

function assertHeaderRejected(runLines) {
  const steps = parseWorkflowSteps(experimentStepYaml(runLines));
  assert.throws(
    () => assertHabitKeyHeaderOnExperimentSteps(steps),
    /x-habit-key|experiment URL|\$URL/,
    'experiment curl must carry the header as an argument'
  );
}

test('coach-experiment.yml exists and is non-empty', () => {
  loadWorkflow();
});

test('top-level permissions: {} appears before jobs: (#115 least privilege)', () => {
  assertEmptyPermissions(parseTopLevelPermissions(loadWorkflow()));
});

test('permissions check rejects a grant hidden after a comment', () => {
  const text = [
    'name: example',
    'permissions:',
    '  # Request repository access',
    '  contents: write',
    'jobs:',
    '',
  ].join('\n');
  assert.throws(
    () => assertEmptyPermissions(parseTopLevelPermissions(text)),
    /permissions: \{\}/
  );
  assertEmptyPermissions(
    parseTopLevelPermissions('name: example\npermissions: {}\njobs:\n')
  );
});

test('permissions check rejects a bare permissions: line', () => {
  const text = [
    'name: example',
    'permissions:',
    'jobs:',
    '',
  ].join('\n');
  assert.throws(
    () => assertEmptyPermissions(parseTopLevelPermissions(text)),
    /permissions: \{\}/
  );
});

test('HABIT_KEY is supplied via the experiment step env, not expanded in run: text', () => {
  const text = loadWorkflow();
  const steps = parseWorkflowSteps(text);
  assertHabitKeyOnExperimentStep(steps);
  assertNoSecretInRunBodies(runScriptBodies(text));
});

test('HABIT_KEY in a different step env does not satisfy the experiment step', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - name: other',
    '        env:',
    '          HABIT_KEY: ${{ secrets.HABIT_KEY }}',
    '        run: echo "other"',
    '      - name: experiment',
    '        env:',
    '          BASE: https://example.test',
    '        run: |',
    '          curl "$BASE/api/experiment?run=1"',
  ].join('\n');
  const steps = parseWorkflowSteps(yaml);
  const exp = experimentSteps(steps);
  assert.equal(exp.length, 1);
  assert.equal(exp[0].env.HABIT_KEY, undefined);
  assert.throws(
    () => assertHabitKeyOnExperimentStep(steps),
    /experiment step env/
  );
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

test('runScriptBodies extracts bodies under commented or indicated block headers', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - run: | # diagnostic',
    '          echo "${{ secrets.HABIT_KEY }}"',
    '      - run: |+',
    '          echo "plus body"',
    '      - run: |2',
    '          echo "indent body"',
    '      - run: >-',
    '          echo "fold body"',
  ].join('\n');
  const bodies = runScriptBodies(yaml);
  const secret = bodies.filter((b) => SECRET_IN_RUN_RE.test(b));
  assert.equal(
    secret.length,
    1,
    'secret under `run: | # …` must be extracted from the block body'
  );
  assert.throws(
    () => assertNoSecretInRunBodies(bodies),
    /secrets\.HABIT_KEY/,
    'secret interpolation below a commented block header must fail the secret check'
  );
  assert.ok(
    bodies.some((b) => b.includes('plus body')),
    '`run: |+` body must be extracted'
  );
  assert.ok(
    bodies.some((b) => b.includes('indent body')),
    '`run: |2` body must be extracted'
  );
  assert.ok(
    bodies.some((b) => b.includes('fold body')),
    '`run: >-` body must be extracted'
  );
});

test('runScriptBodies preserves # inside YAML plain scalars', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - run: echo prefix#${{ secrets.HABIT_KEY }}',
  ].join('\n');
  const bodies = runScriptBodies(yaml);
  assert.equal(
    bodies.length,
    1,
    'inline `run: echo prefix#…` must be extracted as a plain scalar'
  );
  assert.match(
    bodies[0],
    SECRET_IN_RUN_RE,
    '`#` without preceding whitespace must stay in the run value'
  );
  assert.throws(
    () => assertNoSecretInRunBodies(bodies),
    /secrets\.HABIT_KEY/,
    'secret interpolation after prefix# must fail the secret check'
  );
});

test('experiment curl uses x-habit-key header, not ?key= in the URL', () => {
  const text = loadWorkflow();
  const steps = parseWorkflowSteps(text);
  const bodies = experimentSteps(steps).map((s) => s.run);
  const joined = bodies.join('\n');
  assertHabitKeyHeaderOnExperimentSteps(steps);
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
        'curl/request must send the x-habit-key header with $HABIT_KEY'
      ),
    /x-habit-key/
  );
  const withHeader = requestCommandText([
    '# The key rides in the x-habit-key header, never the URL',
    'curl -sS --max-time 120 -H "x-habit-key: $HABIT_KEY" "$URL"',
  ]);
  assert.match(withHeader, HABIT_KEY_HEADER_RE);
});

test('x-habit-key assertion rejects an empty header value', () => {
  const empty = requestCommandText([
    'curl -sS --max-time 120 -H "x-habit-key:" "$URL"',
  ]);
  assert.doesNotMatch(
    empty,
    HABIT_KEY_HEADER_RE,
    'colon-only x-habit-key header must not satisfy the header check'
  );
  assert.throws(
    () =>
      assert.match(
        empty,
        HABIT_KEY_HEADER_RE,
        'curl/request must send the x-habit-key header with $HABIT_KEY'
      ),
    /x-habit-key/
  );
});

test('x-habit-key assertion rejects a single-quoted header value', () => {
  const braced = requestCommandText([
    "curl -sS --max-time 120 -H 'x-habit-key: ${HABIT_KEY}' \"$URL\"",
  ]);
  assert.doesNotMatch(
    braced,
    HABIT_KEY_HEADER_RE,
    'single-quoted header values must not satisfy the header check'
  );
  assert.throws(
    () =>
      assert.match(
        braced,
        HABIT_KEY_HEADER_RE,
        'curl/request must send the x-habit-key header with $HABIT_KEY'
      ),
    /x-habit-key/
  );
});

test('x-habit-key assertion accepts --header and a case-insensitive header name', () => {
  const longFlag = requestCommandText([
    'curl -sS --max-time 120 --header "x-habit-key: $HABIT_KEY" "$URL"',
  ]);
  assert.match(longFlag, HABIT_KEY_HEADER_RE);
  const mixedCase = requestCommandText([
    'curl -sS --max-time 120 -H "X-Habit-Key: $HABIT_KEY" "$URL"',
  ]);
  assert.match(mixedCase, HABIT_KEY_HEADER_RE);
  const unquoted = requestCommandText([
    'curl -sS --max-time 120 -H x-habit-key:$HABIT_KEY "$URL"',
  ]);
  assert.match(unquoted, HABIT_KEY_HEADER_RE);
});

test('x-habit-key header on a different step does not satisfy the experiment step', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - name: other',
    '        run: |',
    '          curl -sS -H "x-habit-key: $HABIT_KEY" "$BASE/api/other"',
    '      - name: experiment',
    '        env:',
    '          HABIT_KEY: ${{ secrets.HABIT_KEY }}',
    '        run: |',
    '          curl "$BASE/api/experiment?run=1"',
  ].join('\n');
  const bodies = experimentSteps(parseWorkflowSteps(yaml)).map((s) => s.run);
  const requestCommands = requestCommandText(bodies);
  assert.doesNotMatch(
    requestCommands,
    HABIT_KEY_HEADER_RE,
    'a header on a non-experiment step must not satisfy the header check'
  );
});

test('x-habit-key header is required on every experiment step', () => {
  const yaml = [
    'jobs:',
    '  experiment:',
    '    steps:',
    '      - name: first',
    '        env:',
    '          HABIT_KEY: ${{ secrets.HABIT_KEY }}',
    '        run: |',
    '          curl -sS -H "x-habit-key: $HABIT_KEY" "$BASE/api/experiment?run=1"',
    '      - name: duplicate',
    '        env:',
    '          HABIT_KEY: ${{ secrets.HABIT_KEY }}',
    '        run: |',
    '          curl -sS "$BASE/api/experiment?run=1"',
  ].join('\n');
  const steps = parseWorkflowSteps(yaml);
  assert.equal(experimentSteps(steps).length, 2);
  assert.throws(
    () => assertHabitKeyHeaderOnExperimentSteps(steps),
    /x-habit-key/,
    'a duplicated experiment step that drops the header must fail'
  );
});

test('x-habit-key assertion rejects an unquoted header with a space after the colon', () => {
  const spaced = requestCommandText([
    'curl -sS --max-time 120 -H x-habit-key: $HABIT_KEY "$URL"',
  ]);
  assert.doesNotMatch(
    spaced,
    HABIT_KEY_HEADER_RE,
    'unquoted header with a space after the colon must not satisfy the header check'
  );
  assert.throws(
    () =>
      assert.match(
        spaced,
        HABIT_KEY_HEADER_RE,
        'curl/request must send the x-habit-key header with $HABIT_KEY'
      ),
    /x-habit-key/
  );
});

test('x-habit-key header in an echo does not satisfy the experiment curl', () => {
  assertHeaderRejected([
    'echo \'-H "x-habit-key: $HABIT_KEY"\'',
    'RESP=$(curl -sS --max-time 120 "$URL")',
  ]);
});

test('x-habit-key header is accepted on a continued experiment curl', () => {
  const steps = parseWorkflowSteps(
    experimentStepYaml([
      'RESP=$(curl -sS --max-time 120 \\',
      '  -H "x-habit-key: $HABIT_KEY" \\',
      '  "$URL")',
    ])
  );
  assertHabitKeyHeaderOnExperimentSteps(steps);
});

test('x-habit-key header is required on a continued experiment curl', () => {
  assertHeaderRejected([
    'RESP=$(curl -sS --max-time 120 \\',
    '  "$URL")',
    'echo \'-H "x-habit-key: $HABIT_KEY"\'',
  ]);
});

test('x-habit-key header on a different curl in the same step does not satisfy the experiment curl', () => {
  assertHeaderRejected([
    'curl -sS -H "x-habit-key: $HABIT_KEY" "$BASE/api/other"',
    'RESP=$(curl -sS --max-time 120 "$URL")',
  ]);
});

test('a commented-out x-habit-key header does not satisfy the experiment curl', () => {
  assertHeaderRejected([
    '# -H "x-habit-key: $HABIT_KEY"',
    'RESP=$(curl -sS --max-time 120 "$URL")',
  ]);
});

test('x-habit-key header inside a heredoc does not satisfy the experiment curl', () => {
  assertHeaderRejected([
    'cat <<EOF',
    '-H "x-habit-key: $HABIT_KEY"',
    'EOF',
    'RESP=$(curl -sS --max-time 120 "$URL")',
  ]);
});

test('x-habit-key header in a curl heredoc body does not satisfy the experiment curl', () => {
  assertHeaderRejected([
    'curl -sS --max-time 120 "$URL" <<EOF',
    '-H "x-habit-key: $HABIT_KEY"',
    'EOF',
  ]);
});
