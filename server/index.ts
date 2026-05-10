import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitService } from './gitService.js';
import { GitHubService } from './githubService.js';
import { browseDirectory } from './fsBrowser.js';
import { RepoWatcher } from './repoWatcher.js';
import { recordRecentRepo } from './recentRepos.js';
import { aiChat } from './aiService.js';
import { readSkills, writeSkills } from './skillsStore.js';
import {
  deleteProjectFile,
  getFileTree,
  ProjectFilesError,
  readProjectFile,
  searchProject,
  writeProjectFile,
} from './projectFilesService.js';
import { ensureRoot, runCommand, TerminalError } from './terminalService.js';
import { executeHttpRequest, HttpRequestError } from './httpService.js';
import * as browserSvc from './browserService.js';
import { BrowserError } from './browserService.js';
import * as memorySvc from './memoryService.js';
import { MemoryError } from './memoryService.js';
import * as guardian from './guardianService.js';
import * as vaultSvc from './vaultService.js';
import { VaultError } from './vaultService.js';
import { getDailyReportService } from './dailyReportService.js';
import type {
  AIChatRequest,
  BrowserRequest,
  HttpRequestArgs,
  Skill,
  TerminalRunRequest,
} from '../shared/types.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
// Default to loopback only — this server has no auth and grants full read/write
// on the local filesystem + the user's GitHub PAT. Binding to 0.0.0.0 would
// turn it into a remote-shell on the LAN. Override with $HOST if you really
// know what you're doing (e.g. running behind a reverse proxy that does authn).
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_REPO = process.env.GITTTTT_REPO
  ? resolve(process.env.GITTTTT_REPO)
  : process.cwd();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// In production we serve the built client out of dist/client from the same
// origin as the API, so requests are same-origin and we don't need CORS at
// all. In dev the client is served from Vite on :5173 and proxies /api/* to
// us — Vite's proxy makes the browser see same-origin too, but a developer
// hitting the API straight from another origin (curl, Postman, …) still
// works because we explicitly allow common loopback origins.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
if (process.env.GITTTTT_ALLOW_ORIGIN) {
  for (const o of process.env.GITTTTT_ALLOW_ORIGIN.split(',')) {
    const trimmed = o.trim();
    if (trimmed) ALLOWED_ORIGINS.add(trimmed);
  }
}

// -----------------------------------------------------------------------------
// App-wide singleton: active GitService and watcher. We support switching
// repos at runtime through POST /api/repo/open.
// -----------------------------------------------------------------------------
let git: GitService | null = null;
let activeRepoPath: string | null = null;
let watcher: RepoWatcher | null = null;
const github = new GitHubService();
const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown = {}): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(payload);
}

function attachRepo(path: string): GitService {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
  watcher?.dispose();
  git = new GitService(abs, {
    onInternalOp: () => {
      watcher?.markInternalOp();
      // Always notify the client immediately after an internal op so the UI
      // refreshes even if the file watcher would have suppressed the event.
      broadcast('repoChanged');
    },
  });
  activeRepoPath = abs;
  // Browser-tool screenshots get saved under the active repo's .gittttt/.
  // Keep that location in sync whenever the active repo changes.
  browserSvc.setProjectRoot(abs);
  watcher = new RepoWatcher(abs, () => broadcast('repoChanged'));
  watcher.start();
  // Persist into the "recent repos" history so the picker can list every
  // local repo the user has touched, not just the ones that happen to live
  // under the configured reposDir.
  recordRecentRepo(abs);
  return git;
}

function ensureGit(): GitService {
  if (!git) throw new Error('No repository is open. POST /api/repo/open first.');
  return git;
}

