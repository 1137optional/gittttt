// =============================================================================
// Shared types between server (Express + simple-git) and client (React UI).
// All Git data structures returned by the REST API use these shapes.
// =============================================================================

export interface RepoInfo {
  path: string;
  currentBranchName: string;
  detachedHead: boolean;
  inMerge: boolean;
  inRebase: boolean;
}

export interface Branch {
  name: string;
  fullName: string;        // refs/heads/main, refs/remotes/origin/main
  isRemote: boolean;
  isHEAD: boolean;
  lastCommitHash: string;
  upstreamName: string | null;
  ahead: number;
  behind: number;
}

export interface Tag {
  name: string;
  commitHash: string;
}

export interface Stash {
  index: number;
  message: string;
  branchName: string;
}

export interface CommitRef {
  name: string;            // branch or tag name
  type: 'branch' | 'remote' | 'tag' | 'head';
}

export interface Commit {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  refs: CommitRef[];
  authorName: string;
  authorEmail: string;
  timestamp: number;
  message: string;
  isMerge: boolean;
}

export type FileStatusKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'copied'
  | 'conflicted';

export interface FileStatus {
  path: string;
  oldPath?: string;
  status: FileStatusKind;
  staged: boolean;
}

export interface WorkingTreeStatus {
  unstaged: FileStatus[];
  staged: FileStatus[];
  conflicted: FileStatus[];
  hasUnpushed: boolean;
  inMerge: boolean;
  inRebase: boolean;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatusKind;
  additions: number;
  deletions: number;
  diff: string;
}

export interface CommitDetailData {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
  message: string;
  parentHashes: string[];
  changedFiles: ChangedFile[];
}

export interface ConflictFile {
  path: string;
  oursContent: string;
  theirsContent: string;
  baseContent: string;
  isResolved: boolean;
}

export interface ApiError {
  error: string;
  details?: string;
}

export type StashAction = 'save' | 'apply' | 'pop' | 'drop';

// =============================================================================
// GitHub integration (drives /api/github/* and /api/local-repos)
// =============================================================================

/** Auth status — driven by an in-app Personal Access Token saved to
 *  ~/.gittttt/token. No `gh` CLI is involved. */
export interface GitHubAuthStatus {
  /** True iff a token is on disk AND it validated against GET /user. */
  authenticated: boolean;
  /** Logged-in handle, when known. */
  user?: string;
  /** Avatar URL of the logged-in user, when known. */
  avatarUrl?: string;
  /** When `authenticated === false`, a printable reason for the UI. */
  error?: string;
  /** Where the server will clone repos to (`~/gittttt-repos` by default). */
  reposDir: string;
}

export interface GitHubRepoSummary {
  name: string;             // "my-app"
  nameWithOwner: string;    // "alice/my-app"
  owner: string;            // "alice"
  description: string;
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string;
  sshUrl: string;
  url: string;
  pushedAt: number;         // ms epoch
  /** Absolute path of an already-cloned local copy, or null if not cloned yet. */
  localPath: string | null;
}

export interface LocalRepoSummary {
  name: string;
  path: string;
  currentBranchName: string;
  isCurrent: boolean;       // true iff this is the repo currently open in the app
}

export interface CreateGitHubRepoInput {
  name: string;
  description?: string;
  isPrivate: boolean;
  addReadme?: boolean;
}

// =============================================================================
// Filesystem browser (drives /api/fs/browse)
// Used by the in-app folder picker so users never have to paste a path.
// =============================================================================

export interface FsEntry {
  /** Display name (basename). */
  name: string;
  /** Absolute path. */
  path: string;
  /** True iff `<path>/.git` exists — let UI surface "open" directly. */
  isGitRepo: boolean;
  /** True iff name starts with a dot (hidden by default). */
  hidden: boolean;
}

export interface FsBrowseResult {
  /** Absolute path of the directory we just listed. */
  path: string;
  /** Absolute path of the parent dir, or null if `path` is the FS root. */
  parent: string | null;
  /** True iff `<path>/.git` exists — i.e. the listed directory itself is a
   *  git repo, in which case the UI offers an "open this folder" footer. */
  isGitRepo: boolean;
  /** Direct children of `path`, directories only, sorted: git repos first
   *  (so the cursor lands on the most relevant rows), then alphabetical. */
  entries: FsEntry[];
}

// =============================================================================
// Debug-mode AI proxy (drives /api/ai/chat)
// The browser never talks to DeepSeek directly:
//   1. Browser CORS would block most provider endpoints anyway.
//   2. We don't want the user's PAT-style API key to leak into request logs
//      of the embedded preview iframe.
// So we do a thin server-side proxy that forwards the chat request and pipes
// back the assistant's content. The server never persists the API key — the
// client sends it on every request from its own localStorage.
// =============================================================================

export type AIChatRole = 'system' | 'user' | 'assistant';

export interface AIChatMessage {
  role: AIChatRole;
  content: string;
}

