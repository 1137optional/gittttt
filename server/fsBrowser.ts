import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FsBrowseResult, FsEntry } from '../shared/types.js';

// =============================================================================
// Local filesystem browser used by the in-app folder picker.
//
// We list ONLY directories (the picker doesn't care about loose files), tag
// each one with `isGitRepo`, and keep `.git`-marked rows on top so the user
// lands on the relevant ones. Hidden dirs are filtered out by default —
// `~/.config` etc. is rarely what someone wants to open as a project.
// =============================================================================

interface BrowseOpts {
  showHidden?: boolean;
}

export function browseDirectory(input: string | undefined, opts: BrowseOpts = {}): FsBrowseResult {
  const requested = input?.trim() || homedir();
  // Resolve and reject anything that escapes via symlinks pointing nowhere.
  const dir = resolve(requested);
  if (!existsSync(dir)) throw new Error(`Path does not exist: ${dir}`);
  let stat;
  try {
    stat = statSync(dir);
  } catch (e) {
    throw new Error(`Cannot stat path: ${dir} — ${(e as Error).message}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dir}`);

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new Error(`Cannot read directory: ${dir} — ${(e as Error).message}`);
  }

  const entries: FsEntry[] = [];
  for (const name of names) {
    const hidden = name.startsWith('.');
    if (hidden && !opts.showHidden) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      // Permission denied / dangling symlink / race with another process —
      // just skip it rather than 500-ing the whole listing.
      continue;
    }
    if (!isDir) continue;
    entries.push({
      name,
      path: full,
      isGitRepo: existsSync(join(full, '.git')),
      hidden,
    });
  }

  entries.sort((a, b) => {
    // Surface git repos first regardless of alphabet — they are by far the
    // most likely target of this picker.
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const parent = dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    isGitRepo: existsSync(join(dir, '.git')),
    entries,
  };
}

export function homeDir(): string {
  return homedir();
}
