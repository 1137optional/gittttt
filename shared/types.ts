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
