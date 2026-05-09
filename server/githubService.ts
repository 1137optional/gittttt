import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { deleteToken, readToken, writeToken } from './tokenStore.js';
import { readRecentRepos } from './recentRepos.js';
import type {
  CreateGitHubRepoInput,
  GitHubAuthStatus,
  GitHubRepoSummary,
  LocalRepoSummary,
} from '../shared/types.js';

// =============================================================================
// GitHub integration — talks directly to api.github.com using a Personal
// Access Token that the user pastes through the web UI. No CLI dependency.
//
// Why PAT over a full OAuth App / Device Flow?
//   - Device Flow needs an OAuth App's client_id; we don't have a registered
//     one for gittttt and "borrowing" e.g. the gh CLI's id is sketchy.
//   - PAT keeps the trust boundary small: the server stores a bearer token in
//     a 0600 file the user themselves dropped in, and uses it 1:1 for every
//     api.github.com call. No client secrets, no callback URLs.
//
// Cloning goes through simple-git over HTTPS using the token in the URL
// (https://x-access-token:<TOKEN>@github.com/owner/repo.git). That works
// from machines without SSH keys configured for GitHub.
// =============================================================================

const GH_API = 'https://api.github.com';
const UA = 'gittttt/0.1';
const COMMON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': UA,
};

interface CachedAuth {
  user: string;
  avatarUrl: string;
}

export class GitHubService {
  /** Where freshly-cloned + freshly-created repos land on disk. */
  readonly reposDir: string;
  /** Last successful /user lookup; cleared on sign-out or token rotation. */
  private cachedAuth: CachedAuth | null = null;

  constructor() {
    this.reposDir = process.env.GITTTTT_REPO_DIR
      ? resolve(process.env.GITTTTT_REPO_DIR)
      : join(homedir(), 'gittttt-repos');
  }

  // ---------------------------------------------------------------------------
  // Token lifecycle (POST /api/github/token, DELETE /api/github/token)
  // ---------------------------------------------------------------------------

  /** Validate via GET /user and persist on success. Throws on bad token. */
  async signInWithToken(token: string): Promise<GitHubAuthStatus> {
    const cleaned = token.trim();
    if (!cleaned) throw new Error('Empty token.');
    const me = await this.fetchUser(cleaned);
    writeToken(cleaned);
    this.cachedAuth = me;
    return {
      authenticated: true,
      user: me.user,
      avatarUrl: me.avatarUrl,
      reposDir: this.reposDir,
    };
  }

  signOut(): void {
    deleteToken();
    this.cachedAuth = null;
  }

  // ---------------------------------------------------------------------------
  // Auth status — fast path uses cached identity; cold-start hits /user once.
  // ---------------------------------------------------------------------------

  async getAuthStatus(): Promise<GitHubAuthStatus> {
    const token = readToken();
    if (!token) {
      return { authenticated: false, reposDir: this.reposDir };
    }
    if (!this.cachedAuth) {
      try {
        this.cachedAuth = await this.fetchUser(token);
      } catch (e) {
        return {
          authenticated: false,
          error: (e as Error).message,
          reposDir: this.reposDir,
        };
      }
    }
    return {
      authenticated: true,
      user: this.cachedAuth.user,
      avatarUrl: this.cachedAuth.avatarUrl,
      reposDir: this.reposDir,
    };
  }

  // ---------------------------------------------------------------------------
  // Repo listing — paginates GET /user/repos until exhausted (capped at 5
  // pages of 100 == 500 repos, plenty for the picker).
  // ---------------------------------------------------------------------------

