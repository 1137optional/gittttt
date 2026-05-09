import chokidar, { FSWatcher } from 'chokidar';
import { join } from 'node:path';

// Watches a Git repository's `.git` directory plus the working tree
// and notifies listeners when something relevant changed. Events that
// occur inside the suppression window after a known internal Git operation
// are dropped to avoid double-refreshes.
export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastInternalOp = 0;

  private static SUPPRESS_WINDOW_MS = 1500;
  private static DEBOUNCE_MS = 300;

  constructor(
    private repoPath: string,
    private onChange: () => void,
  ) {}

  start(): void {
    this.watcher?.close();
    const gitDir = join(this.repoPath, '.git');
    this.watcher = chokidar.watch([gitDir, this.repoPath], {
      ignored: [
        /node_modules/,
        /(^|[\\/])\.DS_Store$/,
        /\.git[\\/](index\.lock|HEAD\.lock|FETCH_HEAD\.lock|ORIG_HEAD\.lock)$/,
      ],
      ignoreInitial: true,
      persistent: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on('all', () => this.handleEvent());
  }

  markInternalOp(): void {
    this.lastInternalOp = Date.now();
  }

  private handleEvent(): void {
    if (Date.now() - this.lastInternalOp < RepoWatcher.SUPPRESS_WINDOW_MS) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.onChange(), RepoWatcher.DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}
