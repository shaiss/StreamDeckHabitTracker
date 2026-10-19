#!/usr/bin/env node
// Value-based leak check (Cipher L1): is the REAL HABIT_KEY anywhere in the
// tracked tree, including inside the (deflated) profile and plugin zips that
// `git grep` cannot see into? Reads the value from the HABIT_KEY env var
// (a CI secret) and NEVER prints it — only file names. Skips when unset.
// Fail-closed: an unreadable archive or file is an error.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIfPresent, unzipEntries, valueNeedles } from './lib-secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const value = process.env.HABIT_KEY || '';
if (!value) {
  console.log('HABIT_KEY not provided; value scan skipped.');
  process.exit(0);
}
const needles = valueNeedles(value);
const ZIPPED = /\.(streamDeckProfile|streamDeckPlugin)$/;
const hits = [];

function check(name, buf) {
  if (needles.some((n) => buf.includes(n))) hits.push(name);
  if (ZIPPED.test(name)) {
    for (const e of unzipEntries(buf)) check(name + '!' + e.name, e.data);   // throws if unreadable
  }
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
if (files.length < 50) { console.error('git ls-files returned too few files'); process.exit(2); }
for (const f of files) {
  const buf = readIfPresent(join(ROOT, f));
  if (buf === null) continue;   // deleted in the working tree, not yet committed
  check(f, buf);
}

if (hits.length) {
  console.error('::error::The HABIT_KEY value is committed in:\n' + hits.map((h) => '  ' + h).join('\n'));
  process.exit(1);
}
console.log('Value scan clean (' + files.length + ' tracked files, archives inflated).');
