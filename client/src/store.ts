import { create } from 'zustand';
import type {
  Branch,
  Commit,
  CommitDetailData,
  RepoInfo,
  Stash,
  Tag,
  WorkingTreeStatus,
} from '@shared/types';
import { api } from './api';

const PAGE_SIZE = 300;

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

interface AppState {
  // repo
  repoOpen: boolean;
  repo: RepoInfo | null;

  // git data
  branches: Branch[];
  tags: Tag[];
  stashes: Stash[];
  commits: Commit[];
  totalCommitCount: number;
  status: WorkingTreeStatus | null;

  // selection / UI
  selectedCommitHash: string | null;
  commitDetail: CommitDetailData | null;
  searchQuery: string;
  highlightedHashes: Set<string>;

  // ui state
  isLoading: boolean;        // global blocker for pull/push/sync
  loadingMore: boolean;       // commit pagination in flight
  toasts: Toast[];
  bottomTab: 'detail' | 'changes';
  setBottomTab(tab: 'detail' | 'changes'): void;

  // actions
  init(): Promise<void>;
  refreshAll(): Promise<void>;
  openRepo(path: string): Promise<void>;

  loadMoreCommits(): Promise<void>;
  selectCommit(hash: string | null): Promise<void>;
  setSearchQuery(q: string): Promise<void>;

  pull(): Promise<void>;
  push(): Promise<void>;
  sync(): Promise<void>;

