import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import type {
  Branch,
  ChangedFile,
  Commit,
  CommitDetailData,
  CommitRef,
  FileStatus,
  FileStatusKind,
  RepoInfo,
  Stash,
  Tag,
  WorkingTreeStatus,
} from '../shared/types.js';
import { OperationLock } from './operationLock.js';

const FS = '\x1f'; // field separator
const RS = '\x1e'; // record separator

// One field per `%x1f`, one commit per `%x1e`.
// Layout: hash|parents|refs|authorName|authorEmail|authorTime|subject|bodyRECORD
const LOG_FORMAT = `%H${FS}%P${FS}%D${FS}%an${FS}%ae${FS}%at${FS}%s${FS}%b${RS}`;

function isGitRepo(path: string): boolean {
  try {
    const dotGit = join(path, '.git');
    return existsSync(dotGit) && (statSync(dotGit).isDirectory() || statSync(dotGit).isFile());
  } catch {
    return false;
  }
}

function shortHash(h: string): string {
  return h.slice(0, 7);
}

// Parse the colon-separated decoration list from `%D`, e.g.
// "HEAD -> main, origin/main, tag: v1.0".
function parseRefs(decoration: string): CommitRef[] {
  if (!decoration) return [];
  const parts = decoration
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const out: CommitRef[] = [];
  for (const raw of parts) {
    if (raw.startsWith('HEAD -> ')) {
      const branch = raw.slice('HEAD -> '.length).trim();
      out.push({ name: 'HEAD', type: 'head' });
      out.push({ name: branch, type: 'branch' });
    } else if (raw === 'HEAD') {
      out.push({ name: 'HEAD', type: 'head' });
    } else if (raw.startsWith('tag: ')) {
      out.push({ name: raw.slice('tag: '.length).trim(), type: 'tag' });
    } else if (raw.includes('/')) {
      out.push({ name: raw, type: 'remote' });
    } else {
      out.push({ name: raw, type: 'branch' });
    }
  }
  return out;
}

function porcelainStatusToKind(code: string, isWorktree: boolean): FileStatusKind {
  // status codes per `git status --porcelain` man page
  if (code === '?') return 'untracked';
  if (code === 'U' || code === 'A' || code === 'D') {
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    if (code === 'U') return 'conflicted';
  }
  if (code === 'M') return 'modified';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === ' ') return isWorktree ? 'modified' : 'modified';
  return 'modified';
}

// Split a unified diff blob into per-file segments keyed by the file path.
// Each segment retains its `diff --git ...` header line so it renders on its own.
function splitUnifiedDiff(diffText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diffText.trim()) return out;
  const lines = diffText.split('\n');
  let currentPath: string | null = null;
  let currentBuf: string[] = [];
  const flush = (): void => {
    if (currentPath && currentBuf.length) {
      out.set(currentPath, currentBuf.join('\n'));
    }
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentBuf = [line];
      // Try `diff --git a/<path> b/<path>` first; fall back to last quoted path.
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        currentPath = m[2];
      } else {
        const parts = line.split(' ');
        currentPath = parts[parts.length - 1].replace(/^b\//, '');
      }
    } else if (currentPath !== null) {
      currentBuf.push(line);
    }
  }
  flush();
  return out;
}

interface ServiceOptions {
  onInternalOp?: () => void;
}

export class GitService {
  private git: SimpleGit;
  private lock = new OperationLock();

  constructor(
    public repoPath: string,
    private opts: ServiceOptions = {},
  ) {
    if (!isGitRepo(repoPath)) {
      throw new Error(`Not a Git repository: ${repoPath}`);
    }
    this.git = simpleGit(repoPath);
  }

  isBusy(): boolean {
    return this.lock.isBusy();
  }

  // ---------------------------------------------------------------------------
  // Read APIs (no lock; simple-git serializes its own child processes already)
  // ---------------------------------------------------------------------------