// Wraps an async route so thrown errors flow into the error middleware
// instead of crashing the process.
function ah<T>(
  handler: (req: Request, res: Response) => Promise<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const app = express();

// -----------------------------------------------------------------------------
// CORS — strict allowlist. Without this, any web page the user visited
// could fetch http://localhost:3001/api/repo/open with a malicious path
// and get the local Git agent to operate on it. The allowlist + reflected-
// origin pattern blocks third-party origins at the preflight stage.
// Same-origin / no-Origin requests (server-side curl, native apps) are
// allowed because they aren't subject to the browser's CORS policy.
// -----------------------------------------------------------------------------
app.use(
  cors((req, cb) => {
    const origin = req.headers.origin;
    if (!origin) {
      cb(null, { origin: true, credentials: false });
      return;
    }
    if (ALLOWED_ORIGINS.has(origin)) {
      cb(null, { origin: true, credentials: false });
      return;
    }
    cb(new Error(`Origin not allowed: ${origin}`));
  }),
);
app.use(express.json({ limit: '5mb' }));

// -----------------------------------------------------------------------------
// Repo lifecycle
// -----------------------------------------------------------------------------
app.get(
  '/api/repo',
  ah(async (_req, res) => {
    if (!git) {
      res.json({ open: false });
      return;
    }
    const info = await git.getRepoInfo();
    res.json({ open: true, ...info });
  }),
);

app.post(
  '/api/repo/open',
  ah(async (req, res) => {
    const { path } = req.body as { path?: string };
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: 'Missing "path" in body' });
      return;
    }
    const svc = attachRepo(path);
    const info = await svc.getRepoInfo();
    broadcast('repoChanged');
    res.json(info);
  }),
);

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------
app.get('/api/branches', ah(async (_req, res) => res.json(await ensureGit().getBranches())));
app.get('/api/tags', ah(async (_req, res) => res.json(await ensureGit().getTags())));
app.get('/api/stashes', ah(async (_req, res) => res.json(await ensureGit().getStashes())));

app.get(
  '/api/commits',
  ah(async (req, res) => {
    const skip = parseInt(String(req.query.skip ?? '0'), 10);
    const limit = parseInt(String(req.query.limit ?? '300'), 10);
    res.json(await ensureGit().getCommitsRange(skip, limit));
  }),
);

app.get(
  '/api/commits/count',
  ah(async (_req, res) => {
    res.json({ count: await ensureGit().getCommitCount() });
  }),
);

app.get(
  '/api/commits/:hash',
  ah(async (req, res) => {
    res.json(await ensureGit().getCommitDetail(req.params.hash));
  }),
);