  async listRepos(): Promise<GitHubRepoSummary[]> {
    const token = await this.requireToken();
    const cloned = scanLocalClones(this.reposDir);
    const clonedByName = new Map<string, string>();
    for (const c of cloned) clonedByName.set(c.name.toLowerCase(), c.path);

    interface RawRepo {
      name: string;
      full_name: string;
      owner: { login: string } | null;
      description: string | null;
      private: boolean;
      visibility?: string;
      fork: boolean;
      archived: boolean;
      default_branch: string;
      ssh_url: string;
      clone_url: string;
      html_url: string;
      pushed_at: string | null;
    }

    const out: GitHubRepoSummary[] = [];
    const MAX_PAGES = 5;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `${GH_API}/user/repos?per_page=100&page=${page}` +
        `&affiliation=owner,collaborator,organization_member&sort=pushed`;
      const rows = await this.gh<RawRepo[]>(token, 'GET', url);
      for (const r of rows) {
        out.push({
          name: r.name,
          nameWithOwner: r.full_name,
          owner: r.owner?.login ?? r.full_name.split('/')[0],
          description: r.description ?? '',
          visibility: ((r.visibility?.toUpperCase() as GitHubRepoSummary['visibility']) ??
            (r.private ? 'PRIVATE' : 'PUBLIC')),
          isFork: !!r.fork,
          isArchived: !!r.archived,
          defaultBranch: r.default_branch || 'main',
          sshUrl: r.ssh_url,
          url: r.html_url,
          pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0,
          localPath: clonedByName.get(r.name.toLowerCase()) ?? null,
        });
      }
      if (rows.length < 100) break;
    }
    return out.sort((a, b) => b.pushedAt - a.pushedAt);
  }

  // ---------------------------------------------------------------------------
  // Clone — token-bearing HTTPS so users without an SSH key still succeed.
  // Idempotent: if the target dir already has a .git, return the path as-is.
  // ---------------------------------------------------------------------------

  async cloneRepo(nameWithOwner: string): Promise<{ path: string; alreadyPresent: boolean }> {
    const token = await this.requireToken();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(nameWithOwner)) {
      throw new Error(`Invalid repo identifier: ${nameWithOwner}`);
    }
    const safeName = basename(nameWithOwner);
    ensureDir(this.reposDir);
    const target = join(this.reposDir, safeName);
    if (existsSync(join(target, '.git'))) {
      return { path: target, alreadyPresent: true };
    }
    if (existsSync(target)) {
      throw new Error(`Target path exists but is not a Git repo: ${target}`);
    }
    const url = tokenisedHttpsUrl(token, nameWithOwner);
    try {
      await simpleGit().clone(url, target);
    } catch (e) {
      throw new Error(`git clone failed: ${redactToken((e as Error).message, token)}`);
    }
    return { path: target, alreadyPresent: false };
  }

  // ---------------------------------------------------------------------------
  // Create — POST /user/repos, then clone the resulting repo locally so the
  // caller can immediately attach it like any other.
  // ---------------------------------------------------------------------------

  async createRepo(input: CreateGitHubRepoInput): Promise<{ path: string; nameWithOwner: string }> {
    const token = await this.requireToken();
    if (!/^[A-Za-z0-9._-]+$/.test(input.name)) {
      throw new Error('Repo name may only contain letters, digits, dot, dash, underscore.');
    }
    ensureDir(this.reposDir);
    const target = join(this.reposDir, input.name);
    if (existsSync(target)) {
      throw new Error(`A folder named "${input.name}" already exists in ${this.reposDir}.`);
    }

    interface CreatedRepo {
      full_name: string;
      clone_url: string;
    }
    const body = {
      name: input.name,
      description: input.description ?? '',
      private: input.isPrivate,
      auto_init: !!input.addReadme,
    };
    const created = await this.gh<CreatedRepo>(token, 'POST', `${GH_API}/user/repos`, body);

    // If the repo was created without auto_init, GitHub returns an empty
    // repo and `git clone` will warn ("you appear to have cloned an empty
    // repository"). That's fine — simple-git treats it as success.
    const url = tokenisedHttpsUrl(token, created.full_name);
    try {
      await simpleGit().clone(url, target);
    } catch (e) {
      throw new Error(`Repo created but local clone failed: ${redactToken((e as Error).message, token)}`);
    }
    return { path: target, nameWithOwner: created.full_name };
  }

  // ---------------------------------------------------------------------------
  // Local repo store — union of three sources:
  //   1. Auto-clones under reposDir (scanned every call so manual `git clone`
  //      into the dir is reflected without restart).
  //   2. Recent-opened paths persisted in ~/.gittttt/recent-repos.json (every
  //      attachRepo call writes here). This is what makes folder-browser
  //      picks "stick" — they appear in subsequent picker visits even though
  //      they live outside reposDir.
  //   3. The active repo, always pinned at the top.
  // Each path is validated to still exist + still be a git repo before
  // surfacing; stale entries are filtered out (and would naturally drop off
  // the recents store the next time it's rewritten).
  //
  // Order: active repo → other recent-opened → reposDir scan (alpha). Recent
  // ordering matters because it doubles as MRU on the picker.
  // ---------------------------------------------------------------------------

  listLocalRepos(currentRepoPath: string | null): LocalRepoSummary[] {
    ensureDir(this.reposDir);
    const seen = new Set<string>();
    const out: LocalRepoSummary[] = [];

    const push = (path: string, isCurrent: boolean): void => {
      if (seen.has(path)) return;
      if (!isLocalGitRepo(path)) return;
      seen.add(path);
      out.push({
        name: basename(path),
        path,
        currentBranchName: '',
        isCurrent,
      });
    };

    if (currentRepoPath) push(currentRepoPath, true);
    for (const r of readRecentRepos()) push(r.path, currentRepoPath === r.path);
    for (const c of scanLocalClones(this.reposDir)) push(c.path, currentRepoPath === c.path);

    return out;
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  private async requireToken(): Promise<string> {
    const token = readToken();
    if (!token) throw new Error('Not signed in to GitHub. Add a Personal Access Token first.');
    return token;
  }

  private async fetchUser(token: string): Promise<CachedAuth> {
    interface RawUser {
      login: string;
      avatar_url: string;
    }
    const me = await this.gh<RawUser>(token, 'GET', `${GH_API}/user`);
    return { user: me.login, avatarUrl: me.avatar_url };
  }

  /** Single fetch wrapper that handles auth headers + JSON + GitHub errors. */
  private async gh<T>(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      throw new Error(`GitHub network error: ${(e as Error).message}`);
    }
    if (!resp.ok) {
      // Best-effort: surface GitHub's own JSON {message,errors} shape.
      let detail = `${resp.status} ${resp.statusText}`;
      try {
        const text = await resp.text();
        if (text) {
          try {
            const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
            const extra = j.errors?.map((x) => x.message).filter(Boolean).join('; ');
            detail = j.message ? (extra ? `${j.message} — ${extra}` : j.message) : detail;
          } catch {
            detail = `${detail} ${text.slice(0, 200)}`;
          }
        }
      } catch {
        /* ignore — fall back to status line */
      }
      // If the token went bad, drop the cached identity so the next /auth
      // call re-validates instead of lying to the UI.
      if (resp.status === 401 || resp.status === 403) this.cachedAuth = null;
      throw new Error(`GitHub API ${method} ${pathOnly(url)}: ${detail}`);
    }
    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  }
}

// =============================================================================
// Free helpers
// =============================================================================

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname + new URL(url).search;
  } catch {
    return url;
  }
}

function tokenisedHttpsUrl(token: string, nameWithOwner: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${nameWithOwner}.git`;
}

function redactToken(msg: string, token: string): string {
  if (!token) return msg;
  return msg.split(token).join('***');
}

interface LocalClone {
  name: string;
  path: string;
}

function isLocalGitRepo(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (!statSync(path).isDirectory()) return false;
    // .git can be a directory (regular clone) or a file (worktree pointer).
    return existsSync(join(path, '.git'));
  } catch {
    return false;
  }
}

function scanLocalClones(dir: string): LocalClone[] {
  if (!existsSync(dir)) return [];
  const out: LocalClone[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(full, '.git'))) {
      out.push({ name: entry, path: full });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