export interface AIChatRequest {
  /** Provider API key. The server forwards it 1:1 and discards after the call. */
  apiKey: string;
  /** Provider id. Only 'deepseek' for now; 'openai-compatible' is a future hook. */
  provider: 'deepseek';
  /** Optional model override; falls back to the provider's default chat model. */
  model?: string;
  /** Full chat history (system + alternating user/assistant). */
  messages: AIChatMessage[];
}

export interface AIChatResponse {
  /** The assistant's reply, ready to render in a chat bubble. */
  content: string;
}

// =============================================================================
// Skills system (drives /api/skills + AI tool-calling)
// A "skill" is a permission-bearing capability the AI can call. Each one
// declares which subsystem-level abilities it needs (read/write files,
// terminal, …). Tools shown to the AI are derived from the union of all
// enabled skills' permissions — the user can disable a skill to revoke a
// whole class of tool calls without touching the underlying server.
// =============================================================================

export type SkillCategory = 'core' | 'optional' | 'custom';

export interface SkillPermissions {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canRunTerminal: boolean;
  canSearchCode: boolean;
  canAccessGit: boolean;
  /** Make HTTP(S) requests to arbitrary URLs via the httpRequest tool.
   *  Lets the AI hit local dev endpoints, public APIs, raw-HTML pages.
   *  Cannot click / fill / interact — for that we'd need a real headless
   *  browser. Off by default for the same reason as canRunTerminal: the
   *  surface is wide, e.g. "POST your local DB API" type calls. */
  canMakeHttpRequests: boolean;
  /** Drive a real headless Chromium via Playwright. Lets the AI navigate,
   *  click, fill, screenshot, and read F12 console logs of arbitrary pages
   *  (including SPAs that need real JS execution). MUCH bigger trust
   *  surface than canMakeHttpRequests — the browser carries cookies, runs
   *  arbitrary site JS, and can take screenshots of whatever's loaded. Off
   *  by default; enable only on machines where you're OK with the AI
   *  driving an interactive browser. */
  canUseBrowser: boolean;
  /** Read AND write the per-project AI Memory (see ProjectMemory). With
   *  this granted the AI can `readMemory` to load context on every turn,
   *  and `writeMemory` / `appendMemory` to persist what it learned. The
   *  memory survives the project being deleted; only the user can wipe
   *  it from the Memory page. */
  canAccessMemory: boolean;
}

export interface SkillTrigger {
  /** AI may auto-pick this skill based on context / keyword match. */
  auto: boolean;
  /** User can manually invoke from a "/" mention (future); for now the flag
   *  is informational only. */
  manual: boolean;
  /** Words that should bias the system prompt toward this skill. */
  keywords: string[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Icon name from Icon.tsx — must be one of the registered icons. */
  icon: string;
  enabled: boolean;
  category: SkillCategory;
  permissions: SkillPermissions;
  trigger: SkillTrigger;
  /** Appended to the AI's system prompt when this skill is enabled. */
  systemPrompt: string;
}

export interface SkillsFile {
  /** Last-write timestamp (ISO). Useful for cache busting later. */
  updatedAt: string;
  skills: Skill[];
}

// =============================================================================
// AI tool-calling — text-based protocol so it works on any provider.
//
// Wire format (in the assistant's own response text):
//   <tool_call>{"name":"readFile","args":{"path":"src/a.ts"}}</tool_call>
//
// We parse those tags, execute each call against /api/project /api/terminal /
// shipped GitService, then send the results back to the model as a fresh
// {role:'system'} message and ask for a final answer. Loop is bounded to
// `MAX_TOOL_TURNS` to prevent runaway costs.
// =============================================================================

export type ToolName =
  | 'readFileTree'
  | 'readFile'
  | 'writeFile'
  | 'deleteFile'
  | 'searchCode'
  | 'runCommand'
  | 'gitOperation'
  | 'httpRequest'
  | 'browserNavigate'
  | 'browserClick'
  | 'browserType'
  | 'browserScreenshot'
  | 'browserGetConsole'
  | 'browserGetContent'
  | 'readMemory'
  | 'writeMemory'
  | 'appendMemory';

export interface ToolDef {
  name: ToolName;
  description: string;
  /** Free-form JSON-schema-ish doc string for the AI's eyes. */
  paramsHint: string;
}

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolName;
  /** Marshalled execution output — string keeps the system message simple. */
  output: string;
  ok: boolean;
}

// =============================================================================
// Project-files API (drives /api/project/*).
// Every endpoint is rooted at the *active repo path* on the server so a path
// like 'src/foo.ts' is resolved relative to the current open repo. The
// `X-Project-Root` request header may override this (advanced use only).
// =============================================================================

export interface ProjectFileTreeNode {
  name: string;
  /** Path relative to the project root (POSIX-style separators). */
  path: string;
  type: 'file' | 'directory';
  /** Only set for directories that were expanded. */
  children?: ProjectFileTreeNode[];
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  lines: number;
}

export interface ProjectSearchHit {
  /** Relative path. */
  file: string;
  line: number;
  column: number;
  text: string;
}

// =============================================================================
// Terminal API (drives /api/terminal/run).
// =============================================================================

