import type {
  Branch,
  Commit,
  CommitDetailData,
  RepoInfo,
  Stash,
  Tag,
  WorkingTreeStatus,
} from '@shared/types';

// Thin wrapper around `fetch` that:
//   - prefixes /api,
//   - parses JSON responses,
//   - converts non-2xx responses into thrown Error objects with the server message.
async function http<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    const msg = (data && data.error) || `${method} ${path} failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

function safeParse(t: string): any {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export const api = {
  // repo lifecycle
  getRepo: (): Promise<{ open: boolean } & Partial<RepoInfo>> => http('GET', '/repo'),
  openRepo: (path: string): Promise<RepoInfo> => http('POST', '/repo/open', { path }),

  // reads
  getBranches: (): Promise<Branch[]> => http('GET', '/branches'),
  getTags: (): Promise<Tag[]> => http('GET', '/tags'),
  getStashes: (): Promise<Stash[]> => http('GET', '/stashes'),
  getCommitCount: (): Promise<{ count: number }> => http('GET', '/commits/count'),
  getCommitsRange: (skip: number, limit: number): Promise<Commit[]> =>
    http('GET', `/commits?skip=${skip}&limit=${limit}`),
  getCommitDetail: (hash: string): Promise<CommitDetailData> =>
    http('GET', `/commits/${encodeURIComponent(hash)}`),
  getStatus: (): Promise<WorkingTreeStatus> => http('GET', '/status'),
  searchCommits: (q: string): Promise<string[]> =>
    http('GET', `/search?q=${encodeURIComponent(q)}`),

  // mutations
  checkout: (branch: string) => http<{ ok: true }>('POST', '/checkout', { branch }),
  merge: (branch: string) =>
    http<{ ok: boolean; conflicts?: string[] }>('POST', '/merge', { branch }),
  rebase: (branch: string) =>
    http<{ ok: boolean; conflicts?: string[] }>('POST', '/rebase', { branch }),
  cherryPick: (hash: string) =>
    http<{ ok: boolean; conflicts?: string[] }>('POST', '/cherry-pick', { hash }),
  revert: (hash: string) =>
    http<{ ok: boolean; conflicts?: string[] }>('POST', '/revert', { hash }),
  deleteBranch: (name: string, force = false) =>
    http<{ ok: true }>('POST', '/branches/delete', { name, force }),
  createBranch: (name: string, opts: { from?: string; checkout?: boolean } = {}) =>
    http<{ ok: true }>('POST', '/branches/create', { name, ...opts }),

  stage: (files: string[]) => http<{ ok: true }>('POST', '/stage', { files }),
  stageAll: () => http<{ ok: true }>('POST', '/stage', { all: true }),
  unstage: (files: string[]) => http<{ ok: true }>('POST', '/unstage', { files }),
  unstageAll: () => http<{ ok: true }>('POST', '/unstage', { all: true }),
  discard: (files: string[]) => http<{ ok: true }>('POST', '/discard', { files }),
  discardAllUnstaged: () => http<{ ok: true }>('POST', '/discard', { all: true }),

  commit: (message: string) => http<{ ok: true }>('POST', '/commit', { message }),
  push: (branch?: string) => http<{ ok: true }>('POST', '/push', { branch }),
  pull: (branch?: string) => http<{ ok: true }>('POST', '/pull', { branch }),

  stash: (action: 'save' | 'apply' | 'pop' | 'drop', extra?: { index?: number; message?: string }) =>
    http<{ ok: true }>('POST', '/stash', { action, ...extra }),

  resolveConflict: (path: string) => http<{ ok: true }>('POST', '/resolve', { path }),
  completeMerge: () => http<{ ok: true }>('POST', '/merge/complete'),
  abortMerge: () => http<{ ok: true }>('POST', '/merge/abort'),
};

// SSE subscription. Returns an `unsubscribe` function.
export function subscribeRepoChanged(onChange: () => void): () => void {
  const es = new EventSource('/events');
  es.addEventListener('repoChanged', () => onChange());
  return () => es.close();
}
