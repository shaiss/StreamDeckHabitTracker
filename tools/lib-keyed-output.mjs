// Where a --key profile may be written. The repo is public, so a keyed
// profile may land in git-ignored dist/ or outside the checkout — never in
// streamdeck-plugin/ or public/downloads/. The check follows symlinks: a
// dist/ that points at a shipped directory is not dist/.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

// Real path of `p`, or of its nearest existing parent with the missing tail
// reattached. A not-yet-created output file still resolves through the
// directory that would contain it.
export function resolvedPath(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) {
      const err = new Error('cannot resolve ' + p);
      err.code = 'ENOENT';
      throw err;
    }
    tail.push(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail.reverse());
}

function inside(path, dir) {
  return path === dir || path.startsWith(dir + sep);
}

// True when a keyed profile may be written to profilePath. Fail closed if
// the path cannot be resolved. `root` is the repository root.
export function keyedOutputAllowed(profilePath, root) {
  try {
    const realOut = resolvedPath(profilePath);
    const realRoot = realpathSync(root);
    // Compare against the lexical dist/ under the *resolved repo root*, not
    // realpath(root/dist): a symlinked dist/ must not become the allow-zone.
    const distRoot = join(realRoot, 'dist');
    if (!inside(realOut, realRoot)) return true;
    return inside(realOut, distRoot) && realOut !== distRoot;
  } catch {
    return false;
  }
}