  async getRepoInfo(): Promise<RepoInfo> {
    const headRef = (await this.git.raw(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    const detached = headRef === '';
    const inMerge = existsSync(join(this.repoPath, '.git', 'MERGE_HEAD'));
    const inRebase =
      existsSync(join(this.repoPath, '.git', 'rebase-merge')) ||
      existsSync(join(this.repoPath, '.git', 'rebase-apply'));
    return {
      path: this.repoPath,
      currentBranchName: detached ? '' : headRef,
      detachedHead: detached,
      inMerge,
      inRebase,
    };
  }

  async getBranches(): Promise<Branch[]> {
    const headRef = (await this.git.raw(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    // Local branches with upstream + ahead/behind
    const localFmt = `%(refname:short)${FS}%(refname)${FS}%(objectname)${FS}%(upstream:short)${FS}%(upstream:track)`;
    const localOut = await this.git.raw([
      'for-each-ref',
      `--format=${localFmt}`,
      'refs/heads',
    ]);
    const remoteFmt = `%(refname:short)${FS}%(refname)${FS}%(objectname)`;
    const remoteOut = await this.git.raw([
      'for-each-ref',
      `--format=${remoteFmt}`,
      'refs/remotes',
    ]);

    const branches: Branch[] = [];

    for (const line of localOut.split('\n').filter(Boolean)) {
      const [name, fullName, sha, upstream, track] = line.split(FS);
      let ahead = 0;
      let behind = 0;
      if (track) {
        // `[ahead 1, behind 2]` / `[ahead 1]` / `[behind 2]` / `[gone]`
        const a = track.match(/ahead (\d+)/);
        const b = track.match(/behind (\d+)/);
        if (a) ahead = parseInt(a[1], 10);
        if (b) behind = parseInt(b[1], 10);
      }
      branches.push({
        name,
        fullName,
        isRemote: false,
        isHEAD: name === headRef,
        lastCommitHash: sha,
        upstreamName: upstream || null,
        ahead,
        behind,
      });
    }
    for (const line of remoteOut.split('\n').filter(Boolean)) {
      const [name, fullName, sha] = line.split(FS);
      // skip refs/remotes/<remote>/HEAD aliases
      if (name.endsWith('/HEAD')) continue;
      branches.push({
        name,
        fullName,
        isRemote: true,
        isHEAD: false,
        lastCommitHash: sha,
        upstreamName: null,
        ahead: 0,
        behind: 0,
      });
    }
    return branches;
  }

  async getTags(): Promise<Tag[]> {
    const fmt = `%(refname:short)${FS}%(objectname)`;
    const out = await this.git.raw(['for-each-ref', `--format=${fmt}`, 'refs/tags']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, hash] = line.split(FS);
        return { name, commitHash: hash };
      });
  }

  async getStashes(): Promise<Stash[]> {
    const fmt = `%gd${FS}%gs`;
    let out = '';
    try {
      out = await this.git.raw(['stash', 'list', `--format=${fmt}`]);
    } catch {
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, msg] = line.split(FS);
        // ref format: stash@{N}
        const m = ref.match(/stash@\{(\d+)\}/);
        const index = m ? parseInt(m[1], 10) : 0;
        // msg format: "WIP on branch: ..." or "On branch: msg"
        const branchMatch = msg.match(/^(?:WIP on |On )([^:]+):/);
        const branchName = branchMatch ? branchMatch[1] : '';
        return { index, message: msg, branchName };
      });
  }

  async getCommitCount(): Promise<number> {
    const out = (await this.git.raw(['rev-list', '--all', '--count'])).trim();
    return parseInt(out, 10) || 0;
  }

  async getCommitsRange(skip: number, limit: number): Promise<Commit[]> {
    const args = [
      'log',
      '--all',
      '--topo-order',
      '--date-order',
      `--format=${LOG_FORMAT}`,
      `--skip=${skip}`,
      `--max-count=${limit}`,
    ];
    const out = await this.git.raw(args);
    return this.parseCommits(out);
  }

  async searchCommits(query: string): Promise<string[]> {
    const q = query.trim();
    if (!q) return [];
    const args = [
      'log',
      '--all',
      '-i',
      `--grep=${q}`,
      '--format=%H',
      '--max-count=200',
    ];
    const out = await this.git.raw(args);
    return out.split('\n').filter(Boolean);
  }

  private parseCommits(raw: string): Commit[] {
    const commits: Commit[] = [];
    const records = raw.split(RS);
    for (const rec of records) {
      const trimmed = rec.replace(/^\n/, '');
      if (!trimmed) continue;
      const fields = trimmed.split(FS);
      if (fields.length < 8) continue;
      const [hash, parents, refs, an, ae, at, subject, body] = fields;
      const parentHashes = parents ? parents.split(' ').filter(Boolean) : [];
      const message = body && body.trim() ? `${subject}\n\n${body.trim()}` : subject;
      commits.push({
        hash,
        shortHash: shortHash(hash),
        parentHashes,
        refs: parseRefs(refs),
        authorName: an,
        authorEmail: ae,
        timestamp: parseInt(at, 10) * 1000,
        message,
        isMerge: parentHashes.length > 1,
      });
    }
    return commits;
  }

