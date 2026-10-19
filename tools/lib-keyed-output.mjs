// Where a --key profile may be written. The repo is public, so a keyed
// profile may land in git-ignored dist/ or outside the checkout — never in
// streamdeck-plugin/ or public/downloads/. The check follows live symlinks
// (a dist/ that points at a shipped directory is not dist/) and rejects
// dangling ones: lstat sees the link, readlink's target does not exist, and
// writeFileSync would follow it and create the secret at that target.
//
// The write is pinned to the same decision. The parent directory is opened
// with O_NOFOLLOW from `/` (via /proc/self/fd, the Linux openat), the allow
// check is repeated on that fd's real path, and the bytes land in a new
// inode that is rename()d into place. rename replaces a symlink; it does
// not follow one. Fail closed when the destination cannot be pinned.
import { randomBytes } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, lstatSync, openSync, readlinkSync,
  realpathSync, renameSync, unlinkSync, writeSync, constants
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW } = constants;

function refuse(msg) {
  const err = new Error(msg);
  err.code = 'EPERM';
  throw err;
}

// Real path of `p`, or of its nearest existing parent with the missing tail
// reattached. A not-yet-created output file still resolves through the
// directory that would contain it. A symlink anywhere on the existing
// portion is resolved with readlink; a dangling link (target missing) throws
// instead of being treated as a missing path component.
export function resolvedPath(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        const parent = dirname(cur);
        if (parent === cur) {
          const err = new Error('cannot resolve ' + p);
          err.code = 'ENOENT';
          throw err;
        }
        tail.push(basename(cur));
        cur = parent;
        continue;
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      const link = readlinkSync(cur);
      const target = isAbsolute(link) ? link : resolve(dirname(cur), link);
      try {
        lstatSync(target);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          const err = new Error('dangling symlink: ' + cur);
          err.code = 'ELOOP';
          throw err;
        }
        throw e;
      }
      // The direct target exists but may itself be a dangling link, or a loop.
      let real;
      try {
        real = realpathSync(cur);
      } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'ENOTDIR')) {
          const err = new Error('dangling symlink: ' + cur);
          err.code = 'ELOOP';
          throw err;
        }
        throw e;
      }
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const real = realpathSync(cur);
    return tail.length ? join(real, ...tail.reverse()) : real;
  }
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

function safeName(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    refuse('refusing keyed write: bad output name');
  }
  return name;
}

// Open `absReal` (already realpath'd) as a directory fd without following a
// symlink at any component. A swap-to-symlink between the check and the open
// fails with ELOOP instead of opening the new target.
function openDirNoFollow(absReal) {
  if (process.platform !== 'linux' || !O_NOFOLLOW) {
    refuse('keyed write cannot be pinned on this platform');
  }
  const parts = absReal.split(sep).filter(Boolean);
  let dirfd = openSync(sep, O_RDONLY | O_DIRECTORY);
  try {
    for (const name of parts) {
      const next = openSync(
        '/proc/self/fd/' + dirfd + '/' + name,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW
      );
      closeSync(dirfd);
      dirfd = next;
    }
    return dirfd;
  } catch (e) {
    try { closeSync(dirfd); } catch { /* already closed or never pinned */ }
    throw e;
  }
}

function procPath(dirfd, name) {
  return '/proc/self/fd/' + dirfd + '/' + name;
}

// Write `data` to profilePath only when the pinned parent directory is still
// an allowed keyed destination. Throws EPERM (or the open error) otherwise
// and does not follow a symlink at the destination name.
export function writeKeyedOutput(profilePath, root, data) {
  if (!keyedOutputAllowed(profilePath, root)) {
    refuse('refusing keyed write outside dist/: ' + profilePath);
  }
  const name = safeName(basename(resolve(profilePath)));
  const parentReal = resolvedPath(dirname(resolve(profilePath)));
  const dirfd = openDirNoFollow(parentReal);
  let tmp = null;
  try {
    const pinned = realpathSync('/proc/self/fd/' + dirfd);
    const pinnedOut = join(pinned, name);
    if (pinned !== parentReal || !keyedOutputAllowed(pinnedOut, root)) {
      refuse('keyed destination could not be pinned: ' + profilePath);
    }
    tmp = '.ht-keyed-' + process.pid + '-' + randomBytes(8).toString('hex');
    const fd = openSync(procPath(dirfd, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) refuse('keyed temp is not a new file');
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
      const again = fstatSync(fd);
      if (!again.isFile() || again.nlink !== 1 || again.ino !== st.ino) {
        refuse('keyed temp changed before publish');
      }
    } finally {
      closeSync(fd);
    }
    // rename replaces a directory entry. It does not follow a symlink (or
    // write through a hardlink) that appeared at `name`.
    renameSync(procPath(dirfd, tmp), procPath(dirfd, name));
    tmp = null;
    // The directory inode cannot change under dirfd, but it can be renamed
    // out of dist/ before the publish. Recheck the path we still have open
    // and remove the new name if it no longer sits in the allowed place.
    const pinnedAfter = realpathSync('/proc/self/fd/' + dirfd);
    if (pinnedAfter !== parentReal || !keyedOutputAllowed(join(pinnedAfter, name), root)) {
      try { unlinkSync(procPath(dirfd, name)); } catch { /* already unlinked */ }
      refuse('keyed destination could not be pinned: ' + profilePath);
    }
    const outFd = openSync(procPath(dirfd, name), O_RDONLY | O_NOFOLLOW);
    try {
      const out = fstatSync(outFd);
      if (!out.isFile() || out.nlink !== 1) refuse('keyed output was not published as a new file');
    } finally {
      closeSync(outFd);
    }
    fsyncSync(dirfd);
  } catch (e) {
    if (tmp) {
      try { unlinkSync(procPath(dirfd, tmp)); } catch { /* temp already gone */ }
    }
    if (e && (e.code === 'ELOOP' || e.code === 'ENOTDIR' || e.code === 'EPERM')) {
      if (e.code === 'EPERM') throw e;
      refuse('keyed destination could not be pinned: ' + profilePath);
    }
    throw e;
  } finally {
    try { closeSync(dirfd); } catch { /* closed on the failure path above */ }
  }
}
