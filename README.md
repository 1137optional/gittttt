# gittttt

A web-based, GitKraken-style Git visualization client. Renders the commit graph on a virtualized HTML5 canvas, talks to a tiny local Node.js server that runs the actual Git operations, and works against any local repository plus your GitHub account.

## Architecture

```
client/   React 18 + TypeScript + Vite       (dev port 5173)
server/   Node.js + Express + simple-git     (port 3001, loopback)
shared/   Type definitions used by both
```

The browser cannot run `git log`, `git commit`, etc. directly, so a local Node.js server runs all Git operations and exposes them through a small REST API. The client talks to it via `fetch` (proxied through Vite during development; same-origin in production) and subscribes to a Server-Sent Events stream at `/events` to know when something changed on disk.

## Security model

This server has **no authentication** and grants full read/write access to:

- the active local repository,
- arbitrary directories on the host (the in-app folder browser),
- your GitHub account via the stored Personal Access Token.

It is therefore designed to run **only on `127.0.0.1`** and only be reached by the local browser. Specifically:

- `app.listen` binds to `127.0.0.1` by default — other devices on the LAN cannot reach the API.
- CORS uses a strict allowlist (`http://localhost:5173`, `http://localhost:3001`, plus `127.0.0.1` equivalents) so a malicious website you visit cannot use your browser as a confused deputy against the local API.
- The GitHub token lives in `~/.gittttt/token` with `chmod 600`.
- Recently-opened repo paths live in `~/.gittttt/recent-repos.json` (no secrets).

Both `HOST` and `GITTTTT_ALLOW_ORIGIN` are escape hatches for advanced setups (reverse proxy, dev container) — only set them if you understand the implications.

## Getting started

```bash
npm install

# Dev mode — Vite for the client, tsx watch for the server
GITTTTT_REPO=/path/to/your/repo npm run dev

# Then open http://localhost:5173
```

If you don't pass `GITTTTT_REPO`, the server falls back to its own working directory. After cold-start, switch repositories at runtime via the `+` tab in the top navbar (browse a folder, clone from GitHub, or create a new GitHub repo in-app).

### GitHub integration

In the picker, click "添加 token" and paste a Personal Access Token with the `repo` scope. The server validates it against `GET /user`, persists it, and uses it for:

- `GET /api/github/repos`  — list your repos
- `POST /api/github/clone` — clone into `~/gittttt-repos/<name>` (or `$GITTTTT_REPO_DIR`)
- `POST /api/github/create` — create on GitHub then clone locally

No CLI dependency, no OAuth client_id, no callback URL.

## Build for production

```bash
npm run build       # vite -> dist/client, tsc -> dist/server
NODE_ENV=production npm start
```

`npm start` runs the compiled server on `127.0.0.1:3001` and **also serves `dist/client/` from the same origin** — there is no separate static host to run, no CORS to manage. Open `http://localhost:3001`.

## Environment variables

| Variable                  | Purpose                                                           | Default                       |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| `PORT`                    | Server port                                                       | `3001`                        |
| `HOST`                    | Server bind address                                               | `127.0.0.1`                   |
| `NODE_ENV`                | When `production`, the server also serves `dist/client/`          | unset                         |
| `GITTTTT_REPO`            | Auto-open this repo on startup                                    | `process.cwd()`               |
| `GITTTTT_REPO_DIR`        | Where `clone`/`create` drop new repos                             | `~/gittttt-repos`             |
| `GITTTTT_TOKEN_FILE`      | Where to store the GitHub Personal Access Token                   | `~/.gittttt/token`            |
| `GITTTTT_RECENT_FILE`     | Where to store the recently-opened-repos history                  | `~/.gittttt/recent-repos.json`|
| `GITTTTT_ALLOW_ORIGIN`    | Comma-separated extra CORS origins (advanced)                     | unset                         |
| `GITTTTT_SERVER_URL`      | (dev only) URL Vite proxies `/api` and `/events` to               | `http://localhost:3001`       |

## REST API

All endpoints are prefixed with `/api`.

