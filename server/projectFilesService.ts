import {
  existsSync,
  promises as fsp,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ProjectFileContent,
  ProjectFileTreeNode,
  ProjectSearchHit,
} from '../shared/types.js';

// =============================================================================
// Project filesystem operations exposed to the AI agent.
//
// THE BIG SECURITY CONTRACT — every public function in this file:
//   1. Receives a `root` (absolute path of the active repo / project root)
//   2. Treats the user-supplied `relPath` as untrusted input
//   3. Resolves it, then asserts the result still lives inside `root`
//      (this catches `..`, absolute paths, symlink-pointer abuse on disk)
//   4. Forbids writes to .git / .gittttt / node_modules
//
// The "no symlink escape" check uses realpath where possible — we fall back
// to lexical containment if realpath fails (e.g. file doesn't exist yet for
// a write). For brand-new files we additionally lexical-check the *parent*
// dir's realpath because that exists.
//
// Path separators: external API speaks POSIX ('/') exclusively; we convert
// at the boundary.
// =============================================================================

const NEVER_WRITE_DIRS = ['.git', '.gittttt', 'node_modules'];
const DEFAULT_TREE_EXCLUDES = ['node_modules', '.git', 'dist', '.cache', '.next', '.turbo'];
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_NODES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB — the AI cannot meaningfully eat more
const MAX_SEARCH_HITS = 200;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

export class ProjectFilesError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

// Normalize an untrusted relative path and ensure the result, when resolved
// against `root`, still lives inside `root`. Throws ProjectFilesError(403)
// otherwise. Returns { abs, rel } where rel uses POSIX separators.
function safeResolve(root: string, relPath: string): { abs: string; rel: string } {
  if (typeof relPath !== 'string') {
    throw new ProjectFilesError(400, 'path must be a string');
  }
  // Reject absolute and Windows-drive-letter paths up front.
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new ProjectFilesError(403, 'absolute paths are not allowed');
  }
  // resolve() collapses '..' segments — we then verify lexical containment.
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    if (rel !== '') throw new ProjectFilesError(403, 'path escapes project root');
  }
  return { abs, rel: toPosix(rel) };
}

// Realpath check for the existing parent directory — defends against the
// case where someone planted a symlink inside the project that points out.
async function assertNoSymlinkEscape(root: string, abs: string): Promise<void> {
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return; // root of fs, nothing more to check
    probe = parent;
  }
  try {
    const real = await fsp.realpath(probe);
    const rootReal = await fsp.realpath(root);
    if (!real.startsWith(rootReal + sep) && real !== rootReal) {
      throw new ProjectFilesError(403, 'symlink escapes project root');
    }
  } catch (e) {
    if (e instanceof ProjectFilesError) throw e;
    // Realpath failures on a missing path shouldn't block — caller verified
    // lexical containment already.
  }
}

function assertWritable(rel: string): void {
  // POSIX form, leading slash stripped already by safeResolve.
  const head = rel.split('/')[0];
  if (NEVER_WRITE_DIRS.includes(head)) {
    throw new ProjectFilesError(403, `writes to ${head} are not allowed`);
  }
}

// -----------------------------------------------------------------------------
// File tree
// -----------------------------------------------------------------------------

export interface TreeOptions {
  /** Relative subdirectory; default = root. */
  dir?: string;
  /** Recursion cap (default 3). Bounded between 1 and 8. */
  depth?: number;
  /** Comma-separated dir/file names to skip (merged with defaults). */
  exclude?: string;
}

export function getFileTree(root: string, opts: TreeOptions = {}): ProjectFileTreeNode {
  const startRel = opts.dir ?? '';
  const { abs: startAbs, rel: startRelClean } = safeResolve(root, startRel || '.');
  const stat = statSync(startAbs);
  if (!stat.isDirectory()) {
    throw new ProjectFilesError(400, 'tree dir must be a directory');
  }
  const depth = Math.max(1, Math.min(8, opts.depth ?? DEFAULT_TREE_DEPTH));
  const userExcludes = (opts.exclude ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const excludes = new Set([...DEFAULT_TREE_EXCLUDES, ...userExcludes]);

  let nodeBudget = MAX_TREE_NODES;

  function walk(absDir: string, relDir: string, remaining: number): ProjectFileTreeNode {
    const node: ProjectFileTreeNode = {
      name: relDir === '' ? toPosix(relative(root, absDir)) || '/' : relDir.split('/').pop() || relDir,
      path: relDir,
      type: 'directory',
      children: [],
    };
    if (remaining <= 0) return node;
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return node;
    }
    // Directories first, alphabetical — keeps the AI's mental map stable.
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (nodeBudget <= 0) break;
      if (excludes.has(entry.name)) continue;
      // Skip dotfiles by default — keeps tree clean. An explicit query can
      // re-include them via ?exclude= overriding none of the dotfile family.
      if (entry.name.startsWith('.') && !userExcludes.includes(entry.name)) {
        // Allow .env-ish names through; people genuinely want those visible.
        if (entry.name !== '.env' && entry.name !== '.env.local') continue;
      }
      nodeBudget--;
      const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const childAbs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        node.children!.push(walk(childAbs, childRel, remaining - 1));
      } else if (entry.isFile()) {
        node.children!.push({ name: entry.name, path: childRel, type: 'file' });
      }
    }
    return node;
  }

  return walk(startAbs, startRelClean, depth);
}

