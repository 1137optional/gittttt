import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// =============================================================================
// On-disk store of recently-opened repository paths.
//
// Why a server-side store instead of just trusting the client's openTabs
// localStorage:
//   - the user can clear browser data without losing their repo history
//   - the same backend can serve multiple browser sessions / devices
//   - matches the existing tokenStore pattern (single tiny JSON file under
//     ~/.gittttt/, no DB)
//
// Format: a JSON array of `{ path, lastOpenedAt }` sorted by `lastOpenedAt`
// descending. Capped at 50 entries — anything older drops off; the user can
// still re-open via the folder browser.
//
// Override the file with $GITTTTT_RECENT_FILE.
// =============================================================================

const RECENT_PATH = process.env.GITTTTT_RECENT_FILE
  ? process.env.GITTTTT_RECENT_FILE
  : join(homedir(), '.gittttt', 'recent-repos.json');

const MAX_ENTRIES = 50;

export interface RecentRepoEntry {
  path: string;
  lastOpenedAt: number;
}

export function readRecentRepos(): RecentRepoEntry[] {
  try {
    if (!existsSync(RECENT_PATH)) return [];
    const raw = readFileSync(RECENT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Defensive: filter out malformed entries rather than throwing — a
    // corrupt history file should never block the picker.
    return parsed.flatMap((e): RecentRepoEntry[] => {
      if (
        e &&
        typeof e === 'object' &&
        typeof (e as RecentRepoEntry).path === 'string' &&
        typeof (e as RecentRepoEntry).lastOpenedAt === 'number'
      ) {
        return [{ path: (e as RecentRepoEntry).path, lastOpenedAt: (e as RecentRepoEntry).lastOpenedAt }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

// Bump the entry for `path` to "now" (or insert if missing), drop excess
// entries at the tail, write back. Failures are swallowed — the recent
// list is convenience, never block the actual repo open on it.
export function recordRecentRepo(path: string): void {
  try {
    const now = Date.now();
    const existing = readRecentRepos().filter((e) => e.path !== path);
    const next: RecentRepoEntry[] = [{ path, lastOpenedAt: now }, ...existing].slice(
      0,
      MAX_ENTRIES,
    );
    const dir = dirname(RECENT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(RECENT_PATH, JSON.stringify(next, null, 2), { encoding: 'utf8' });
  } catch {
    /* best-effort */
  }
}
