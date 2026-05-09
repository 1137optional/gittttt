import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TerminalRunRequest, TerminalRunResult } from '../shared/types.js';

// =============================================================================
// Terminal exec for the AI agent.
//
// TRUST MODEL: this server is loopback-only and the user enables the
// "terminal" skill manually. The command runs *as the user* — with full
// shell metachar support, env, $HOME, the works. We do NOT pretend to
// sandbox arbitrary shell input. What we DO provide:
//
//   1. Hard wall-clock timeout (default 30s, server caps at 60s).
//   2. cwd locked inside the project root (no `cd /` escape via the cwd
//      argument; the command's own `cd` inside the shell is not blocked,
//      because we can't reliably parse arbitrary shell, but anything it
//      tries to do still runs as the same user with the same perms).
//   3. Output truncation at OUTPUT_CAP per stream so a `cat /dev/urandom`
//      doesn't pin the Node process.
//   4. A *minimal* dangerous-command screen for obvious foot-guns. This is
//      a polite warning to the AI ("don't do that") more than a security
//      boundary — true defence is keeping this skill disabled by default.
//
// We do NOT use `shell: true` with template-string interpolation; we hand
// the user's literal command string to /bin/sh -c (or cmd.exe /d /s /c on
// win32). That's fine because the *whole* string is the threat surface; we
// don't mix in untrusted parts.
// =============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 200_000; // chars per stream

export class TerminalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Patterns that almost always indicate a foot-gun. Not exhaustive — that's
// not the goal — but flagging the common ones keeps the AI from blowing
// up someone's machine with a hallucinated `rm -rf`.
const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[rRf]+\s+)*\/(\s|$)/, reason: 'rm targeting /' },
  { re: /\brm\s+-[rRf]+\s+\$HOME(\b|\/)/, reason: 'rm targeting $HOME' },
  { re: /\brm\s+-[rRf]+\s+~\s*$/, reason: 'rm -rf ~' },
  { re: /\bmkfs\.\w+/, reason: 'mkfs.*' },
  { re: /\bdd\s+if=/, reason: 'dd if=' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: 'fork bomb' },
  { re: /\b(shutdown|halt|reboot|poweroff)\b/, reason: 'shutdown / reboot' },
  { re: />\s*\/dev\/sd[a-z]/, reason: 'write to raw block device' },
];

function screenCommand(command: string): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new TerminalError(400, 'command is required');
  }
  if (command.length > 4000) {
    throw new TerminalError(400, 'command too long');
  }
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(command)) {
      throw new TerminalError(403, `command rejected (${reason})`);
    }
  }
}

function resolveCwd(root: string, requested: string | undefined): string {
  if (!requested) return root;
  if (typeof requested !== 'string') {
    throw new TerminalError(400, 'cwd must be a string');
  }
  // Accept either absolute (validated) or relative (resolved against root).
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new TerminalError(403, 'cwd escapes project root');
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new TerminalError(400, 'cwd must be an existing directory');
  }
  return abs;
}

export async function runCommand(
  root: string,
  req: TerminalRunRequest,
): Promise<TerminalRunResult> {
  screenCommand(req.command);
  const cwd = resolveCwd(root, req.cwd);
  const timeoutMs = Math.max(
    1000,
    Math.min(MAX_TIMEOUT_MS, req.timeout ?? DEFAULT_TIMEOUT_MS),
  );

  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : '/bin/sh';
  const shellArgs = isWin ? ['/d', '/s', '/c', req.command] : ['-c', req.command];

  return new Promise<TerminalRunResult>((resolveP) => {
    const start = Date.now();
    const child = spawn(shell, shellArgs, {
      cwd,
      // Strip variables that could trigger surprising side effects.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (cur: string, chunk: string): string => {
      if (cur.length >= OUTPUT_CAP) return cur;
      const room = OUTPUT_CAP - cur.length;
      if (chunk.length <= room) return cur + chunk;
      return `${cur}${chunk.slice(0, room)}\n…[output truncated]`;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (b: string) => {
      stdout = cap(stdout, b);
    });
    child.stderr.on('data', (b: string) => {
      stderr = cap(stderr, b);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; some tools (vite) ignore it briefly so we follow up
      // with SIGKILL after a short grace.
      try { child.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* */ }
      }, 1500);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + `[spawn error] ${e.message}`,
        exitCode: -1,
        duration: Date.now() - start,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr,
        // Exit code is null for signal-killed processes — surface as 124
        // (the conventional "timeout" code) so callers can branch on it.
        exitCode: code ?? (timedOut ? 124 : (signal ? 137 : -1)),
        duration: Date.now() - start,
        timedOut,
      });
    });
  });
}

// Helper for the route layer: ensure we have a project root before exposing
// any of these endpoints.
export function ensureRoot(root: string | null): string {
  if (!root) {
    throw new TerminalError(409, 'no active project root — open a repo first');
  }
  // Defensive: confirm it still exists.
  if (!existsSync(root)) {
    throw new TerminalError(404, 'active project root no longer exists');
  }
  // Force the result to be absolute / normalised; downstream resolves rely
  // on this.
  let abs = resolve(root);
  while (abs.endsWith(sep) && abs.length > 1) abs = abs.slice(0, -1);
  return abs;
}