  checkout(branch: string): Promise<void>;
  merge(target: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  rebase(target: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  cherryPick(hash: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  revert(hash: string): Promise<{ ok: boolean; conflicts?: string[] }>;
  deleteBranch(name: string): Promise<void>;
  createBranch(name: string, opts?: { from?: string; checkout?: boolean }): Promise<void>;

  stageFiles(files: string[]): Promise<void>;
  unstageFiles(files: string[]): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  discardFiles(files: string[]): Promise<void>;
  commit(message: string): Promise<void>;

  stash(action: 'save' | 'apply' | 'pop' | 'drop', extra?: { index?: number; message?: string }): Promise<void>;

  pushToast(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;
}

let nextToastId = 1;

// Pretty-print a ref string for toast messages. Hashes (40-char hex) are
// shortened to 7 chars; branch / tag names are left alone.
function friendlyRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

export const useApp = create<AppState>((set, get) => {
  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------
  const wrap = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      get().pushToast('error', msg);
      return undefined;
    }
  };

  const reloadCore = async (): Promise<void> => {
    const repo = await api.getRepo();
    if (!repo.open) {
      set({ repoOpen: false, repo: null });
      return;
    }
    const [branches, tags, stashes, status, count, commits] = await Promise.all([
      api.getBranches(),
      api.getTags(),
      api.getStashes(),
      api.getStatus(),
      api.getCommitCount(),
      api.getCommitsRange(0, PAGE_SIZE),
    ]);
    set({
      repoOpen: true,
      repo: {
        path: repo.path!,
        currentBranchName: repo.currentBranchName!,
        detachedHead: !!repo.detachedHead,
        inMerge: !!repo.inMerge,
        inRebase: !!repo.inRebase,
      },
      branches,
      tags,
      stashes,
      status,
      totalCommitCount: count.count,
      commits,
    });
    // Refresh detail for the currently selected commit if it's still around.
    const selected = get().selectedCommitHash;
    if (selected) {
      try {
        const detail = await api.getCommitDetail(selected);
        set({ commitDetail: detail });
      } catch {
        set({ commitDetail: null, selectedCommitHash: null });
      }
    }
  };

  return {
    repoOpen: false,
    repo: null,
    branches: [],
    tags: [],
    stashes: [],
    commits: [],
    totalCommitCount: 0,
    status: null,
    selectedCommitHash: null,
    commitDetail: null,
    searchQuery: '',
    highlightedHashes: new Set<string>(),
    isLoading: false,
    loadingMore: false,
    toasts: [],
    bottomTab: 'changes',
    setBottomTab(tab) {
      set({ bottomTab: tab });
    },

    async init() {
      await wrap(reloadCore);
    },

    async refreshAll() {
      await wrap(reloadCore);
    },

    async openRepo(path) {
      await wrap(async () => {
        await api.openRepo(path);
        await reloadCore();
        get().pushToast('success', `Opened repository at ${path}`);
      });
    },

    async loadMoreCommits() {
      const { commits, totalCommitCount, loadingMore } = get();
      if (loadingMore) return;
      if (commits.length >= totalCommitCount) return;
      set({ loadingMore: true });
      try {
        const next = await api.getCommitsRange(commits.length, PAGE_SIZE);
        // Dedup defensively in case server overlaps.
        const seen = new Set(commits.map((c) => c.hash));
        const merged = commits.concat(next.filter((c) => !seen.has(c.hash)));
        set({ commits: merged });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        get().pushToast('error', msg);
      } finally {
        set({ loadingMore: false });
      }
    },

    async selectCommit(hash) {
      // Clicking a commit also flips the bottom panel to the detail tab
      // — that's where the new info should land.
      set({ selectedCommitHash: hash, commitDetail: null, bottomTab: hash ? 'detail' : get().bottomTab });
      if (!hash) return;
      await wrap(async () => {
        const detail = await api.getCommitDetail(hash);
        if (get().selectedCommitHash === hash) set({ commitDetail: detail });
      });
    },

    async setSearchQuery(q) {
      set({ searchQuery: q });
      if (!q.trim()) {
        set({ highlightedHashes: new Set() });
        return;
      }
      await wrap(async () => {
        const hashes = await api.searchCommits(q);
        set({ highlightedHashes: new Set(hashes) });
      });
    },

    async pull() {
      set({ isLoading: true });
      const branch = get().repo?.currentBranchName;
      const ok = await wrap(async () => {
        await api.pull(branch);
        return true;
      });
      set({ isLoading: false });
      if (ok) get().pushToast('success', 'Pulled successfully');
      await get().refreshAll();
    },

    async push() {
      set({ isLoading: true });
      const branch = get().repo?.currentBranchName;
      const ok = await wrap(async () => {
        await api.push(branch);
        return true;
      });
      set({ isLoading: false });
      if (ok) get().pushToast('success', 'Pushed successfully');
      await get().refreshAll();
    },

    async sync() {
      set({ isLoading: true });
      const branch = get().repo?.currentBranchName;
      const pulled = await wrap(async () => {
        await api.pull(branch);
        return true;
      });
      if (pulled) {
        await wrap(async () => {
          await api.push(branch);
          get().pushToast('success', 'Synced successfully');
        });
      }
      set({ isLoading: false });
      await get().refreshAll();
    },

    async checkout(branch) {
      const ok = await wrap(async () => {
        await api.checkout(branch);
        return true;
      });
      if (ok) {
        get().pushToast('success', `Checked out ${branch}`);
        await get().refreshAll();
      }
    },

    async merge(target) {
      const result = await wrap(async () => {
        const r = await api.merge(target);
        const label = friendlyRef(target);
        if (r.ok) get().pushToast('success', `Merged ${label}`);
        else
          get().pushToast(
            'warn',
            `Merge conflicts in ${r.conflicts?.length ?? 0} file(s)`,
          );
        return r;
      });
      await get().refreshAll();
      return result ?? { ok: false };
    },

    async rebase(target) {
      const result = await wrap(async () => {
        const r = await api.rebase(target);
        const label = friendlyRef(target);
        if (r.ok) get().pushToast('success', `Rebased onto ${label}`);
        else
          get().pushToast(
            'warn',
            `Rebase conflicts in ${r.conflicts?.length ?? 0} file(s)`,
          );
        return r;
      });
      await get().refreshAll();
      return result ?? { ok: false };
    },

    async cherryPick(hash) {
      const result = await wrap(async () => {
        const r = await api.cherryPick(hash);
        const label = friendlyRef(hash);
        if (r.ok) get().pushToast('success', `Cherry-picked ${label}`);
        else
          get().pushToast(
            'warn',
            `Cherry-pick conflicts in ${r.conflicts?.length ?? 0} file(s)`,
          );
        return r;
      });
      await get().refreshAll();
      return result ?? { ok: false };
    },

    async revert(hash) {
      const result = await wrap(async () => {
        const r = await api.revert(hash);
        const label = friendlyRef(hash);
        if (r.ok) get().pushToast('success', `Reverted ${label}`);
        else
          get().pushToast(
            'warn',
            `Revert conflicts in ${r.conflicts?.length ?? 0} file(s)`,
          );
        return r;
      });
      await get().refreshAll();
      return result ?? { ok: false };
    },

    async deleteBranch(name) {
      const ok = await wrap(async () => {
        await api.deleteBranch(name);
        return true;
      });
      if (ok) {
        get().pushToast('success', `Deleted branch ${name}`);
        await get().refreshAll();
      }
    },

    async createBranch(name, opts = {}) {
      const ok = await wrap(async () => {
        await api.createBranch(name, opts);
        return true;
      });
      if (ok) {
        get().pushToast('success', `Created branch ${name}`);
        await get().refreshAll();
      }
    },

    async stageFiles(files) {
      await wrap(() => api.stage(files));
      await get().refreshAll();
    },
    async unstageFiles(files) {
      await wrap(() => api.unstage(files));
      await get().refreshAll();
    },
    async stageAll() {
      await wrap(() => api.stageAll());
      await get().refreshAll();
    },
    async unstageAll() {
      await wrap(() => api.unstageAll());
      await get().refreshAll();
    },
    async discardFiles(files) {
      await wrap(() => api.discard(files));
      await get().refreshAll();
    },

    async commit(message) {
      const ok = await wrap(async () => {
        await api.commit(message);
        return true;
      });
      if (ok) {
        get().pushToast('success', 'Commit created');
        await get().refreshAll();
      }
    },

    async stash(action, extra) {
      const ok = await wrap(async () => {
        await api.stash(action, extra);
        return true;
      });
      if (ok) {
        get().pushToast('success', `Stash ${action} ok`);
        await get().refreshAll();
      }
    },

    pushToast(kind, message) {
      const id = nextToastId++;
      set({ toasts: [...get().toasts, { id, kind, message }] });
      const ttl = kind === 'error' ? 6000 : 3000;
      setTimeout(() => get().dismissToast(id), ttl);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
