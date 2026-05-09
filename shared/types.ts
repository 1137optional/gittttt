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

/** Auth status returned by the `gh` CLI (`gh auth status`). */
export interface GitHubAuthStatus {
  /** True iff `gh` is installed AND a logged-in account exists for github.com. */
  authenticated: boolean;
  /** Logged-in handle, when known. */
  user?: string;
  /** Filled when `authenticated === false` to give the UI a printable reason
   *  (e.g. "gh not installed"). */
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
