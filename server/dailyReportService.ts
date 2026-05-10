// =============================================================================
// Daily report service.
//
// Generates a Markdown daily report and saves it as a Vault doc of
// type 'daily_report'. The report summarises:
//   - git activity for the day (commits, files touched)
//   - memory content snapshot
//   - a templated "tomorrow" section the AI fills in
//
// Scheduling: the server calls scheduleDaily() once at boot. It calculates
// the next 22:00 (local time) and sets a timeout. After each trigger it
// reschedules for the next day.
//
// On-demand: POST /api/daily-report/generate triggers it immediately.
// =============================================================================

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as vaultSvc from './vaultService.js';
import { readMemoryOrEmpty } from './memoryService.js';

function memKeyForPath(p: string): string {
  return createHash('sha1').update(p).digest('hex').slice(0, 16);
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 10_000, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function buildReport(projectRoot: string): Promise<string> {
  const today = todayStr();

  // Git activity today
  const gitLog = safeExec(
    `git log --oneline --since="midnight" --format="%h %s"`,
    projectRoot,
  );
  const gitDiff = safeExec(
    `git diff --stat HEAD~1 HEAD 2>/dev/null || echo ""`,
    projectRoot,
  );
  const branch = safeExec('git branch --show-current', projectRoot);

  // Memory snapshot
  const memKey = memKeyForPath(projectRoot);
  const memory = readMemoryOrEmpty(memKey);
  const memExcerpt = memory
    ? memory.split('\n').slice(0, 8).join('\n')
    : '（暂无记忆）';

  return `# 日报 ${today}

## 今天做了什么

**分支**: \`${branch || '未知'}\`

**提交记录**:
${gitLog ? gitLog.split('\n').map(l => `- ${l}`).join('\n') : '- 今天没有新的提交'}

**文件变更摘要**:
\`\`\`
${gitDiff || '无变更'}
\`\`\`

## 卡在哪里

> （AI 或用户在此补充今天遇到的阻塞点）

## 明天计划

> （AI 或用户在此补充明天的计划）

## AI 的观察

> （AI 在此记录对用户工作状态、代码质量、项目进展的观察）

---

**记忆快照（前 8 行）**:
\`\`\`
${memExcerpt}
\`\`\`
`;
}

class DailyReportService {
  private timer: ReturnType<typeof setTimeout> | null = null;

  async generate(projectRoot: string): Promise<vaultSvc.VaultDoc> {
    const content = await buildReport(projectRoot);
    const today = todayStr();

    // Check if a report for today already exists; update it instead of duping.
    const existing = vaultSvc.listDocs({ projectRef: projectRoot, type: 'daily_report' })
      .find(d => d.title === `日报 ${today}`);

    if (existing) {
      return vaultSvc.updateDoc(existing.id, { content, mode: 'replace' }) as vaultSvc.VaultDoc;
    }

    return vaultSvc.createDoc({
      projectRef: projectRoot,
      type: 'daily_report',
      title: `日报 ${today}`,
      content,
      author: 'soul',
      tags: ['日报', today],
    });
  }

  getLatest(projectRoot: string): vaultSvc.VaultDocSummary | null {
    const items = vaultSvc.listDocs({ projectRef: projectRoot, type: 'daily_report' });
    return items[0] ?? null;
  }

  scheduleDaily(getActiveRoot: () => string | null): void {
    if (this.timer) clearTimeout(this.timer);

    const now = new Date();
    const next = new Date(now);
    next.setHours(22, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    this.timer = setTimeout(async () => {
      const root = getActiveRoot();
      if (root && existsSync(root)) {
        try {
          await this.generate(root);
          // eslint-disable-next-line no-console
          console.log(`[gittttt] daily report generated for ${root}`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[gittttt] daily report error', e);
        }
      }
      // Reschedule for next day.
      this.scheduleDaily(getActiveRoot);
    }, delay);

    // eslint-disable-next-line no-console
    console.log(
      `[gittttt] daily report scheduled at ${next.toLocaleTimeString()} ` +
      `(${Math.round(delay / 60_000)} min from now)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

const _instance = new DailyReportService();
export function getDailyReportService(): DailyReportService {
  return _instance;
}
