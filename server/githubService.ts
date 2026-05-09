import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  CreateGitHubRepoInput,
  GitHubAuthStatus,
  GitHubRepoSummary,
  LocalRepoSummary,
} from '../shared/types.js';

// =============================================================================
// GitHub integration (delegates to the local `gh` CLI)
//
// Why `gh` instead of OAuth/PAT? It's the only way to talk to GitHub from a
// purely local desktop tool without storing client secrets or making the user
// paste a token. Whatever credentials they already have via `gh auth login`
// just work. If `gh` is missing, every method here returns a clear "install
// gh" message so the UI can route them to a one-line fix.
//
// All operations are non-mutating to the user's git state EXCEPT clone /
// create — those write to disk, so they ask the OS for the configured repo
// directory and create it on demand.
// =============================================================================

export class GitHubService {
  /** Where freshly-cloned + freshly-created repos land on disk. */
  readonly reposDir: string;

  constructor() {
    this.reposDir = process.env.GITTTTT_REPO_DIR
      ? resolve(process.env.GITTTTT_REPO_DIR)
      : join(homedir(), 'gittttt-repos');
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  async getAuthStatus(): Promise<GitHubAuthStatus> {
    const ghOk = await this.hasGh();
    if (!ghOk) {
      return {
        authenticated: false,
        error: 'GitHub CLI (`gh`) is not installed. Install it with `brew install gh`, then run `gh auth login`.',
        reposDir: this.reposDir,
      };
    }
    // `gh auth status` writes to STDERR even on success; ignore exit code,
    // we only care if a logged-in account is present.
    const { stdout, stderr, code } = await runCmd('gh', ['auth', 'status', '--hostname', 'github.com']);
    const text = stdout + '\n' + stderr;
    if (code !== 0 && !/Logged in to github\.com/.test(text)) {
      return {
        authenticated: false,
        error: 'Not logged in to github.com. Run `gh auth login` in a terminal.',
        reposDir: this.reposDir,
      };
    }
    // The line we want looks like:  ✓ Logged in to github.com account alice (keyring)
    const m = /account\s+([A-Za-z0-9-]+)/.exec(text);
    return { authenticated: true, user: m?.[1], reposDir: this.reposDir };
  }

  // ---------------------------------------------------------------------------
  // Repo listing — `gh repo list` returns the user's own repos. Pulls a
  // generous limit (200) since we sort + filter on the client.
  // ---------------------------------------------------------------------------

  async listRepos(): Promise<GitHubRepoSummary[]> {
    await this.ensureAuthenticated();
    const { stdout } = await runCmd(
      'gh',
      [
        'repo',
        'list',
        '--limit',
        '200',
        '--json',
        'name,nameWithOwner,owner,description,visibility,isFork,isArchived,defaultBranchRef,sshUrl,url,pushedAt',
      ],
      { wantOk: true },
    );
    interface Raw {
      name: string;
      nameWithOwner: string;
      owner: { login?: string } | null;
      description: string | null;
      visibility: string;
      isFork: boolean;
      isArchived: boolean;
      defaultBranchRef: { name?: string } | null;
      sshUrl: string;
      url: string;
      pushedAt: string | null;
    }
    let rows: Raw[];
    try {
      rows = JSON.parse(stdout) as Raw[];
    } catch {
      throw new Error('Could not parse `gh repo list` output as JSON.');
    }

    const cloned = scanLocalClones(this.reposDir);
    const clonedByName = new Map<string, string>(); // basename → fullPath
    for (const c of cloned) clonedByName.set(c.name.toLowerCase(), c.path);

    return rows
      .map<GitHubRepoSummary>((r) => ({
        name: r.name,
        nameWithOwner: r.nameWithOwner,
        owner: r.owner?.login ?? r.nameWithOwner.split('/')[0],
        description: r.description ?? '',
        visibility: (r.visibility?.toUpperCase() as GitHubRepoSummary['visibility']) ?? 'PUBLIC',
        isFork: !!r.isFork,
        isArchived: !!r.isArchived,
        defaultBranch: r.defaultBranchRef?.name ?? 'main',
        sshUrl: r.sshUrl,
        url: r.url,
        pushedAt: r.pushedAt ? Date.parse(r.pushedAt) : 0,
        localPath: clonedByName.get(r.name.toLowerCase()) ?? null,
      }))
      .sort((a, b) => b.pushedAt - a.pushedAt);
  }

  // ---------------------------------------------------------------------------
  // Clone — uses `gh repo clone` so auth (SSH/HTTPS, keyring) works exactly
  // the way the user already configured it. Idempotent: if the target dir
  // already exists, returns it without re-cloning.
  // ---------------------------------------------------------------------------

  async cloneRepo(nameWithOwner: string): Promise<{ path: string; alreadyPresent: boolean }> {
    await this.ensureAuthenticated();
    const safeName = basename(nameWithOwner); // strip owner/
    if (!safeName || safeName.includes('..')) throw new Error(`Invalid repo name: ${nameWithOwner}`);
    ensureDir(this.reposDir);
    const target = join(this.reposDir, safeName);
    if (existsSync(join(target, '.git'))) {
      return { path: target, alreadyPresent: true };
    }
    if (existsSync(target)) {
      throw new Error(`Target path exists but is not a Git repo: ${target}`);
    }
    await runCmd('gh', ['repo', 'clone', nameWithOwner, target], { wantOk: true });
    return { path: target, alreadyPresent: false };
  }

  // ---------------------------------------------------------------------------
  // Create — runs `gh repo create` with --clone so we get a working tree on
  // disk in one shot. Always private/public is required by gh; we map our
  // boolean to the right flag. If `addReadme` is true we also pass --add-readme
  // so there's an initial commit (otherwise the clone would be empty).
  // ---------------------------------------------------------------------------

  async createRepo(input: CreateGitHubRepoInput): Promise<{ path: string; nameWithOwner: string }> {
    await this.ensureAuthenticated();
    if (!/^[A-Za-z0-9._-]+$/.test(input.name)) {
      throw new Error('Repo name may only contain letters, digits, dot, dash, underscore.');
    }
    ensureDir(this.reposDir);
    const target = join(this.reposDir, input.name);
    if (existsSync(target)) {
      throw new Error(`A folder named "${input.name}" already exists in ${this.reposDir}.`);
    }
    const args = [
      'repo',
      'create',
      input.name,
      input.isPrivate ? '--private' : '--public',
      '--clone',
    ];
    if (input.description) args.push('--description', input.description);
    if (input.addReadme) args.push('--add-readme');

    // `gh repo create … --clone` writes the clone into CWD, so run it from
    // inside the repos dir.
    await runCmd('gh', args, { cwd: this.reposDir, wantOk: true });

    // Resolve the resulting nameWithOwner via `gh repo view` (we need the
    // owner login since the user may belong to multiple accounts).
    const { stdout } = await runCmd('gh', ['repo', 'view', input.name, '--json', 'nameWithOwner'], {
      cwd: target,
      wantOk: true,
    });
    let nameWithOwner = '';
    try {
      const parsed = JSON.parse(stdout) as { nameWithOwner?: string };
      nameWithOwner = parsed.nameWithOwner ?? input.name;
    } catch {
      nameWithOwner = input.name;
    }
    return { path: target, nameWithOwner };
  }

  // ---------------------------------------------------------------------------
  // Local repo store — a flat list of every repo under `reposDir`.
  // ---------------------------------------------------------------------------

  listLocalRepos(currentRepoPath: string | null): LocalRepoSummary[] {
    ensureDir(this.reposDir);
    const cloned = scanLocalClones(this.reposDir);
    const seen = new Set<string>();
    const out: LocalRepoSummary[] = [];
    for (const c of cloned) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push({
        name: c.name,
        path: c.path,
        currentBranchName: '',
        isCurrent: currentRepoPath === c.path,
      });
    }
    // If the active repo isn't under reposDir (e.g. user opened a path
    // manually), surface it on top so they know where they are.
    if (currentRepoPath && !seen.has(currentRepoPath)) {
      out.unshift({
        name: basename(currentRepoPath),
        path: currentRepoPath,
        currentBranchName: '',
        isCurrent: true,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async ensureAuthenticated(): Promise<void> {
    const auth = await this.getAuthStatus();
    if (!auth.authenticated) throw new Error(auth.error ?? 'Not authenticated with GitHub.');
  }

  private async hasGh(): Promise<boolean> {
    const { code } = await runCmd('gh', ['--version']);
    return code === 0;
  }
}

// =============================================================================
// Free helpers
// =============================================================================

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface RunOpts {
  cwd?: string;
  /** When true, throw on non-zero exit (with stderr in the message). */
  wantOk?: boolean;
}

// Spawn a child process and collect its full stdio. We spawn instead of
// `execFile` so very large `gh repo list` outputs (hundreds of repos) don't
// trip the default ~1MB exec buffer. ENOENT is converted into a non-throwing
// `code: -1` so the auth check can detect "gh missing" without try/catch.
function runCmd(cmd: string, args: string[], opts: RunOpts = {}): Promise<CmdResult> {
  return new Promise<CmdResult>((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', () => {
      // Most likely ENOENT (gh not on PATH). Surface as code: -1 so the auth
      // check can format a friendly "install gh" message without try/catch.
      resolveP({ stdout, stderr, code: -1 });
    });
    child.on('close', (code) => {
      if (opts.wantOk && code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `exit ${code}`;
        rejectP(new Error(`\`${cmd} ${args.join(' ')}\` failed: ${msg}`));
        return;
      }
      resolveP({ stdout, stderr, code });
    });
  });
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

interface LocalClone {
  name: string;
  path: string;
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
