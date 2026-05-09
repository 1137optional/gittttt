import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// =============================================================================
// On-disk store for the user's GitHub Personal Access Token.
//
// Single tiny file at ~/.gittttt/token containing only the raw token string.
// chmod 600 so the rest of the user's account can't read it. There is no DB
// here on purpose — keeping this dead-simple makes the security story
// auditable in five lines (no encryption keys to manage, no SQLite to keep
// in sync; if you can read the file, you already have full access to the
// user's home dir).
//
// Switch to a different path with GITTTTT_TOKEN_FILE.
// =============================================================================

const TOKEN_PATH = process.env.GITTTTT_TOKEN_FILE
  ? process.env.GITTTTT_TOKEN_FILE
  : join(homedir(), '.gittttt', 'token');

export function readToken(): string | null {
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    const raw = readFileSync(TOKEN_PATH, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Empty token.');
  // Reasonable shape check — GitHub tokens are 40+ ASCII chars, no spaces.
  // We don't enforce a specific prefix because GitHub keeps adding new ones
  // (ghp_, github_pat_, gho_, ghu_, ghs_, …).
  if (trimmed.length < 20 || /\s/.test(trimmed)) {
    throw new Error('Token looks malformed (must be a single non-whitespace string, ≥20 chars).');
  }
  const dir = dirname(TOKEN_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, trimmed, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync only honours `mode` on creation; if the file existed it
  // keeps the prior bits, so re-clamp.
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* best-effort on platforms without chmod (Windows) */
  }
}

export function deleteToken(): void {
  try {
    if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
  } catch {
    /* swallow — caller treats "no token" as a success */
  }
}

export function getTokenPath(): string {
  return TOKEN_PATH;
}
