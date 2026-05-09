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
// Strict CORS allowlist. Without this, any web page the user visited could
// fetch http://localhost:3001/api/repo/open with a malicious path and get
// the local Git agent to operate on it (no SOP protection because we'd
// echo Access-Control-Allow-Origin: *). The allowlist + reflected origin
// pattern blocks third-party origins at the preflight stage.
app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin requests (no Origin header) are fine.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: false,
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
  res.status(500).json({ error: err.message });
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[gittttt] server listening on http://${HOST}:${PORT}`);
  if (existsSync(DEFAULT_REPO)) {
    try {
      attachRepo(DEFAULT_REPO);
      // eslint-disable-next-line no-console
      console.log(`[gittttt] auto-opened repo: ${DEFAULT_REPO}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[gittttt] default path ${DEFAULT_REPO} is not a Git repo; open one via the UI.`,
      );
    }
  }
});
