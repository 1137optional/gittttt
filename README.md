# gittttt

A GitKraken-style web Git visualization client. Three-column layout (branches, commit graph, commit detail) with a working-tree panel along the bottom. Renders the commit graph on a virtualized HTML5 canvas for smooth scrolling on large repositories.

## Architecture

```
client/   React 18 + TypeScript + Vite       (port 5173)
server/   Node.js + Express + simple-git      (port 3001)
shared/   Type definitions used by both
```

The browser cannot run `git log`, `git commit`, etc. directly, so a local Node.js server runs all Git operations and exposes them through a small REST API. The client talks to it via `fetch` (proxied through Vite during development) and subscribes to a Server-Sent Events stream at `/events` to know when something changed on disk.

## Getting started

```bash
npm install

# Option A — run both server and client in one terminal
GITTTTT_REPO=/path/to/your/repo npm run dev

# Option B — split across terminals
GITTTTT_REPO=/path/to/your/repo npm run dev:server
npm run dev:client

# Then open http://localhost:5173
```

If you don't pass `GITTTTT_REPO`, the server falls back to its own working directory. You can also switch repositories at runtime by clicking the repo name in the toolbar.

## REST API

All endpoints are prefixed with `/api`.

| Method + path                       | Purpose                                  |
| ----------------------------------- | ---------------------------------------- |
| `GET  /api/repo`                    | Active repository info or `{open:false}` |
| `POST /api/repo/open`               | Body `{path}` — switch the active repo   |
| `GET  /api/branches`                | Local + remote branches with tracking    |
| `GET  /api/tags`                    | Tag list                                 |
| `GET  /api/stashes`                 | Stash entries                            |
| `GET  /api/commits/count`           | Total commit count across all refs       |
| `GET  /api/commits?skip=&limit=`    | Paginated commit list (newest first)     |
| `GET  /api/commits/:hash`           | Commit detail (metadata + per-file diff) |
| `GET  /api/status`                  | Working-tree status                      |
| `GET  /api/search?q=`               | Hashes whose subject matches `q`         |
| `POST /api/checkout`                | Body `{branch}`                          |
| `POST /api/merge`                   | Body `{branch}` → `{ok, conflicts?}`     |
| `POST /api/rebase`                  | Body `{branch}` → `{ok, conflicts?}`     |
| `POST /api/branches/delete`         | Body `{name, force?}`                    |
| `POST /api/stage`                   | Body `{files?, all?}`                    |
| `POST /api/unstage`                 | Body `{files?, all?}`                    |
| `POST /api/discard`                 | Body `{files?, all?}`                    |
| `POST /api/commit`                  | Body `{message}`                         |
| `POST /api/push`                    | Body `{branch?}`                         |
| `POST /api/pull`                    | Body `{branch?}`                         |
| `POST /api/stash`                   | Body `{action, index?, message?}`        |
| `POST /api/resolve`                 | Body `{path}` (mark conflict resolved)   |
| `POST /api/merge/complete`          | Finish in-progress merge                 |
| `POST /api/merge/abort`             | Abort in-progress merge                  |
| `GET  /events`                      | Server-Sent Events: `repoChanged`        |

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
│           ├── Toolbar.tsx
│           ├── BranchTree.tsx
│           ├── CommitGraph.tsx     # canvas renderer + virtualization
│           ├── CommitDetail.tsx
│           ├── DiffViewer.tsx
│           ├── WorkingTree.tsx
│           ├── ContextMenu.tsx
│           ├── RepoPicker.tsx
│           ├── RepoSwitcher.tsx
│           └── ToastStack.tsx
├── server/
│   ├── index.ts                    # Express app + SSE
│   ├── gitService.ts               # simple-git wrapper, structured outputs
│   ├── operationLock.ts            # global serial queue for mutations
│   └── repoWatcher.ts              # chokidar-based change watcher
├── shared/
│   └── types.ts
├── vite.config.ts                  # /api + /events proxy
├── tsconfig.client.json
├── tsconfig.server.json
└── package.json
```

## Implementation notes

- **Graph layout** (`client/src/graph/graphLayout.ts`) walks commits top-down, maintaining a pool of "lane" columns. When a commit is processed, all columns currently waiting for that hash are collapsed into the leftmost lane (drawing merge-in line segments), and parent columns are reserved for the next iterations. Lanes that resolve their parent are returned to the free pool so the graph never grows wider than necessary.
- **Virtualized canvas rendering** (`client/src/components/CommitGraph.tsx`) keeps a single canvas sized to the viewport and only paints rows that intersect the visible scroll window — this scales smoothly past tens of thousands of commits. Hit-testing for clicks runs in the same coordinate space as the layout, so no DOM nodes are created per commit.
- **Pagination** loads commits in pages of 300 from `/api/commits?skip=&limit=`. The graph asks for the next page automatically when the user scrolls within ~50 rows of the bottom.
- **Operation lock** (`server/operationLock.ts`) serializes all Git mutations so that, e.g., a `commit` triggered while a `pull` is still running is queued instead of racing.
- **File watcher** (`server/repoWatcher.ts`) ignores changes that happen within 1.5s of a known internal Git operation, so a successful commit doesn't bounce back as a redundant refresh. Internal operations also push an immediate refresh through the SSE channel.
- **Diff parsing** in `DiffViewer.tsx` handles per-file unified diff blocks (split server-side from `git show`/`git diff` output via `diff --git` headers), tracking old/new line numbers across hunk markers.
- **Merge commits** are diffed against their first parent (`git diff parent1..hash`) so the file list isn't empty.

## Build for production

```bash
npm run build       # builds the client to dist/client and compiles the server to dist/server
npm start           # starts the compiled server (defaults to port 3001)
```

Serve `dist/client` with any static host pointed at the same machine running the server.

## Roadmap

- ConflictViewer 3-column merge UI (the API supports it; the modal isn't built yet)
- Inline file diff preview in the working-tree panel
- Settings panel (branch palette, font size, default remote)
- Drag-and-drop branch operations on the graph