// -----------------------------------------------------------------------------
// Read / write / delete
// -----------------------------------------------------------------------------

export async function readProjectFile(
  root: string,
  relPath: string,
): Promise<ProjectFileContent> {
  const { abs, rel } = safeResolve(root, relPath);
  await assertNoSymlinkEscape(root, abs);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new ProjectFilesError(404, `no such file: ${rel}`);
  }
  if (!stat.isFile()) throw new ProjectFilesError(400, 'path is not a file');
  if (stat.size > MAX_FILE_BYTES) {
    throw new ProjectFilesError(413, `file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`);
  }
  const content = await fsp.readFile(abs, 'utf8');
  return {
    path: rel,
    content,
    size: stat.size,
    lines: content.split('\n').length,
  };
}

export async function writeProjectFile(
  root: string,
  relPath: string,
  content: string,
): Promise<{ path: string; written: number }> {
  const { abs, rel } = safeResolve(root, relPath);
  assertWritable(rel);
  await assertNoSymlinkEscape(root, abs);
  if (typeof content !== 'string') {
    throw new ProjectFilesError(400, 'content must be a string');
  }
  if (content.length > MAX_FILE_BYTES) {
    throw new ProjectFilesError(413, 'content too large');
  }
  const dir = dirname(abs);
  if (!existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.writeFile(abs, content, 'utf8');
  return { path: rel, written: Buffer.byteLength(content, 'utf8') };
}

export async function deleteProjectFile(
  root: string,
  relPath: string,
): Promise<{ path: string }> {
  const { abs, rel } = safeResolve(root, relPath);
  assertWritable(rel);
  await assertNoSymlinkEscape(root, abs);
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new ProjectFilesError(404, `no such file: ${rel}`);
  }
  if (!stat.isFile()) throw new ProjectFilesError(400, 'only single files can be deleted');
  await fsp.unlink(abs);
  return { path: rel };
}

// -----------------------------------------------------------------------------
// Cross-file search
// -----------------------------------------------------------------------------

export interface SearchOptions {
  /** Required search query (substring, case sensitive). */
  query: string;
  /** Optional subtree (relative). Defaults to root. */
  path?: string;
  /** Comma-separated extensions like '.ts,.tsx'. Empty -> all text-ish. */
  fileTypes?: string;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.css', '.scss', '.html', '.htm',
  '.txt', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql', '.proto',
  '.svg', '.xml',
]);

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export async function searchProject(
  root: string,
  opts: SearchOptions,
): Promise<ProjectSearchHit[]> {
  const query = (opts.query ?? '').trim();
  if (!query) throw new ProjectFilesError(400, 'query is required');
  if (query.length > 200) throw new ProjectFilesError(400, 'query too long');

  const startRel = opts.path ?? '';
  const { abs: startAbs } = safeResolve(root, startRel || '.');
  const allowedExts = (opts.fileTypes ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
  const extFilter = allowedExts.length > 0 ? new Set(allowedExts) : null;

  const hits: ProjectSearchHit[] = [];

  async function walk(absDir: string): Promise<void> {
    if (hits.length >= MAX_SEARCH_HITS) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      if (DEFAULT_TREE_EXCLUDES.includes(entry.name)) continue;
      if (entry.name.startsWith('.git')) continue;
      const childAbs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs);
      } else if (entry.isFile()) {
        const ext = fileExt(entry.name);
        if (extFilter ? !extFilter.has(ext) : !TEXT_EXTENSIONS.has(ext)) continue;
        try {
          const stat = await fsp.stat(childAbs);
          if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
          const content = await fsp.readFile(childAbs, 'utf8');
          // Cheap full-string search; ripgrep would be nicer but not worth the
          // dependency on shellouts here. Hits-per-file capped at 5 to stop
          // a single giant file from soaking the whole budget.
          let perFile = 0;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const idx = line.indexOf(query);
            if (idx >= 0) {
              hits.push({
                file: toPosix(relative(root, childAbs)),
                line: i + 1,
                column: idx + 1,
                text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
              });
              perFile++;
              if (hits.length >= MAX_SEARCH_HITS || perFile >= 5) break;
            }
          }
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }

  await walk(startAbs);
  return hits;
}