| Method + path                       | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `GET  /api/repo`                    | Active repository info or `{open:false}`               |
| `POST /api/repo/open`               | Body `{path}` — switch the active repo                 |
| `GET  /api/branches`                | Local + remote branches with tracking                  |
| `GET  /api/tags`                    | Tag list                                               |
| `GET  /api/stashes`                 | Stash entries                                          |
| `GET  /api/commits/count`           | Total commit count across all refs                     |
| `GET  /api/commits?skip=&limit=`    | Paginated commit list (newest first)                   |
| `GET  /api/commits/:hash`           | Commit detail (metadata + per-file diff)               |
| `GET  /api/status`                  | Working-tree status                                    |
| `POST /api/checkout`                | Body `{branch}`                                        |
| `POST /api/merge`                   | Body `{branch}` → `{ok, conflicts?}`                   |
| `POST /api/rebase`                  | Body `{branch}` → `{ok, conflicts?}`                   |
| `POST /api/cherry-pick`             | Body `{hash}` → `{ok, conflicts?}`                     |
| `POST /api/revert`                  | Body `{hash}` → `{ok, conflicts?}`                     |
| `POST /api/branches/create`         | Body `{name, from?, checkout?}`                        |
| `POST /api/branches/delete`         | Body `{name, force?}`                                  |
| `POST /api/stage`                   | Body `{files?, all?}`                                  |
| `POST /api/unstage`                 | Body `{files?, all?}`                                  |
| `POST /api/discard`                 | Body `{files?, all?}`                                  |
| `POST /api/commit`                  | Body `{message}`                                       |
| `POST /api/push`                    | Body `{branch?}`                                       |
| `POST /api/push-to`                 | Body `{localBranch, remoteRef}`                        |
| `POST /api/pull`                    | Body `{branch?}`                                       |
| `POST /api/stash`                   | Body `{action: save\|apply\|pop\|drop, index?, message?}` |
| `POST /api/resolve`                 | Body `{path}` (mark conflict resolved)                 |
| `POST /api/merge/complete`          | Finish in-progress merge                               |
| `POST /api/merge/abort`             | Abort in-progress merge                                |
| `GET  /api/github/auth`             | GitHub auth status + configured repos dir              |
| `POST /api/github/token`            | Body `{token}` — validate + persist                    |
| `DELETE /api/github/token`          | Sign out                                               |
| `GET  /api/github/repos`            | List the user's GitHub repos                           |
| `POST /api/github/clone`            | Body `{nameWithOwner}` — clone, then attach            |
| `POST /api/github/create`           | Body `{name, description?, isPrivate?, addReadme?}`    |
| `GET  /api/local-repos`             | Local clones in repos dir + recently-opened paths      |
| `GET  /api/fs/browse?path=&hidden=` | Folder-picker payload (subdirs flagged with isGitRepo) |
| `GET  /events`                      | Server-Sent Events: `repoChanged`                      |

## Project layout

```
gittttt/
├── client/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts                  # fetch wrapper + SSE subscription
│       ├── store.ts                # zustand store (single source of truth)
│       ├── theme.ts                # design tokens for canvas + CSS
│       ├── styles/global.css
│       ├── graph/graphLayout.ts    # column-reuse layout algorithm
│       └── components/
│           ├── TopNav.tsx          # tab strip + theme toggle + pull/push
│           ├── Sidebar.tsx         # branches / remotes / stashes / docs
│           ├── LeftDocs.tsx        # editable Markdown docs page
│           ├── CommitGraph.tsx     # canvas renderer + virtualization
│           ├── WorkingChanges.tsx  # right pane: stage / unstage / commit
│           ├── RepoPicker.tsx      # GitHub list + clone/create + folder browser
│           ├── FolderBrowserModal.tsx
│           ├── NewBranchModal.tsx
│           ├── ContextMenu.tsx
│           ├── Icon.tsx
│           └── ToastStack.tsx
├── server/
│   ├── index.ts                    # Express app + SSE + static client (prod)
│   ├── gitService.ts               # simple-git wrapper, structured outputs
│   ├── githubService.ts            # GitHub REST integration (PAT)
│   ├── fsBrowser.ts                # folder picker backend
│   ├── repoWatcher.ts              # chokidar-based change watcher
│   ├── operationLock.ts            # serial queue for mutations
│   ├── tokenStore.ts               # ~/.gittttt/token (chmod 600)
│   └── recentRepos.ts              # ~/.gittttt/recent-repos.json
├── shared/types.ts
├── vite.config.ts                  # /api + /events proxy in dev
├── tsconfig.{client,server}.json
└── package.json
```

## Implementation notes

- **Graph layout** (`client/src/graph/graphLayout.ts`) walks commits top-down with a column-reuse algorithm: each commit takes the leftmost column waiting for its hash, frees the others (drawing merge-in line segments), and reserves one column per parent for the rest of the walk. Each lane carries a `wasFirstParent` bit so passthroughs above merge-in joins are suppressed correctly — and *not* clobbered when an unrelated merge bezier happens to target the same lane.
- **Virtualized canvas rendering** (`client/src/components/CommitGraph.tsx`) keeps a single canvas sized to the viewport and only paints rows that intersect the visible scroll window — this scales smoothly past tens of thousands of commits. Hit-testing for clicks runs in the same coordinate space as the layout, so no DOM nodes are created per commit.
- **Pagination** loads commits in pages of 300 from `/api/commits?skip=&limit=`. The graph asks for the next page automatically when the user scrolls within ~50 rows of the bottom.
- **Operation lock** (`server/operationLock.ts`) serializes all Git mutations so that, e.g., a `commit` triggered while a `pull` is still running is queued instead of racing.
- **File watcher** (`server/repoWatcher.ts`) ignores changes that happen within 1.5s of a known internal Git operation, so a successful commit doesn't bounce back as a redundant refresh. Internal operations also push an immediate refresh through the SSE channel.
- **SSE-driven refresh** in the client coalesces overlapping refreshes (`dedupedReload` in `store.ts`) so a burst of file events doesn't fire 6 git calls per event.
- **Toast deduplication**: identical kind+message active toasts bump a count badge and reset their TTL instead of stacking, so a chronically-failing reload doesn't snowball into a wall of identical errors.
- **Empty-repo tolerance**: read paths that hit "fatal: No such ref: HEAD" on an unborn repo (`safeRead` in `gitService.ts`) return safe fallbacks (empty arrays / 0) so brand-new repositories don't spam errors.
- **Merge commits** are diffed against their first parent (`git diff parent1..hash`) so the file list isn't empty.

## Roadmap

- ConflictViewer 3-column merge UI (the API supports it; the modal isn't built yet)
- Inline file diff preview in the working-tree panel
- Settings panel (branch palette, font size, default remote)
- Drag-and-drop branch operations on the graph