  async getCommitDetail(hash: string): Promise<CommitDetailData> {
    const metaFormat = `%H${FS}%h${FS}%an${FS}%ae${FS}%cn${FS}%ce${FS}%at${FS}%P${FS}%B`;
    const meta = await this.git.raw([
      'show',
      '--no-patch',
      `--format=${metaFormat}`,
      hash,
    ]);
    const fields = meta.replace(/\n$/, '').split(FS);
    const [h, sh, an, ae, cn, ce, at, parents, ...rest] = fields;
    const message = rest.join(FS); // %B may contain FS? Extremely unlikely; safe rejoin.

    const parentList = parents ? parents.split(' ').filter(Boolean) : [];
    const isMerge = parentList.length > 1;

    // For merge commits `git show --name-status` is empty by default, so we
    // diff against the first parent instead. For root commits there's nothing
    // to diff so we fall back to listing the tree.
    let numstatOut: string;
    let namestatusOut: string;
    let fullDiff: string;
    if (isMerge) {
      const baseRange = `${parentList[0]}..${hash}`;
      numstatOut = await this.git.raw(['diff', '--numstat', baseRange]);
      namestatusOut = await this.git.raw(['diff', '--name-status', baseRange]);
      fullDiff = await this.git.raw(['diff', baseRange]);
    } else if (parentList.length === 0) {
      numstatOut = await this.git.raw(['show', '--format=', '--numstat', hash]);
      namestatusOut = await this.git.raw(['show', '--format=', '--name-status', hash]);
      fullDiff = await this.git.raw(['show', '--format=', hash]);
    } else {
      numstatOut = await this.git.raw(['show', '--format=', '--numstat', hash]);
      namestatusOut = await this.git.raw(['show', '--format=', '--name-status', hash]);
      fullDiff = await this.git.raw(['show', '--format=', hash]);
    }
    const diffByFile = splitUnifiedDiff(fullDiff);

    // Build map: path -> { adds, dels }
    const stats = new Map<string, { add: number; del: number }>();
    for (const line of numstatOut.split('\n').filter(Boolean)) {
      const [a, d, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      const adds = a === '-' ? 0 : parseInt(a, 10) || 0;
      const dels = d === '-' ? 0 : parseInt(d, 10) || 0;
      stats.set(path, { add: adds, del: dels });
    }

    const changedFiles: ChangedFile[] = [];
    for (const line of namestatusOut.split('\n').filter(Boolean)) {
      // Formats: "M\tfile" or "R100\told\tnew" or "A\tfile" etc.
      const parts = line.split('\t');
      const code = parts[0];
      let path: string;
      let oldPath: string | undefined;
      let status: FileStatusKind;
      if (code.startsWith('R')) {
        oldPath = parts[1];
        path = parts[2];
        status = 'renamed';
      } else if (code.startsWith('C')) {
        oldPath = parts[1];
        path = parts[2];
        status = 'copied';
      } else {
        path = parts[1];
        switch (code[0]) {
          case 'A':
            status = 'added';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'M':
            status = 'modified';
            break;
          case 'U':
            status = 'conflicted';
            break;
          default:
            status = 'modified';
        }
      }
      const stat = stats.get(path) ?? { add: 0, del: 0 };
      const diff = diffByFile.get(path) ?? '';
      changedFiles.push({
        path,
        oldPath,
        status,
        additions: stat.add,
        deletions: stat.del,
        diff,
      });
    }

    return {
      hash: h,
      shortHash: sh,
      authorName: an,
      authorEmail: ae,
      committerName: cn,
      committerEmail: ce,
      timestamp: parseInt(at, 10) * 1000,
      message: message.trim(),
      parentHashes: parentList,
      changedFiles,
    };
  }

  async getWorkingTreeStatus(): Promise<WorkingTreeStatus> {
    const status = await this.git.status();
    const unstaged: FileStatus[] = [];
    const staged: FileStatus[] = [];
    const conflicted: FileStatus[] = [];

    for (const f of status.files) {
      const indexCode = f.index ?? ' ';
      const wtCode = f.working_dir ?? ' ';
      const path = f.path;

      // Conflicted files appear in `status.conflicted`; surface them separately
      // even though they may also show up in the regular files list.
      if (
        indexCode === 'U' ||
        wtCode === 'U' ||
        (indexCode === 'A' && wtCode === 'A') ||
        (indexCode === 'D' && wtCode === 'D')
      ) {
        conflicted.push({
          path,
          status: 'conflicted',
          staged: false,
        });
        continue;
      }

      if (indexCode !== ' ' && indexCode !== '?') {
        staged.push({
          path,
          status: porcelainStatusToKind(indexCode, false),
          staged: true,
        });
      }
      if (wtCode !== ' ') {
        unstaged.push({
          path,
          status: porcelainStatusToKind(wtCode === '?' ? '?' : wtCode, true),
          staged: false,
        });
      }
    }

    const inMerge = existsSync(join(this.repoPath, '.git', 'MERGE_HEAD'));
    const inRebase =
      existsSync(join(this.repoPath, '.git', 'rebase-merge')) ||
      existsSync(join(this.repoPath, '.git', 'rebase-apply'));

    return {
      unstaged,
      staged,
      conflicted,
      hasUnpushed: status.ahead > 0,
      inMerge,
      inRebase,
    };
  }

  // ---------------------------------------------------------------------------
  // Mutations: routed through the operation lock so they stay serial.
  // ---------------------------------------------------------------------------

  private async mutate<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.run(name, async () => {
      try {
        return await fn();
      } finally {
        this.opts.onInternalOp?.();
      }
    });
  }

