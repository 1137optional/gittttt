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
