import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProjectMemory, ProjectMemorySummary } from '../shared/types.js';

// =============================================================================
// Project memory store.
//
// One Markdown file per project, keyed by sha1(absolute repo path) so the
// memory follows the *location* on disk, not the project name. If the user
// re-opens the same path later we rejoin them with their old notes; if they
// move the folder to a new path it's a new memory (which feels right —
// /Users/x/projects/foo and /Users/x/old/foo are arguably different things).
//
// Files live under ~/.gittttt/notes/ — outside any project's own .gittttt/,
// so deleting the project does NOT delete the memory. The user removes a
// memory explicitly via the Memory page.
//
// Format: a plain Markdown file. The AI is encouraged to keep it under
// SOFT_BYTE_LIMIT chars (we enforce HARD_BYTE_LIMIT to prevent runaway
// growth from append loops).
// =============================================================================

const NOTES_DIR = join(homedir(), '.gittttt', 'notes');
const SOFT_BYTE_LIMIT = 24_000;
const HARD_BYTE_LIMIT = 64_000;

export class MemoryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function ensureNotesDir(): void {
  if (!existsSync(NOTES_DIR)) {
    mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Stable key for a project root. We use sha1 (not for security — for path
 *  hashing) so the on-disk filename is fixed-length and free of any chars
 *  that would otherwise need escaping (Windows separators, spaces, etc). */
export function memoryKeyForPath(absPath: string): string {
  const norm = resolve(absPath);
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function pathFor(key: string): string {
  if (!/^[a-f0-9]{16}$/.test(key)) {
    throw new MemoryError(400, `invalid memory key: ${key}`);
  }
  return join(NOTES_DIR, `${key}.md`);
}

function pathForOriginPath(absPath: string): string {
  // Sidecar: stores the original repo absolute path so the "all memories"
  // list can show "this used to live at /Users/.../foo" even when the
  // folder is gone. We write/update this every time we save the memory.
  return join(NOTES_DIR, `${memoryKeyForPath(absPath)}.path.txt`);
}

export interface SaveOptions {
  /** Optional original repo path; required on first write so we can show
   *  the path in the all-memories list. Subsequent writes can omit it
   *  (we won't overwrite a known-good origin path with empty). */
  repoPath?: string;
}

export function readMemory(key: string): ProjectMemory | null {
  ensureNotesDir();
  const file = pathFor(key);
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf8');
    const stat = statSync(file);
    let repoPath: string | null = null;
    const sidecar = join(NOTES_DIR, `${key}.path.txt`);
    if (existsSync(sidecar)) {
      try {
        repoPath = readFileSync(sidecar, 'utf8').trim() || null;
      } catch {
        /* ignore — sidecar is best-effort */
      }
    }
    return {
      key,
      content,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      repoPath,
      // Liveness flag for the UI: helps render a faded "missing" badge
      // when the original folder is gone.
      repoExists: !!(repoPath && existsSync(repoPath)),
    };
  } catch (e) {
    throw new MemoryError(500, `failed to read memory: ${e instanceof Error ? e.message : 'error'}`);
  }
}

export function writeMemory(key: string, content: string, opts: SaveOptions = {}): ProjectMemory {
  ensureNotesDir();
  if (typeof content !== 'string') {
    throw new MemoryError(400, 'content must be a string');
  }
  // Hard cap so a runaway append loop can't fill the disk. Soft cap is
  // enforced by including a "you're getting long, summarize" hint in the
  // AI tool's response instead of refusing the write.
  let body = content;
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > HARD_BYTE_LIMIT) {
    // Find the largest prefix that fits — Buffer.byteLength is needed for
    // multi-byte chars (Chinese characters are 3 bytes each in UTF-8).
    while (Buffer.byteLength(body, 'utf8') > HARD_BYTE_LIMIT) {
      body = body.slice(0, Math.floor(body.length * 0.9));
    }
    truncated = true;
  }
  const file = pathFor(key);
  try {
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    throw new MemoryError(500, `failed to write memory: ${e instanceof Error ? e.message : 'error'}`);
  }
  if (opts.repoPath) {
    try {
      writeFileSync(pathForOriginPath(opts.repoPath), resolve(opts.repoPath), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      /* sidecar best-effort */
    }
  }
  const out = readMemory(key);
  if (!out) throw new MemoryError(500, 'memory write succeeded but read-back failed');
  if (truncated) {
    // Soft signal — UI / AI can decide whether to surface it.
    (out as ProjectMemory & { truncated: boolean }).truncated = true;
  }
  return out;
}

export function appendMemory(key: string, addition: string, opts: SaveOptions = {}): ProjectMemory {
  if (typeof addition !== 'string' || addition === '') {
    throw new MemoryError(400, 'addition must be a non-empty string');
  }
  const cur = readMemory(key);
  const sep = cur && cur.content && !cur.content.endsWith('\n\n') ? '\n\n' : '';
  const combined = (cur?.content ?? '') + sep + addition.trim() + '\n';
  return writeMemory(key, combined, opts);
}

export function deleteMemory(key: string): boolean {
  ensureNotesDir();
  const file = pathFor(key);
  const sidecar = join(NOTES_DIR, `${key}.path.txt`);
  let removed = false;
  if (existsSync(file)) {
    try { unlinkSync(file); removed = true; } catch { /* ignore */ }
  }
  if (existsSync(sidecar)) {
    try { unlinkSync(sidecar); } catch { /* ignore */ }
  }
  return removed;
}

export function listMemories(): ProjectMemorySummary[] {
  ensureNotesDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(NOTES_DIR);
  } catch {
    return [];
  }
  const out: ProjectMemorySummary[] = [];
  for (const name of entries) {
    const m = /^([a-f0-9]{16})\.md$/.exec(name);
    if (!m) continue;
    const key = m[1];
    try {
      const file = join(NOTES_DIR, name);
      const stat = statSync(file);
      const sidecar = join(NOTES_DIR, `${key}.path.txt`);
      let repoPath: string | null = null;
      if (existsSync(sidecar)) {
        try {
          repoPath = readFileSync(sidecar, 'utf8').trim() || null;
        } catch { /* ignore */ }
      }
      // Cheap excerpt: first non-empty line, capped at 120 chars. Lets the
      // list page show "what is this memory about" without loading the
      // full markdown.
      let excerpt = '';
      try {
        const content = readFileSync(file, 'utf8');
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (t) {
            excerpt = t.slice(0, 120);
            break;
          }
        }
      } catch { /* ignore */ }
      out.push({
        key,
        repoPath,
        repoExists: !!(repoPath && existsSync(repoPath)),
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        excerpt,
      });
    } catch {
      /* skip files we can't stat */
    }
  }
  // Most recently updated first — most useful default for the picker UI.
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

/** Get-or-empty helper for the AI prompt path. We don't want a missing
 *  memory file to throw — just return an empty string so the AI sees
 *  "no memory yet" and can decide to write one. */
export function readMemoryOrEmpty(key: string): string {
  const m = readMemory(key);
  return m?.content ?? '';
}

export const limits = {
  SOFT_BYTE_LIMIT,
  HARD_BYTE_LIMIT,
};