  checkout(branch: string): Promise<void> {
    return this.mutate('checkout', async () => {
      await this.git.checkout(branch);
    });
  }

  async merge(source: string): Promise<{ ok: boolean; conflicts?: string[] }> {
    return this.mutate('merge', async () => {
      try {
        await this.git.merge([source]);
        return { ok: true };
      } catch (e: any) {
        const status = await this.git.status();
        if (status.conflicted.length > 0) {
          return { ok: false, conflicts: status.conflicted };
        }
        throw e;
      }
    });
  }

  async rebase(target: string): Promise<{ ok: boolean; conflicts?: string[] }> {
    return this.mutate('rebase', async () => {
      try {
        await this.git.rebase([target]);
        return { ok: true };
      } catch (e: any) {
        const status = await this.git.status();
        if (status.conflicted.length > 0) {
          return { ok: false, conflicts: status.conflicted };
        }
        throw e;
      }
    });
  }

  deleteBranch(name: string, force = false): Promise<void> {
    return this.mutate('deleteBranch', async () => {
      await this.git.raw(['branch', force ? '-D' : '-d', name]);
    });
  }

  stageFile(path: string): Promise<void> {
    return this.mutate('stage', async () => {
      await this.git.add([path]);
    });
  }

  stageAll(): Promise<void> {
    return this.mutate('stageAll', async () => {
      await this.git.raw(['add', '-A']);
    });
  }

  unstageFile(path: string): Promise<void> {
    return this.mutate('unstage', async () => {
      await this.git.raw(['reset', 'HEAD', '--', path]);
    });
  }

  unstageAll(): Promise<void> {
    return this.mutate('unstageAll', async () => {
      await this.git.raw(['reset', 'HEAD']);
    });
  }

  discardFile(path: string): Promise<void> {
    return this.mutate('discard', async () => {
      // Untracked files won't be removed by `checkout --`; clean them explicitly.
      const status = await this.git.status();
      const f = status.files.find((x) => x.path === path);
      if (f && f.index === '?' && f.working_dir === '?') {
        await this.git.raw(['clean', '-f', '--', path]);
      } else {
        await this.git.raw(['checkout', '--', path]);
      }
    });
  }

  discardAllUnstaged(): Promise<void> {
    return this.mutate('discardAllUnstaged', async () => {
      await this.git.raw(['checkout', '--', '.']);
      await this.git.raw(['clean', '-fd']);
    });
  }

  commit(message: string): Promise<void> {
    return this.mutate('commit', async () => {
      await this.git.commit(message);
    });
  }

  push(branch?: string): Promise<void> {
    return this.mutate('push', async () => {
      if (branch) {
        await this.git.push('origin', branch);
      } else {
        await this.git.push();
      }
    });
  }

  pull(branch?: string): Promise<void> {
    return this.mutate('pull', async () => {
      if (branch) {
        await this.git.pull('origin', branch);
      } else {
        await this.git.pull();
      }
    });
  }

  stashSave(message?: string): Promise<void> {
    return this.mutate('stashSave', async () => {
      const args = ['stash', 'push'];
      if (message) args.push('-m', message);
      await this.git.raw(args);
    });
  }

  stashApply(index: number): Promise<void> {
    return this.mutate('stashApply', async () => {
      await this.git.raw(['stash', 'apply', `stash@{${index}}`]);
    });
  }

  stashPop(index: number): Promise<void> {
    return this.mutate('stashPop', async () => {
      await this.git.raw(['stash', 'pop', `stash@{${index}}`]);
    });
  }

  stashDrop(index: number): Promise<void> {
    return this.mutate('stashDrop', async () => {
      await this.git.raw(['stash', 'drop', `stash@{${index}}`]);
    });
  }

  markConflictResolved(path: string): Promise<void> {
    return this.mutate('markResolved', async () => {
      await this.git.add([path]);
    });
  }

  commitMerge(): Promise<void> {
    return this.mutate('commitMerge', async () => {
      await this.git.raw(['commit', '--no-edit']);
    });
  }

  abortMerge(): Promise<void> {
    return this.mutate('abortMerge', async () => {
      await this.git.raw(['merge', '--abort']);
    });
  }
}
