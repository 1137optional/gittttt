import type {
  AIChatRequest,
  AIChatResponse,
  Branch,
  BrowserConsoleEntry,
  BrowserContentResult,
  BrowserRequest,
  BrowserScreenshotResult,
  BrowserState,
  Commit,
  CreateGitHubRepoInput,
  FsBrowseResult,
  GitHubAuthStatus,
  GitHubRepoSummary,
  GuardianStatus,
  HttpRequestArgs,
  HttpRequestResult,
  LocalRepoSummary,
  ProjectFileContent,
  ProjectFileTreeNode,
  ProjectMemory,
  ProjectMemorySummary,
  ProjectSearchHit,
  RepoInfo,
  Skill,
  Stash,
  Tag,
  TerminalRunRequest,
  TerminalRunResult,
  VaultDoc,
  VaultDocSummary,
  VaultDocType,
  WorkingTreeStatus,
} from '@shared/types';

// Thin wrapper around `fetch` that:
//   - prefixes /api,
//   - parses JSON responses,
//   - converts non-2xx responses into thrown Error objects with the server message.
async function http<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
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
  getStatus: (): Promise<WorkingTreeStatus> => http('GET', '/status'),

  // mutations
  pushTo: (body: { localBranch: string; remoteRef: string }) =>
    http<{ ok: true }>('POST', '/push-to', body),

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

  // GitHub integration (in-app PAT, no CLI dependency).
  githubAuth: (): Promise<GitHubAuthStatus> => http('GET', '/github/auth'),
  githubSignIn: (token: string): Promise<GitHubAuthStatus> =>
    http('POST', '/github/token', { token }),
  githubSignOut: () => http<{ ok: true }>('DELETE', '/github/token'),
  githubRepos: (): Promise<GitHubRepoSummary[]> => http('GET', '/github/repos'),
  githubClone: (nameWithOwner: string): Promise<{ ok: true; alreadyPresent: boolean; repo: RepoInfo }> =>
    http('POST', '/github/clone', { nameWithOwner }),
  githubCreate: (input: CreateGitHubRepoInput): Promise<{ ok: true; repo: RepoInfo }> =>
    http('POST', '/github/create', input),
  localRepos: (): Promise<LocalRepoSummary[]> => http('GET', '/local-repos'),

  // Debug-mode AI proxy. Goes through the local server so the API key never
  // touches the embedded preview iframe and we side-step CORS.
  aiChat: (req: AIChatRequest): Promise<AIChatResponse> => http('POST', '/ai/chat', req),

  // Skills catalog (debug-mode AI tool surface). The server is the source
  // of truth — the client just renders + persists user toggles back.
  getSkills: (): Promise<{ skills: Skill[] }> => http('GET', '/skills'),
  saveSkills: (skills: Skill[]): Promise<{ skills: Skill[] }> =>
    http('PUT', '/skills', { skills }),

  // Project file ops (anchored to the active repo). All paths are relative
  // to the project root; absolute / `..` paths get rejected server-side.
  projectFileTree: (opts?: { dir?: string; depth?: number; exclude?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.dir) qs.set('dir', opts.dir);
    if (opts?.depth != null) qs.set('depth', String(opts.depth));
    if (opts?.exclude) qs.set('exclude', opts.exclude);
    const tail = qs.toString();
    return http<ProjectFileTreeNode>('GET', `/project/file-tree${tail ? `?${tail}` : ''}`);
  },
  readProjectFile: (path: string): Promise<ProjectFileContent> =>
    http('GET', `/project/file?path=${encodeURIComponent(path)}`),
  writeProjectFile: (path: string, content: string) =>
    http<{ ok: true; path: string; written: number }>('POST', '/project/file', { path, content }),
  deleteProjectFile: (path: string) =>
    http<{ ok: true; path: string }>('DELETE', `/project/file?path=${encodeURIComponent(path)}`),
  searchProject: (q: string, opts?: { path?: string; fileTypes?: string }) => {
    const qs = new URLSearchParams({ q });
    if (opts?.path) qs.set('path', opts.path);
    if (opts?.fileTypes) qs.set('fileTypes', opts.fileTypes);
    return http<ProjectSearchHit[]>('GET', `/project/search?${qs.toString()}`);
  },

  // Run a shell command in the project root. 30s default timeout, capped
  // at 120s. Streams stdout/stderr internally; we return the buffered
  // result once the process exits or hits the timeout.
  terminalRun: (req: TerminalRunRequest): Promise<TerminalRunResult> =>
    http('POST', '/terminal/run', req),

  // AI httpRequest tool. The AI calls this to fetch URLs (any HTTP/HTTPS
  // origin). Not a browser — no JS execution, no cookies kept across calls.
  httpRequest: (args: HttpRequestArgs): Promise<HttpRequestResult> =>
    http('POST', '/ai/http', args),

  // AI browser tools. Single endpoint dispatches by `action`. The shared
  // chromium instance lives server-side; calls are stateful (cookies /
  // page state survive between calls). 5-minute idle auto-close.
  browser: (req: BrowserRequest): Promise<
    BrowserState
    | BrowserScreenshotResult
    | BrowserContentResult
    | { entries: BrowserConsoleEntry[]; total: number }
  > => http('POST', '/ai/browser', req),

  // Project memory. One Markdown file per project, AI-managed but
  // user-deletable. `getMemory` returns the active project's memory; the
  // list endpoint returns every memory the user has ever stored (incl.
  // ones whose project has since been deleted) so the Memory page can
  // show + clean orphans.
  getMemory: (): Promise<ProjectMemory> => http('GET', '/memory'),
  getMemoryByKey: (key: string): Promise<ProjectMemory> => http('GET', `/memory/${key}`),
  saveMemory: (content: string, mode: 'replace' | 'append' = 'replace'): Promise<ProjectMemory> =>
    http('PUT', '/memory', { content, mode }),
  deleteMemory: (key: string): Promise<{ ok: true; removed: boolean }> =>
    http('DELETE', `/memory/${key}`),
  listMemories: (): Promise<{ items: ProjectMemorySummary[] }> =>
    http('GET', '/memory/list/all'),

  // In-app folder browser — replaces the manual path input with a real picker.
  fsBrowse: (path?: string, showHidden = false): Promise<FsBrowseResult> => {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (showHidden) qs.set('hidden', '1');
    const tail = qs.toString();
    return http('GET', `/fs/browse${tail ? `?${tail}` : ''}`);
  },

  // Guardian — self-protection unlock.
  guardianStatus: (): Promise<GuardianStatus> => http('GET', '/guardian/status'),
  guardianUnlock: (): Promise<{ token: string; ttlMs: number }> => http('POST', '/guardian/unlock'),
  guardianRevoke: (): Promise<{ ok: true }> => http('POST', '/guardian/revoke'),

  // Vault — structured project docs (user-only deletable).
  listVault: (opts?: { projectRef?: string; type?: VaultDocType }): Promise<{ items: VaultDocSummary[] }> => {
    const qs = new URLSearchParams();
    if (opts?.projectRef) qs.set('projectRef', opts.projectRef);
    if (opts?.type) qs.set('type', opts.type);
    const tail = qs.toString();
    return http('GET', `/vault${tail ? `?${tail}` : ''}`);
  },
  getVaultDoc: (id: string): Promise<VaultDoc> => http('GET', `/vault/${id}`),
  createVaultDoc: (body: {
    projectRef?: string | null;
    type: VaultDocType;
    title: string;
    content: string;
    author?: 'soul' | 'user';
    tags?: string[];
  }): Promise<VaultDoc> => http('POST', '/vault', body),
  updateVaultDoc: (id: string, body: { content?: string; title?: string; mode?: 'replace' | 'append'; tags?: string[] }): Promise<VaultDoc> =>
    http('PUT', `/vault/${id}`, body),
  deleteVaultDoc: (id: string, unlockToken: string): Promise<{ ok: true; removed: boolean }> =>
    http('DELETE', `/vault/${id}`, { unlockToken }),

  // Daily report.
  generateDailyReport: (): Promise<VaultDoc> => http('POST', '/daily-report/generate'),
  getLatestDailyReport: (): Promise<VaultDoc | null> => http('GET', '/daily-report/latest'),
};

// SSE subscription. Returns an `unsubscribe` function.
export function subscribeRepoChanged(onChange: () => void): () => void {
  const es = new EventSource('/events');
  es.addEventListener('repoChanged', () => onChange());
  return () => es.close();
}
