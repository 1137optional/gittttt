// =============================================================================
// Guardian — self-protection middleware.
//
// Prevents the AI from accidentally deleting or overwriting the core files
// that make up this project itself (gittttt). On violation the call is
// blocked and a structured error is returned to the AI with an explanation,
// so it can surface the confirmation requirement to the user.
//
// Protected paths are relative to the project root. The check is applied
// before ANY writeFile / deleteFile / runCommand tool invocation.
// =============================================================================

import { resolve, relative } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Hard-coded protected path segments. A tool call whose resolved target
// starts with or equals any of these will be blocked unless the user has
// supplied the confirmation token for this server session.
const PROTECTED_RELATIVE: string[] = [
  'SELF.md',
  'server/guardianService.ts',
  'server/memoryService.ts',
  'server/vaultService.ts',
  'server/dailyReportService.ts',
  'server/index.ts',
  'shared/types.ts',
  '.gittttt',
];

// Shell command fragments that should never run regardless of auth.
const BLOCKED_COMMANDS: RegExp[] = [
  /rm\s+-rf?\s+[./]/,           // rm -rf .  or  rm -r /anything
  />\s*\/dev\/(sd|nvme|hd)/,    // overwrite block devices
  /mkfs/,
  /dd\s+if=/,
];

// A one-time session token the user sets via POST /api/guardian/unlock.
// Cleared on server restart — intentionally short-lived.
let sessionUnlockToken: string | null = null;
let unlockExpiry = 0;
const UNLOCK_TTL_MS = 60_000; // 60 seconds

export interface GuardianCheck {
  allowed: boolean;
  /** Human-readable reason shown to the AI (and surfaced in the chat UI). */
  reason?: string;
}

/** Check a file path tool call (write or delete). */
export function checkFilePath(
  absProjectRoot: string,
  targetAbsPath: string,
  providedToken?: string,
): GuardianCheck {
  const rel = relative(absProjectRoot, resolve(targetAbsPath));
  // Traverse outside the project root → always block.
  if (rel.startsWith('..')) {
    return { allowed: false, reason: `路径越界：${targetAbsPath} 超出项目根目录范围` };
  }

  const isProtected = PROTECTED_RELATIVE.some(
    (p) => rel === p || rel.startsWith(p + '/') || rel.startsWith(p + '\\'),
  );

  if (!isProtected) return { allowed: true };

  // Protected path — require the session unlock token.
  if (providedToken && isUnlocked(providedToken)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `⚠️ 自我保护触发：你正在修改 "${rel}"，这是 gittttt 项目自身的核心文件。\n` +
      `如果确实需要修改，请让用户在界面上点击「解锁」按钮（有效期 60 秒），然后重试。\n` +
      `受保护文件列表：${PROTECTED_RELATIVE.join(', ')}`,
  };
}

/** Check a shell command string. */
export function checkCommand(command: string, providedToken?: string): GuardianCheck {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `⚠️ 危险命令被拦截：\`${command}\` 匹配禁止模式 ${pattern}。此类命令永远不允许执行。`,
      };
    }
  }

  // Commands that touch protected paths also need unlock.
  const mentionsProtected = PROTECTED_RELATIVE.some((p) => command.includes(p));
  if (mentionsProtected) {
    if (providedToken && isUnlocked(providedToken)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `⚠️ 该命令涉及受保护路径，需要用户解锁后才能执行。`,
    };
  }

  return { allowed: true };
}

// =============================================================================
// Session unlock — called from the /api/guardian/unlock endpoint.
// =============================================================================

export function generateUnlockToken(): string {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionUnlockToken = token;
  unlockExpiry = Date.now() + UNLOCK_TTL_MS;
  return token;
}

export function isUnlocked(token: string): boolean {
  return (
    !!sessionUnlockToken &&
    token === sessionUnlockToken &&
    Date.now() < unlockExpiry
  );
}

export function revokeUnlock(): void {
  sessionUnlockToken = null;
  unlockExpiry = 0;
}

export function unlockStatus(): { locked: boolean; expiresIn?: number } {
  if (!sessionUnlockToken || Date.now() >= unlockExpiry) {
    return { locked: true };
  }
  return { locked: false, expiresIn: unlockExpiry - Date.now() };
}

// =============================================================================
// SELF.md reader — injected into the AI system prompt on every turn so the
// AI always starts with identity awareness.
// =============================================================================

let selfMdCache: string | null = null;

export function readSelfIdentity(projectRoot: string): string {
  if (selfMdCache) return selfMdCache;
  const path = resolve(projectRoot, 'SELF.md');
  if (!existsSync(path)) return '';
  try {
    selfMdCache = readFileSync(path, 'utf8');
    return selfMdCache;
  } catch {
    return '';
  }
}