app.get('/api/status', ah(async (_req, res) => res.json(await ensureGit().getWorkingTreeStatus())));

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------
app.post(
  '/api/checkout',
  ah(async (req, res) => {
    await ensureGit().checkout(req.body.branch);
    res.json({ ok: true });
  }),
);
app.post(
  '/api/merge',
  ah(async (req, res) => {
    res.json(await ensureGit().merge(req.body.branch));
  }),
);
app.post(
  '/api/rebase',
  ah(async (req, res) => {
    res.json(await ensureGit().rebase(req.body.branch));
  }),
);
app.post(
  '/api/cherry-pick',
  ah(async (req, res) => {
    const { hash } = req.body as { hash?: string };
    if (!hash) {
      res.status(400).json({ error: 'Missing commit hash' });
      return;
    }
    res.json(await ensureGit().cherryPick(hash));
  }),
);
app.post(
  '/api/revert',
  ah(async (req, res) => {
    const { hash } = req.body as { hash?: string };
    if (!hash) {
      res.status(400).json({ error: 'Missing commit hash' });
      return;
    }
    res.json(await ensureGit().revert(hash));
  }),
);
app.post(
  '/api/branches/delete',
  ah(async (req, res) => {
    await ensureGit().deleteBranch(req.body.name, !!req.body.force);
    res.json({ ok: true });
  }),
);
app.post(
  '/api/branches/create',
  ah(async (req, res) => {
    const { name, from, checkout } = req.body as {
      name?: string;
      from?: string;
      checkout?: boolean;
    };
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Missing branch name' });
      return;
    }
    await ensureGit().createBranch(name, from, checkout !== false);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/stage',
  ah(async (req, res) => {
    const { files, all } = req.body as { files?: string[]; all?: boolean };
    if (all) {
      await ensureGit().stageAll();
    } else if (Array.isArray(files)) {
      for (const f of files) await ensureGit().stageFile(f);
    } else {
      res.status(400).json({ error: 'Provide files[] or all=true' });
      return;
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/unstage',
  ah(async (req, res) => {
    const { files, all } = req.body as { files?: string[]; all?: boolean };
    if (all) {
      await ensureGit().unstageAll();
    } else if (Array.isArray(files)) {
      for (const f of files) await ensureGit().unstageFile(f);
    } else {
      res.status(400).json({ error: 'Provide files[] or all=true' });
      return;
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/discard',
  ah(async (req, res) => {
    const { files, all } = req.body as { files?: string[]; all?: boolean };
    if (all) {
      await ensureGit().discardAllUnstaged();
    } else if (Array.isArray(files)) {
      for (const f of files) await ensureGit().discardFile(f);
    } else {
      res.status(400).json({ error: 'Provide files[] or all=true' });
      return;
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/commit',
  ah(async (req, res) => {
    await ensureGit().commit(req.body.message);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/push',
  ah(async (req, res) => {
    await ensureGit().push(req.body?.branch);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/push-to',
  ah(async (req, res) => {
    const { localBranch, remoteRef } = req.body as { localBranch?: string; remoteRef?: string };
    if (!localBranch || !remoteRef) {
      res.status(400).json({ error: 'localBranch and remoteRef are required' });
      return;
    }
    await ensureGit().pushTo(localBranch, remoteRef);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/pull',
  ah(async (req, res) => {
    await ensureGit().pull(req.body?.branch);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/stash',
  ah(async (req, res) => {
    const { action, index, message } = req.body as {
      action: 'save' | 'apply' | 'pop' | 'drop';
      index?: number;
      message?: string;
    };
    const svc = ensureGit();
    switch (action) {
      case 'save':
        await svc.stashSave(message);
        break;
      case 'apply':
        await svc.stashApply(index ?? 0);
        break;
      case 'pop':
        await svc.stashPop(index ?? 0);
        break;
      case 'drop':
        await svc.stashDrop(index ?? 0);
        break;
      default:
        res.status(400).json({ error: 'Unknown stash action' });
        return;
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/resolve',
  ah(async (req, res) => {
    await ensureGit().markConflictResolved(req.body.path);
    res.json({ ok: true });
  }),
);
app.post(
  '/api/merge/complete',
  ah(async (_req, res) => {
    await ensureGit().commitMerge();
    res.json({ ok: true });
  }),
);
app.post(
  '/api/merge/abort',
  ah(async (_req, res) => {
    await ensureGit().abortMerge();
    res.json({ ok: true });
  }),
);

// -----------------------------------------------------------------------------
// GitHub integration (in-app PAT — no CLI dependency)
//   GET    /api/github/auth   — auth status + configured repos dir
//   POST   /api/github/token  — { token } : validate + persist
//   DELETE /api/github/token  — sign out (delete stored token)
//   GET    /api/github/repos  — list user's GitHub repos
//   POST   /api/github/clone  — clone {nameWithOwner}, then open it
//   POST   /api/github/create — create+clone {name,description,...}, open it
//   GET    /api/local-repos   — list local clones in the repos dir + active repo
// -----------------------------------------------------------------------------
app.get('/api/github/auth', ah(async (_req, res) => res.json(await github.getAuthStatus())));

app.post(
  '/api/github/token',
  ah(async (req, res) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    res.json(await github.signInWithToken(token));
  }),
);

app.delete(
  '/api/github/token',
  ah(async (_req, res) => {
    github.signOut();
    res.json({ ok: true });
  }),
);

app.get('/api/github/repos', ah(async (_req, res) => res.json(await github.listRepos())));

app.post(
  '/api/github/clone',
  ah(async (req, res) => {
    const { nameWithOwner } = req.body as { nameWithOwner?: string };
    if (!nameWithOwner) {
      res.status(400).json({ error: 'nameWithOwner is required' });
      return;
    }
    const { path, alreadyPresent } = await github.cloneRepo(nameWithOwner);
    const svc = attachRepo(path);
    const info = await svc.getRepoInfo();
    broadcast('repoChanged');
    res.json({ ok: true, alreadyPresent, repo: info });
  }),
);

app.post(
  '/api/github/create',
  ah(async (req, res) => {
    const body = req.body as {
      name?: string;
      description?: string;
      isPrivate?: boolean;
      addReadme?: boolean;
    };
    if (!body.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const { path } = await github.createRepo({
      name: body.name,
      description: body.description ?? '',
      isPrivate: !!body.isPrivate,
      addReadme: body.addReadme !== false, // default true so the clone isn't empty
    });
    const svc = attachRepo(path);
    const info = await svc.getRepoInfo();
    broadcast('repoChanged');
    res.json({ ok: true, repo: info });
  }),
);

app.get(
  '/api/local-repos',
  ah(async (_req, res) => {
    res.json(github.listLocalRepos(activeRepoPath));
  }),
);

// -----------------------------------------------------------------------------
// AI chat proxy (debug mode). The browser POSTs its API key + chat history;
// we forward to DeepSeek and return the assistant's text. The key is never
// stored — the client re-sends it from its own localStorage on every call.
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/chat',
  ah(async (req, res) => {
    const body = req.body as AIChatRequest;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Body must be an AIChatRequest object.' });
      return;
    }
    res.json(await aiChat(body));
  }),
);

// -----------------------------------------------------------------------------
// Skills catalog (drives the AI agent's tool surface). Persisted in
// ~/.gittttt/skills.json so the server is the source of truth for what the
// AI is allowed to do — the client just toggles flags.
// -----------------------------------------------------------------------------
app.get('/api/skills', ah(async (_req, res) => res.json({ skills: readSkills() })));

app.put(
  '/api/skills',
  ah(async (req, res) => {
    const body = req.body as { skills?: Skill[] };
    if (!body || !Array.isArray(body.skills)) {
      res.status(400).json({ error: 'body.skills must be an array' });
      return;
    }
    res.json({ skills: writeSkills(body.skills) });
  }),
);

// -----------------------------------------------------------------------------
// Project filesystem + terminal (the AI agent's hands & feet).
//
// Project root resolution: every request needs a "where am I" anchor. We
// derive that from the currently-attached repo so the AI is always pointed
// at the project the user is looking at. An advanced caller can override
// with the X-Project-Root header — we still validate that it points at an
// existing directory.
// -----------------------------------------------------------------------------
function resolveProjectRoot(req: Request): string {
  const override = req.header('x-project-root');
  return ensureRoot(override && override.trim() !== '' ? override.trim() : activeRepoPath);
}

app.get(
  '/api/project/file-tree',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    res.json(
      getFileTree(root, {
        dir: typeof req.query.dir === 'string' ? req.query.dir : undefined,
        depth: req.query.depth ? parseInt(String(req.query.depth), 10) : undefined,
        exclude: typeof req.query.exclude === 'string' ? req.query.exclude : undefined,
      }),
    );
  }),
);

app.get(
  '/api/project/file',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!path) {
      res.status(400).json({ error: 'path query param is required' });
      return;
    }
    res.json(await readProjectFile(root, path));
  }),
);

app.post(
  '/api/project/file',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    const { path, content, unlockToken } = (req.body ?? {}) as {
      path?: string; content?: string; unlockToken?: string;
    };
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: 'body.path is required' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'body.content must be a string' });
      return;
    }
    const guard = guardian.checkFilePath(root, resolve(root, path), unlockToken);
    if (!guard.allowed) {
      res.status(403).json({ error: guard.reason });
      return;
    }
    const result = await writeProjectFile(root, path, content);
    res.json({ ok: true, ...result });
  }),
);

app.delete(
  '/api/project/file',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    // Some HTTP libs strip DELETE bodies, so accept ?path= as well.
    const fromBody = (req.body ?? {}) as { path?: string; unlockToken?: string };
    const path = fromBody.path ?? (typeof req.query.path === 'string' ? req.query.path : '');
    if (!path) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const guard = guardian.checkFilePath(root, resolve(root, path), fromBody.unlockToken);
    if (!guard.allowed) {
      res.status(403).json({ error: guard.reason });
      return;
    }
    const result = await deleteProjectFile(root, path);
    res.json({ ok: true, ...result });
  }),
);

app.get(
  '/api/project/search',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(
      await searchProject(root, {
        query: q,
        path: typeof req.query.path === 'string' ? req.query.path : undefined,
        fileTypes: typeof req.query.fileTypes === 'string' ? req.query.fileTypes : undefined,
      }),
    );
  }),
);

app.post(
  '/api/terminal/run',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    const body = (req.body ?? {}) as TerminalRunRequest & { unlockToken?: string };
    const guard = guardian.checkCommand(body.command ?? '', body.unlockToken);
    if (!guard.allowed) {
      res.status(403).json({ error: guard.reason });
      return;
    }
    res.json(await runCommand(root, body));
  }),
);

// -----------------------------------------------------------------------------
// AI httpRequest tool. Lets the model do "fetch this URL" without burning a
// terminal call on `curl`. Body is HttpRequestArgs; response is the
// HttpRequestResult shape (status/headers/body/durationMs).
//
// No project root needed — this is a network call, not a filesystem call.
// Permission check is enforced client-side via the Skills system; same
// trust model as /api/terminal/run.
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/http',
  ah(async (req, res) => {
    res.json(await executeHttpRequest((req.body ?? {}) as HttpRequestArgs));
  }),
);

// -----------------------------------------------------------------------------
// AI browser tool. Single endpoint that dispatches to the right
// browserService method based on `action`. Lazy-launches chromium on first
// call; auto-closes after 5 minutes of idle.
//
// Action / args contract is documented in shared/types.ts (BrowserAction).
// Each method returns its own typed result (BrowserState, ScreenshotResult,
// ContentResult, console list); we don't wrap them so the AI sees structured
// fields it can act on.
// -----------------------------------------------------------------------------
app.post(
  '/api/ai/browser',
  ah(async (req, res) => {
    const body = (req.body ?? {}) as BrowserRequest;
    if (!body || typeof body.action !== 'string') {
      throw new BrowserError(400, 'request body must include { action, args? }');
    }
    const args = (body.args ?? {}) as Record<string, unknown>;
    switch (body.action) {
      case 'navigate':
        return res.json(await browserSvc.navigate(args));
      case 'click':
        return res.json(await browserSvc.click(args));
      case 'type':
        return res.json(await browserSvc.type(args));
      case 'screenshot':
        return res.json(await browserSvc.screenshot(args));
      case 'getConsole':
        return res.json(await browserSvc.getConsole(args));
      case 'getContent':
        return res.json(await browserSvc.getContent(args));
      case 'close':
        return res.json(await browserSvc.closeBrowser());
      default:
        throw new BrowserError(400, `unknown browser action: ${body.action}`);
    }
  }),
);

// -----------------------------------------------------------------------------
// Screenshot static serving. Lives under the active repo's
// .gittttt/screenshots/ — we expose it via /api/screenshot/:name so the
// front-end can render the image alongside the AI's tool result.
// -----------------------------------------------------------------------------
app.get(
  '/api/screenshot/:name',
  ah(async (req, res) => {
    const root = resolveProjectRoot(req);
    const name = req.params.name;
    if (!/^[\w.-]+\.png$/.test(name)) {
      res.status(400).send('invalid screenshot name');
      return;
    }
    const abs = join(root, '.gittttt', 'screenshots', name);
    if (!existsSync(abs)) {
      res.status(404).send('not found');
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.sendFile(abs);
  }),
);

// -----------------------------------------------------------------------------
// Project memory — per-project Markdown notes the AI manages.
//
//   GET    /api/memory             → memory for the active repo (key derived)
//   GET    /api/memory/:key        → specific memory by sha1 key
//   PUT    /api/memory             → write/replace memory for active repo
//   DELETE /api/memory/:key        → permanently remove a stored memory
//   GET    /api/memory/list/all    → list every stored memory (incl. orphans)
//
// Memory is keyed by sha1(absRepoPath) and survives the project being
// removed. The "list/all" endpoint drives the left-sidebar Memory page,
// which lets the user see / delete memories whose project is gone.
// -----------------------------------------------------------------------------
function activeRepoMemoryKey(): string {
  if (!activeRepoPath) {
    throw new MemoryError(409, 'no active project — open a repo first');
  }
  return memorySvc.memoryKeyForPath(activeRepoPath);
}

app.get('/api/memory/list/all', ah(async (_req, res) => {
  res.json({ items: memorySvc.listMemories() });
}));

app.get('/api/memory', ah(async (_req, res) => {
  const key = activeRepoMemoryKey();
  const m = memorySvc.readMemory(key);
  res.json(m ?? {
    key,
    content: '',
    bytes: 0,
    updatedAt: new Date(0).toISOString(),
    repoPath: activeRepoPath,
    repoExists: true,
  });
}));

app.get('/api/memory/:key', ah(async (req, res) => {
  const m = memorySvc.readMemory(req.params.key);
  if (!m) {
    res.status(404).json({ error: 'memory not found' });
    return;
  }
  res.json(m);
}));

app.put('/api/memory', ah(async (req, res) => {
  const key = activeRepoMemoryKey();
  const body = (req.body ?? {}) as { content?: unknown; mode?: unknown };
  if (typeof body.content !== 'string') {
    throw new MemoryError(400, 'body must be { content: string, mode?: "replace"|"append" }');
  }
  const mode = body.mode === 'append' ? 'append' : 'replace';
  const out = mode === 'append'
    ? memorySvc.appendMemory(key, body.content, { repoPath: activeRepoPath ?? undefined })
    : memorySvc.writeMemory(key, body.content, { repoPath: activeRepoPath ?? undefined });
  res.json(out);
}));

app.delete('/api/memory/:key', ah(async (req, res) => {
  const removed = memorySvc.deleteMemory(req.params.key);
  res.json({ ok: true, removed });
}));

// -----------------------------------------------------------------------------
// Guardian — self-protection unlock API.
// POST /api/guardian/unlock  → generate a 60-second unlock token
// POST /api/guardian/revoke  → revoke early
// GET  /api/guardian/status  → { locked, expiresIn? }
// -----------------------------------------------------------------------------
app.post('/api/guardian/unlock', ah(async (_req, res) => {
  const token = guardian.generateUnlockToken();
  res.json({ token, ttlMs: 60_000 });
}));

app.post('/api/guardian/revoke', ah(async (_req, res) => {
  guardian.revokeUnlock();
  res.json({ ok: true });
}));

app.get('/api/guardian/status', ah(async (_req, res) => {
  res.json(guardian.unlockStatus());
}));

// -----------------------------------------------------------------------------
// Vault — structured project documentation.
//
//   GET    /api/vault             → list all docs (with optional ?projectRef= filter)
//   POST   /api/vault             → create a new doc
//   GET    /api/vault/:id         → fetch single doc
//   PUT    /api/vault/:id         → update doc (AI can append; cannot delete)
//   DELETE /api/vault/:id         → permanently delete (user-only, requires unlock token)
// -----------------------------------------------------------------------------
app.get('/api/vault', ah(async (req, res) => {
  const projectRef = typeof req.query.projectRef === 'string' ? req.query.projectRef : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  res.json({ items: vaultSvc.listDocs({ projectRef, type }) });
}));

app.post('/api/vault', ah(async (req, res) => {
  const body = (req.body ?? {}) as Parameters<typeof vaultSvc.createDoc>[0];
  res.status(201).json(vaultSvc.createDoc(body));
}));

app.get('/api/vault/:id', ah(async (req, res) => {
  const doc = vaultSvc.getDoc(req.params.id);
  if (!doc) { res.status(404).json({ error: 'doc not found' }); return; }
  res.json(doc);
}));

app.put('/api/vault/:id', ah(async (req, res) => {
  const body = (req.body ?? {}) as { content?: string; title?: string; mode?: 'replace' | 'append' };
  const doc = vaultSvc.updateDoc(req.params.id, body);
  if (!doc) { res.status(404).json({ error: 'doc not found' }); return; }
  res.json(doc);
}));

app.delete('/api/vault/:id', ah(async (req, res) => {
  // Vault delete is user-only — require unlock token.
  const body = (req.body ?? {}) as { unlockToken?: string };
  const token = body.unlockToken ?? (typeof req.query.unlockToken === 'string' ? req.query.unlockToken : undefined);
  if (!token || !guardian.isUnlocked(token)) {
    res.status(403).json({ error: '删除 Vault 文档需要先解锁（POST /api/guardian/unlock）' });
    return;
  }
  const removed = vaultSvc.deleteDoc(req.params.id);
  res.json({ ok: true, removed });
}));

// -----------------------------------------------------------------------------
// Daily report — on-demand trigger + scheduler status.
//   POST /api/daily-report/generate  → generate now (returns the new doc)
//   GET  /api/daily-report/latest    → latest report for active repo
// -----------------------------------------------------------------------------
app.post('/api/daily-report/generate', ah(async (_req, res) => {
  const root = activeRepoPath ?? process.cwd();
  const report = getDailyReportService();
  const doc = await report.generate(root);
  res.json(doc);
}));

app.get('/api/daily-report/latest', ah(async (_req, res) => {
  const root = activeRepoPath ?? process.cwd();
  const report = getDailyReportService();
  const doc = report.getLatest(root);
  res.json(doc ?? null);
}));

// -----------------------------------------------------------------------------
// In-app folder browser (drives the "open any folder" UI without a path
// input). Returns subdirectories of `path` (defaulting to $HOME), each
// flagged with whether it's a git repo.
// -----------------------------------------------------------------------------
app.get(
  '/api/fs/browse',
  ah(async (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    const showHidden = req.query.hidden === '1' || req.query.hidden === 'true';
    res.json(browseDirectory(path, { showHidden }));
  }),
);

// -----------------------------------------------------------------------------
// Server-Sent Events: real-time refresh notifications.
// -----------------------------------------------------------------------------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('event: hello\ndata: {}\n\n');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);
  sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// -----------------------------------------------------------------------------
// Static client (production only). In dev Vite serves the client on :5173 and
// proxies /api -> :3001, so we leave HTTP routing alone. In production we
// build the client to dist/client and serve it from the SAME origin so the
// whole app is one process, one port, no CORS surface, no separate static
// host required.
// -----------------------------------------------------------------------------
if (IS_PRODUCTION) {
  // dist/server/index.js -> ../client/  (relative to the compiled output)
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(here, '..', 'client');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    // SPA fallback: anything that isn't /api/*, /events, or a real file goes
    // to index.html so client-side routing (if any) works.
    app.get(/^(?!\/(?:api|events)(?:$|\/)).*/, (_req, res) => {
      res.sendFile(join(clientDist, 'index.html'));
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[gittttt] NODE_ENV=production but ${clientDist} is missing; ` +
        `run "npm run build" before "npm start".`,
    );
  }
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  // eslint-disable-next-line no-console
  console.error('[gittttt][api error]', err.message);
  // Pass through structured HTTP statuses from our typed error classes
  // (ProjectFilesError, TerminalError) so the client can show 404/403/etc.
  // properly instead of every error becoming a 500.
  let status = 500;
  if (
    err instanceof ProjectFilesError
    || err instanceof TerminalError
    || err instanceof HttpRequestError
    || err instanceof BrowserError
    || err instanceof MemoryError
    || err instanceof VaultError
  ) {
    status = err.status;
  } else {
    const maybeStatus = (err as unknown as { status?: unknown }).status;
    if (typeof maybeStatus === 'number') status = maybeStatus;
  }
  res.status(status).json({ error: err.message });
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[gittttt] server listening on http://${HOST}:${PORT}`);

  // Start the daily report scheduler.
  getDailyReportService().scheduleDaily(() => activeRepoPath);

  if (existsSync(DEFAULT_REPO)) {
    try {
      attachRepo(DEFAULT_REPO);
      // eslint-disable-next-line no-console
      console.log(`[gittttt] auto-opened repo: ${DEFAULT_REPO}`);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[gittttt] default path ${DEFAULT_REPO} is not a Git repo; open one via the UI.`,
      );
    }
  }
});

// Graceful shutdown — Playwright's chromium child process needs a clean
// kill, otherwise it can survive the parent and squat on memory until the
// OS reaps it. Chromium close is async; we wait briefly then exit anyway.
function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[gittttt] ${signal} received, shutting down`);
  Promise.race([
    browserSvc.closeBrowser(),
    new Promise((r) => setTimeout(r, 1500)),
  ]).finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