export interface TerminalRunRequest {
  command: string;
  /** Optional cwd, must be inside the active project root. Defaults to root. */
  cwd?: string;
  /** Wall-clock timeout in ms. Server caps at TERMINAL_MAX_TIMEOUT_MS. */
  timeout?: number;
}

export interface TerminalRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  /** Set when we killed the process due to the timeout. */
  timedOut?: boolean;
  /** Set when we truncated the captured output to fit MAX_OUTPUT_BYTES. */
  truncated?: boolean;
}

// =============================================================================
// httpRequest tool — minimal fetch-style HTTP client the AI can call.
// Not a browser: no cookies, no JS execution, no DOM. Just request/response.
// For "click this button" / "what's in console" we'd need real Playwright.
// =============================================================================

export interface HttpRequestArgs {
  url: string;
  /** Defaults to "GET". Server only allows the standard verbs. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Optional request headers. Authorization / cookies passed through verbatim. */
  headers?: Record<string, string>;
  /** Plain-text or JSON body. We don't introspect — sent as-is. */
  body?: string;
  /** Wall-clock timeout in ms. Server caps at HTTP_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface HttpRequestResult {
  status: number;
  statusText: string;
  /** Lower-cased keys for stable AI lookup. */
  headers: Record<string, string>;
  /** Decoded as UTF-8 text. Truncated to fit MAX_RESPONSE_BYTES. */
  body: string;
  /** Set when body was truncated (so AI knows there's more). */
  truncated?: boolean;
  /** Final URL after any redirects. */
  url: string;
  durationMs: number;
}

// =============================================================================
// Browser tools — Playwright-driven real Chromium. The AI can:
//   - navigate to a URL and wait for load,
//   - click / type / press keys (CSS selector based),
//   - screenshot the page (saved to .gittttt/screenshots/, AI gets the path),
//   - read the rendered DOM text after JS has executed,
//   - read F12 console messages and recent network requests.
//
// We keep ONE shared Chromium context — the same browser across all tool
// calls, so cookies / login state survive between calls. After 5 minutes of
// idle the browser auto-closes to free memory.
//
// The route is `POST /api/ai/browser` with `{ action, args }`. We dispatch
// to the right method server-side. Errors throw `BrowserError` so the
// global handler can surface a structured 4xx/5xx.
// =============================================================================

export type BrowserAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'getConsole'
  | 'getContent'
  | 'close';

export interface BrowserRequest {
  action: BrowserAction;
  args?: Record<string, unknown>;
}

export interface BrowserState {
  /** URL the page is currently on. Empty string if no page yet. */
  url: string;
  /** Page title. Empty string if no page yet. */
  title: string;
  /** Wall-clock ms since the page finished loading (for the AI to know
   *  whether what it last did had time to settle). */
  loadedMs: number;
  /** True once Playwright has the chromium browser process alive. */
  alive: boolean;
}

export interface BrowserConsoleEntry {
  /** Lower-case console level: log / info / warn / error / debug. */
  level: string;
  /** Concatenated text of all console arguments. */
  text: string;
  /** ISO timestamp on the server. */
  time: string;
  /** Source location reported by Chromium (file:line:col). May be empty. */
  source?: string;
}

export interface BrowserScreenshotResult extends BrowserState {
  /** Repo-relative path under .gittttt/screenshots/. AI gets a path string;
   *  the front-end resolves it via /api/screenshot/:name to render. */
  path: string;
  bytes: number;
  /** A short text outline of the rendered DOM (visible headings + buttons +
   *  inputs + first paragraph). DeepSeek can't see images but can use this
   *  to reason about what's on screen. */
  domOutline: string;
}

export interface BrowserContentResult extends BrowserState {
  /** Either the full visible body text or the text inside the supplied
   *  selector. Truncated to BROWSER_MAX_TEXT chars. */
  text: string;
  /** Set when text was truncated. */
  truncated?: boolean;
}

// =============================================================================
// Project memory — one Markdown file per project that the AI manages.
//
// Lives in ~/.gittttt/notes/<sha1(absRepoPath)>.md so it follows the path
// (not the project name) and survives the project folder being deleted.
// User can view + delete from the left-sidebar Memory page; the AI reads
// it on every turn and writes/appends to it as it learns the codebase.
// =============================================================================

export interface ProjectMemory {
  /** sha1(absRepoPath) prefix — the on-disk filename stem. */
  key: string;
  /** Full Markdown content. May be empty. */
  content: string;
  bytes: number;
  /** ISO timestamp of last write. */
  updatedAt: string;
  /** Original repo absolute path on disk (from the sidecar file). May be
   *  null for very old entries that were created before sidecars existed. */
  repoPath: string | null;
  /** True when `repoPath` still exists on disk. False after the user
   *  deleted the project but kept the memory. */
  repoExists: boolean;
  /** Set on writeMemory when the body had to be truncated to fit
   *  HARD_BYTE_LIMIT. Surfaced to the AI so it can summarize. */
  truncated?: boolean;
}

export interface ProjectMemorySummary {
  key: string;
  repoPath: string | null;
  repoExists: boolean;
  bytes: number;
  updatedAt: string;
  /** First non-empty line, capped — for the list view. */
  excerpt: string;
}
