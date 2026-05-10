import { create } from 'zustand';
import type {
  Branch,
  Commit,
  RepoInfo,
  Stash,
  Tag,
  WorkingTreeStatus,
} from '@shared/types';
import { api } from './api';

const PAGE_SIZE = 300;
const TABS_STORAGE_KEY = 'gittttt:tabs';
const MODE_STORAGE_KEY = 'gittttt:mode';

export type AppMode = 'debug' | 'graph';

function readPersistedMode(): AppMode {
  if (typeof localStorage === 'undefined') return 'debug';
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    if (v === 'debug' || v === 'graph') return v;
  } catch {
    /* fall through to default */
  }
  // Spec default: cold-start lands in debug. The user can flip to graph mode
  // and that choice will be remembered for the next session.
  return 'debug';
}

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  count: number;
}

export interface RepoTab {
  path: string;
  name: string;
}

// Tabs are persisted as a tiny `Array<{path,name}>` blob so the strip
// survives a page reload. We never store anything sensitive — paths only.
function readPersistedTabs(): RepoTab[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is RepoTab =>
          !!t &&
          typeof (t as RepoTab).path === 'string' &&
          typeof (t as RepoTab).name === 'string',
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistTabs(tabs: RepoTab[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    /* swallow — storage being full shouldn't break the app */
  }
}

function repoBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
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
  // Which page is shown in the LEFT sidebar.
  //   'branches' — the existing tree (branches / remotes / stash)
  //   'docs'     — Markdown-style doc page explaining the right-click menu
  leftPage: 'branches' | 'docs' | 'memory' | 'vault';
  setLeftPage(page: 'branches' | 'docs' | 'memory' | 'vault'): void;
  /** When true, render the RepoPicker as a full-screen overlay even though
   *  a repo is already attached (so the user can switch / clone / create). */
  showRepoPicker: boolean;
  setShowRepoPicker(v: boolean): void;
  /** Browser-style tab strip in the topnav: every repo the user has opened
   *  during this session (or in a previous session, restored from
   *  localStorage). Order is creation order; the active tab is whichever
   *  matches the currently attached repo path. */
  openTabs: RepoTab[];
  closeTab(path: string): Promise<void>;
  /** Active visual theme. The flag is mirrored to <html data-theme=…> and
   *  persisted in localStorage; default follows the OS preference. */
  theme: 'light' | 'dark';
  setTheme(theme: 'light' | 'dark'): void;
  toggleTheme(): void;
  /** Top-level workspace mode. 'debug' is the embedded-browser + log + AI
   *  panel; 'graph' is the original Git visualisation view. The mode toggle
   *  in TopNav cycles between the two and persists to localStorage. */
  currentMode: AppMode;
  setCurrentMode(mode: AppMode): void;
  toggleMode(): void;

  // ui state
  isLoading: boolean;        // global blocker for pull/push/sync
  loadingMore: boolean;       // commit pagination in flight
  toasts: Toast[];

  // actions
  init(): Promise<void>;
  refreshAll(): Promise<void>;
  openRepo(path: string): Promise<void>;

  loadMoreCommits(): Promise<void>;
  selectCommit(hash: string | null): Promise<void>;

  pull(): Promise<void>;
  push(): Promise<void>;
  /** Push the current local branch to `remoteRef` on origin (`git push origin current:remoteRef`). */
  pushTo(remoteRef: string): Promise<void>;
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
// Tracks pending dismissal timers so duplicate-toast pushes can reset the
// TTL (and dismissals can clear the timer to avoid late-firing dismisses).
const toastTimers = new Map<number, number>();

const THEME_KEY = 'gittttt:theme';

function readInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage may be blocked (private mode, sandbox); fall through.
  }
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function applyTheme(theme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore — theme just won't persist across reloads
  }
}

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

  // SSE-driven refreshes can fire in bursts (e.g. an editor saves several
  // files in <300ms — the server debounces, but rapid sequential bursts
  // still arrive). We coalesce overlapping reloads here: if a refresh is
  // already in flight, callers receive the SAME promise instead of
  // queueing a fresh round of 6 git calls. A pending "another refresh
  // requested while the current one was running" turns into exactly one
  // follow-up reload after the current one settles.
  let inflightReload: Promise<void> | null = null;
  let pendingReload = false;
  const dedupedReload = async (): Promise<void> => {
    if (inflightReload) {
      pendingReload = true;
      return inflightReload;
    }
    inflightReload = (async () => {
      try {
        await reloadCore();
      } finally {
        const wasPending = pendingReload;
        pendingReload = false;
        inflightReload = null;
        if (wasPending) {
          // One trailing reload to capture any state that mutated after
          // we snapshotted but before we finished — without unbounded
          // recursion, since the inner call resets `inflightReload` first.
          await dedupedReload();
        }
      }
    })();
    return inflightReload;
  };

  const reloadCore = async (): Promise<void> => {
    const previousPath = get().repo?.path ?? null;
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
    // Make sure the active repo always has a tab — if the server attached a
    // repo we don't yet know about (cold start, switched via picker, etc.),
    // append it. We never demote the active tab; closing it is an explicit
    // user action handled in `closeTab`.
    const path = repo.path!;
    let tabs = get().openTabs;
    if (!tabs.some((t) => t.path === path)) {
      tabs = [...tabs, { path, name: repoBasename(path) }];
      persistTabs(tabs);
    }
    set({
      repoOpen: true,
      repo: {
        path,
        currentBranchName: repo.currentBranchName!,
        detachedHead: !!repo.detachedHead,
        inMerge: !!repo.inMerge,
        inRebase: !!repo.inRebase,
      },
      openTabs: tabs,
      branches,
      tags,
      stashes,
      status,
      totalCommitCount: count.count,
      commits,
    });
    // Drop the selected hash if the underlying commit was rewritten / pruned.
    const selected = get().selectedCommitHash;
    if (selected && !commits.some((c) => c.hash === selected)) {
      set({ selectedCommitHash: null });
    }
    // Active repo just changed (clone, create, switch tab, folder pick, …).
    // Dismiss the picker overlay if it's open so the user always lands back
    // in the main view rather than staying on the "destination" page.
    if (previousPath !== path && get().showRepoPicker) {
      set({ showRepoPicker: false });
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
    leftPage: 'branches',
    setLeftPage(page) {
      set({ leftPage: page });
    },
    showRepoPicker: false,
    setShowRepoPicker(v) {
      set({ showRepoPicker: v });
    },
    openTabs: readPersistedTabs(),
    async closeTab(path) {
      const { openTabs, repo } = get();
      const idx = openTabs.findIndex((t) => t.path === path);
      if (idx < 0) return;
      const next = openTabs.filter((t) => t.path !== path);
      // Closing the only tab: keep it (the user really shouldn't end up with
      // zero tabs and a "ghost" attached repo). UI hides × in that case too;
      // this is a belt-and-braces guard.
      if (next.length === 0) return;
      set({ openTabs: next });
      persistTabs(next);
      // Closing the active tab → switch to the neighbour to its left, or to
      // index 0 if we removed the leftmost tab.
      const isActive = repo?.path === path;
      if (isActive) {
        const focus = next[Math.max(0, idx - 1)];
        await wrap(async () => {
          await api.openRepo(focus.path);
          await reloadCore();
        });
      }
    },
    theme: (() => {
      const t = readInitialTheme();
      // Sync the DOM immediately so the first paint already matches the
      // resolved theme (avoids a light → dark flash on cold load).
      applyTheme(t);
      return t;
    })(),
    setTheme(theme) {
      applyTheme(theme);
      set({ theme });
    },
    toggleTheme() {
      const next = get().theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      set({ theme: next });
    },
    currentMode: readPersistedMode(),
    setCurrentMode(mode) {
      try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch {
        /* ignore */
      }
      set({ currentMode: mode });
    },
    toggleMode() {
      const next: AppMode = get().currentMode === 'debug' ? 'graph' : 'debug';
      get().setCurrentMode(next);
    },
    isLoading: false,
    loadingMore: false,
    toasts: [],

    async init() {
      await wrap(dedupedReload);
    },

    async refreshAll() {
      await wrap(dedupedReload);
    },

    async openRepo(path) {
      await wrap(async () => {
        await api.openRepo(path);
        await reloadCore();
        // Always dismiss the picker overlay on success — RepoPicker is a
        // "destination", once you've reached it the user expects to land
        // back in the main view.
        set({ showRepoPicker: false });
        get().pushToast('success', `已打开 ${path}`);
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
      // Selection is purely a graph-row highlight now — the detail panel is
      // gone, so this is just a synchronous setter behind an async signature
      // (kept async to avoid churning the call sites).
      set({ selectedCommitHash: hash });
    },

    async pull() {
      set({ isLoading: true });
      const branch = get().repo?.currentBranchName;
      const ok = await wrap(async () => {
        await api.pull(branch);
        return true;
      });
      set({ isLoading: false });
      if (ok) get().pushToast('success', '已 pull');
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
      if (ok) get().pushToast('success', '已 push');
      await get().refreshAll();
    },

    async pushTo(remoteRef) {
      const local = get().repo?.currentBranchName;
      if (!local) {
        get().pushToast('warn', 'HEAD 已分离 — 请先检出分支');
        return;
      }
      set({ isLoading: true });
      const ok = await wrap(async () => {
        await api.pushTo({ localBranch: local, remoteRef });
        return true;
      });
      set({ isLoading: false });
      if (ok) get().pushToast('success', `已推送 ${local} → ${remoteRef}`);
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
          get().pushToast('success', '已同步');
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
        get().pushToast('success', `已检出 ${branch}`);
        await get().refreshAll();
      }
    },

    async merge(target) {
      const result = await wrap(async () => {
        const r = await api.merge(target);
        const label = friendlyRef(target);
        if (r.ok) get().pushToast('success', `已合并 ${label}`);
        else
          get().pushToast(
            'warn',
            `合并冲突，涉及 ${r.conflicts?.length ?? 0} 个文件`,
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
        if (r.ok) get().pushToast('success', `已变基到 ${label}`);
        else
          get().pushToast(
            'warn',
            `变基冲突，涉及 ${r.conflicts?.length ?? 0} 个文件`,
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
        if (r.ok) get().pushToast('success', `已 cherry-pick ${label}`);
        else
          get().pushToast(
            'warn',
            `Cherry-pick 冲突，涉及 ${r.conflicts?.length ?? 0} 个文件`,
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
        if (r.ok) get().pushToast('success', `已撤销 ${label}`);
        else
          get().pushToast(
            'warn',
            `撤销冲突，涉及 ${r.conflicts?.length ?? 0} 个文件`,
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
        get().pushToast('success', `已删除 ${name}`);
        await get().refreshAll();
      }
    },

    async createBranch(name, opts = {}) {
      const ok = await wrap(async () => {
        await api.createBranch(name, opts);
        return true;
      });
      if (ok) {
        get().pushToast('success', `已创建 ${name}`);
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
        get().pushToast('success', '已提交');
        await get().refreshAll();
      }
    },

    async stash(action, extra) {
      const ok = await wrap(async () => {
        await api.stash(action, extra);
        return true;
      });
      if (ok) {
        const map: Record<typeof action, string> = {
          save: '已贮藏',
          apply: '已应用',
          pop: '已弹出',
          drop: '已删除',
        };
        get().pushToast('success', map[action] ?? '完成');
        await get().refreshAll();
      }
    },

    pushToast(kind, message) {
      const ttl = kind === 'error' ? 6000 : 3000;
      // De-dupe: if an active toast with the same kind+message is still on
      // screen, bump its count and reset its TTL instead of stacking a
      // brand-new toast. This is what stops a chronically-failing reload
      // (unborn HEAD, network down, …) from snowballing into a wall of
      // identical errors.
      const existing = get().toasts.find((t) => t.kind === kind && t.message === message);
      if (existing) {
        const prevTimer = toastTimers.get(existing.id);
        if (prevTimer !== undefined) clearTimeout(prevTimer);
        set({
          toasts: get().toasts.map((t) =>
            t.id === existing.id ? { ...t, count: t.count + 1 } : t,
          ),
        });
        toastTimers.set(
          existing.id,
          setTimeout(() => get().dismissToast(existing.id), ttl) as unknown as number,
        );
        return;
      }
      const id = nextToastId++;
      set({ toasts: [...get().toasts, { id, kind, message, count: 1 }] });
      toastTimers.set(
        id,
        setTimeout(() => get().dismissToast(id), ttl) as unknown as number,
      );
    },
    dismissToast(id) {
      const timer = toastTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        toastTimers.delete(id);
      }
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
