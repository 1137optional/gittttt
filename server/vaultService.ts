// =============================================================================
// Vault — structured project documentation store.
//
// Unlike the raw Markdown memory (one file per project), Vault stores typed,
// titled documents with metadata. They live in ~/.gittttt/vault/ as JSON,
// completely independent of any project directory — deleting a project never
// touches Vault. Only the user can delete a Vault doc (requires unlock token).
//
// Document types:
//   overview     — high-level project description
//   decision     — architectural / design decision log
//   retrospective— weekly / sprint retrospective
//   gotcha       — tricky bugs / pitfalls to remember
//   note         — general AI or user freeform note
//   daily_report — automatically generated daily summary
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VAULT_DIR = join(homedir(), '.gittttt', 'vault');

export type VaultDocType =
  | 'overview'
  | 'decision'
  | 'retrospective'
  | 'gotcha'
  | 'note'
  | 'daily_report';

export interface VaultDoc {
  id: string;
  /** Soft reference — the project's absolute path at creation time. Stays
   *  even after the project folder is deleted. */
  projectRef: string | null;
  type: VaultDocType;
  title: string;
  content: string;
  /** 'soul' = written by AI, 'user' = written/edited by human */
  author: 'soul' | 'user';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VaultDocSummary {
  id: string;
  projectRef: string | null;
  type: VaultDocType;
  title: string;
  author: 'soul' | 'user';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  excerpt: string;
}

export class VaultError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function ensureVaultDir(): void {
  if (!existsSync(VAULT_DIR)) {
    mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  }
}

function docPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new VaultError(400, `invalid doc id: ${id}`);
  }
  return join(VAULT_DIR, `${id}.json`);
}

function readDoc(id: string): VaultDoc | null {
  const p = docPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as VaultDoc;
  } catch {
    return null;
  }
}

function saveDoc(doc: VaultDoc): void {
  ensureVaultDir();
  writeFileSync(docPath(doc.id), JSON.stringify(doc, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function excerpt(content: string, max = 120): string {
  for (const line of content.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.slice(0, max);
  }
  return '';
}

// =============================================================================
// Public API
// =============================================================================

export function createDoc(input: {
  projectRef?: string | null;
  type: VaultDocType;
  title: string;
  content: string;
  author?: 'soul' | 'user';
  tags?: string[];
}): VaultDoc {
  ensureVaultDir();
  if (!input.title?.trim()) throw new VaultError(400, 'title is required');
  if (!input.content?.trim()) throw new VaultError(400, 'content is required');
  const now = new Date().toISOString();
  const doc: VaultDoc = {
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    projectRef: input.projectRef ?? null,
    type: input.type,
    title: input.title.trim(),
    content: input.content,
    author: input.author ?? 'soul',
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  saveDoc(doc);
  return doc;
}

export function getDoc(id: string): VaultDoc | null {
  return readDoc(id);
}

export function updateDoc(
  id: string,
  input: { content?: string; title?: string; mode?: 'replace' | 'append'; tags?: string[] },
): VaultDoc | null {
  const doc = readDoc(id);
  if (!doc) return null;
  if (input.title !== undefined) doc.title = input.title.trim();
  if (input.tags !== undefined) doc.tags = input.tags;
  if (input.content !== undefined) {
    if (input.mode === 'append') {
      const sep = doc.content.endsWith('\n\n') ? '' : '\n\n';
      doc.content = doc.content + sep + input.content.trim() + '\n';
    } else {
      doc.content = input.content;
    }
  }
  doc.updatedAt = new Date().toISOString();
  saveDoc(doc);
  return doc;
}

export function deleteDoc(id: string): boolean {
  const p = docPath(id);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDocs(filter?: {
  projectRef?: string;
  type?: string;
}): VaultDocSummary[] {
  ensureVaultDir();
  let files: string[] = [];
  try {
    files = readdirSync(VAULT_DIR);
  } catch {
    return [];
  }

  const out: VaultDocSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    try {
      const doc = readDoc(id);
      if (!doc) continue;
      if (filter?.projectRef && doc.projectRef !== filter.projectRef) continue;
      if (filter?.type && doc.type !== filter.type) continue;
      out.push({
        id: doc.id,
        projectRef: doc.projectRef,
        type: doc.type,
        title: doc.title,
        author: doc.author,
        tags: doc.tags,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        excerpt: excerpt(doc.content),
      });
    } catch {
      /* skip corrupted entries */
    }
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
