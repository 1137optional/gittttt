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
  canAccessLogs: boolean;
  canSearchCode: boolean;
  canAccessGit: boolean;
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
  | 'gitOperation';

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
  /** Wall-clock timeout in ms. Server caps at 60_000 regardless. */
  timeout?: number;
}

export interface TerminalRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  /** Set when we killed the process due to the timeout. */
  timedOut?: boolean;
}
