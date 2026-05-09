import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Skill, SkillsFile } from '../shared/types.js';

// =============================================================================
// On-disk store of the AI's skill catalog.
//
// Why server-side (mirrors recentRepos.ts / tokenStore.ts):
//   - skills carry permission bits (canRunTerminal etc.) — the *server* is
//     the trust boundary for those, so the canonical state lives where the
//     enforcement happens
//   - survives a browser cache wipe
//   - same backend can be hit by multiple browser sessions
//
// Layout: ~/.gittttt/skills.json  -> SkillsFile { updatedAt, skills[] }
//
// Boot logic (readSkills):
//   1. read file, if missing seed with BUILTIN_SKILLS
//   2. merge: any BUILTIN whose id isn't on disk gets re-added (so users who
//      delete a core skill by mistake get it back next launch). User edits
//      to a core skill's `enabled` flag are preserved.
//
// Override file location with $GITTTTT_SKILLS_FILE.
// =============================================================================

const SKILLS_PATH = process.env.GITTTTT_SKILLS_FILE
  ? process.env.GITTTTT_SKILLS_FILE
  : join(homedir(), '.gittttt', 'skills.json');

// We duplicate the seed list here (not import from client/) so the server
// has zero client-side imports. Keep this in lock-step with
// `client/src/skills/registry.ts` whenever core skills change.
const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'core.logs',
    name: '日志分析',
    description: '读取调试日志面板里的错误信息，分析问题根因',
    icon: 'bug',
    enabled: true,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: true, manual: true, keywords: ['日志', '报错', 'console', 'error'] },
    systemPrompt:
      '你能直接读取用户粘贴在对话里的日志片段。优先识别错误堆栈、异常类型、'
      + '触发位置；指出最可能的根因，再给修复方向。',
  },
  {
    id: 'core.read',
    name: '读取文件',
    description: '读取项目中任意文件的内容与目录结构',
    icon: 'folder',
    enabled: true,
    category: 'core',
    permissions: {
      canReadFiles: true,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: true, manual: false, keywords: [] },
    systemPrompt:
      '调用 readFileTree({dir, depth?}) 看项目结构，readFile({path}) 读单文件。'
      + '修改任何文件之前都先读它一次确认当前内容。',
  },
  {
    id: 'core.write',
    name: '修改文件',
    description: '创建或更新项目里的文件（不允许写 .git / .gittttt / node_modules）',
    icon: 'check',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: true,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: false, manual: true, keywords: ['修改', '创建', '写入', 'fix'] },
    systemPrompt:
      'writeFile({path, content}) 整体覆盖文件；deleteFile({path}) 删除单个文件。'
      + '给用户做修改前，请用 readFile 确认你看到的是最新内容；改完简短说明改了什么、为何这么改。',
  },
  {
    id: 'core.terminal',
    name: '执行命令',
    description: '在项目根跑 shell 命令（默认 30s、最长 120s 超时；危险命令会被拦）',
    icon: 'play',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: true,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: false, manual: true, keywords: ['运行', '执行', 'npm', 'yarn', 'pnpm'] },
    systemPrompt:
      'runCommand({command, cwd?, timeout?}) 在项目根执行。结果含 stdout / stderr / exitCode / duration。'
      + '慢命令记得加 timeout（单位 ms，最大 120000）。'
      + '不要重复执行同一条命令；常驻服务（dev server）请告诉用户手动起。',
  },
  {
    id: 'core.http',
    name: 'HTTP 请求',
    description: '让 AI 直接 fetch 任意 URL（GET/POST/...）。不是浏览器，不会执行 JS、不保留 cookie',
    icon: 'globe',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: true,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: {
      auto: false,
      manual: true,
      keywords: ['请求', '接口', 'API', 'fetch', 'curl', 'http', 'url'],
    },
    systemPrompt:
      'httpRequest({url, method?, headers?, body?, timeoutMs?}) 发 HTTP 请求。'
      + '回参含 status / statusText / headers / body / durationMs。'
      + '主要用途：测自己的 dev API、查公共 REST、抓静态 HTML 看首屏内容。'
      + '动态页面（SPA、需登录、需 JS 渲染）拿不到完整 DOM。'
      + '能用 httpRequest 解决的就别 runCommand 跑 curl，回参更结构化。',
  },
  {
    id: 'core.browser',
    name: '操作浏览器',
    description: '用真·Chromium 打开页面、点击、填表、截图、读 F12 console。会执行 JS、保留 cookie',
    icon: 'play',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: true,
      canAccessMemory: false,
    },
    trigger: {
      auto: false,
      manual: true,
      keywords: ['浏览器', '点击', '截图', '页面', 'console', 'f12', '登录', '前端报错'],
    },
    systemPrompt:
      'browserNavigate({url}) 打开，browserClick / browserType 操作，'
      + 'browserGetContent({selector?}) 读渲染后的文字，browserGetConsole() 读 F12 全部消息，'
      + 'browserScreenshot({fullPage?, selector?}) 存图到 .gittttt/screenshots/。'
      + '会话连续：cookie / localStorage 在调用之间保留。'
      + '截图你看不见但有 DOM 大纲；用户在 UI 里能亲眼看到。'
      + '比 httpRequest 慢得多——能 httpRequest 解决就别开浏览器。',
  },
  {
    id: 'core.git',
    name: 'Git 操作',
    description: '调用当前已打开仓库的 Git 命令（status/diff/log/checkout 等）',
    icon: 'branch',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: true,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: false, manual: true, keywords: ['提交', '分支', 'commit', '合并', 'diff'] },
    systemPrompt:
      'gitOperation({op, args?}) 支持 op = "status" | "diff" | "log" | "checkout"。'
      + '调用前确认仓库已打开。',
  },
  {
    id: 'opt.search',
    name: '搜索代码',
    description: '跨文件搜索字符串（最多返回 200 条命中）',
    icon: 'search',
    enabled: true,
    category: 'optional',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: true,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: false,
    },
    trigger: { auto: true, manual: true, keywords: ['搜索', '查找', '哪里用到', 'grep'] },
    systemPrompt:
      'searchCode({query, fileTypes?}) 在项目里全文搜索。'
      + '返回 file/line/text。可选 fileTypes 是逗号分隔后缀，如 ".ts,.tsx"。',
  },
  {
    id: 'core.memory',
    name: '项目记忆',
    description: '让 AI 维护一份每个项目的 Markdown 笔记。每轮对话都会自动塞给 AI，AI 自己写、自己更新。用户可在「记忆」页查看与删除。',
    icon: 'file',
    enabled: true,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: false,
      canSearchCode: false,
      canAccessGit: false,
      canMakeHttpRequests: false,
      canUseBrowser: false,
      canAccessMemory: true,
    },
    trigger: {
      auto: true,
      manual: true,
      keywords: ['记忆', '笔记', '记一下', '记录', '架构', 'memory'],
    },
    systemPrompt:
      'readMemory() 重读、writeMemory({content}) 整体覆盖、appendMemory({content}) 追加一段。'
      + '第一次接触新项目：先 readFileTree/readFile/searchCode 看一遍，再 writeMemory 写下架构概览、关键文件、约定。'
      + '后续每轮：发现新知识 appendMemory；旧的错了 writeMemory 重写。'
      + '上限 64KB，保持精简，**只记跨会话有用的**。',
  },
];

// Canonical permission key set. Adding a new permission? Append it here AND
// add the field to SkillPermissions in shared/types.ts. The migration step
// in normalizePermissions() will then auto-default the new key to false on
// every skill loaded from an older skills.json — old users don't have to
// manually re-toggle anything.
const CANONICAL_PERM_KEYS: (keyof Skill['permissions'])[] = [
  'canReadFiles',
  'canWriteFiles',
  'canRunTerminal',
  'canSearchCode',
  'canAccessGit',
  'canMakeHttpRequests',
  'canUseBrowser',
  'canAccessMemory',
];

/** Coerce arbitrary persisted permission objects into the current
 *  canonical shape: drop unknown / removed keys (e.g. canAccessLogs from
 *  the deleted log-capture system), default any missing-but-canonical
 *  key to false. Defensive against both forward and backward drift. */
function normalizePermissions(raw: unknown): Skill['permissions'] {
  const out: Record<string, boolean> = {};
  const src = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  for (const k of CANONICAL_PERM_KEYS) {
    out[k] = src[k] === true;
  }
  return out as unknown as Skill['permissions'];
}

function isSkill(x: unknown): x is Skill {
  if (!x || typeof x !== 'object') return false;
  const s = x as Skill;
  return (
    typeof s.id === 'string'
    && typeof s.name === 'string'
    && typeof s.description === 'string'
    && typeof s.icon === 'string'
    && typeof s.enabled === 'boolean'
    && (s.category === 'core' || s.category === 'optional' || s.category === 'custom')
    && s.permissions !== null
    && typeof s.permissions === 'object'
    && s.trigger !== null
    && typeof s.trigger === 'object'
    && Array.isArray(s.trigger.keywords)
    && typeof s.systemPrompt === 'string'
  );
}

// Drop garbage entries silently rather than throwing — a corrupt skills.json
// must never crash the dev panel; worst case the user re-toggles things.
function loadFromDisk(): Skill[] | null {
  try {
    if (!existsSync(SKILLS_PATH)) return null;
    const raw = readFileSync(SKILLS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillsFile>;
    if (!parsed || !Array.isArray(parsed.skills)) return null;
    // Run each persisted skill through the permission normaliser so
    // legacy keys (canAccessLogs) get dropped and newly-introduced
    // keys default to false. Without this an upgrade leaves old users
    // unable to ever enable new permissions even if they re-toggle the
    // skill — the missing field would just be undefined.
    return parsed.skills
      .filter(isSkill)
      .map((s) => ({ ...s, permissions: normalizePermissions(s.permissions) }));
  } catch {
    return null;
  }
}

function writeToDisk(skills: Skill[]): void {
  const dir = dirname(SKILLS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: SkillsFile = {
    updatedAt: new Date().toISOString(),
    skills,
  };
  writeFileSync(SKILLS_PATH, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
}

export function readSkills(): Skill[] {
  const onDisk = loadFromDisk();
  if (!onDisk) {
    // First boot — seed and persist so the file shows up where the user
    // expects it (matches BUILTIN_SKILLS exactly).
    try {
      writeToDisk(BUILTIN_SKILLS);
    } catch {
      /* best-effort */
    }
    return BUILTIN_SKILLS;
  }

  // Re-introduce any builtin the user accidentally nuked. Keep their custom
  // edits to existing builtins (enabled flag, etc.) by NOT overwriting when
  // the id is already present.
  const seenIds = new Set(onDisk.map((s) => s.id));
  const merged = [...onDisk];
  let changed = false;
  for (const seed of BUILTIN_SKILLS) {
    if (!seenIds.has(seed.id)) {
      merged.push(seed);
      changed = true;
    }
  }
  // Always rewrite when the normalised form differs from what's on disk —
  // that catches BOTH a new builtin being merged in AND the silent
  // permission-shape migration done in loadFromDisk(). Without this the
  // app heals in memory but disk stays stale, and the next "did we drop
  // the dead permission?" check still surfaces the leftover key.
  let needsRewrite = changed;
  if (!needsRewrite) {
    try {
      const raw = readFileSync(SKILLS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SkillsFile>;
      const fresh = JSON.stringify(merged);
      const old = JSON.stringify(parsed.skills ?? []);
      if (fresh !== old) needsRewrite = true;
    } catch {
      /* if we can't compare, just rewrite — safer */
      needsRewrite = true;
    }
  }
  if (needsRewrite) {
    try {
      writeToDisk(merged);
    } catch {
      /* best-effort */
    }
  }
  return merged;
}

export function writeSkills(skills: Skill[]): Skill[] {
  // Validate, drop bad entries, force-keep builtin core skills (cannot delete
  // a core skill via the API — only toggle `enabled`).
  const clean = skills.filter(isSkill);
  const cleanIds = new Set(clean.map((s) => s.id));
  for (const seed of BUILTIN_SKILLS) {
    if (seed.category === 'core' && !cleanIds.has(seed.id)) {
      clean.push(seed);
    }
  }
  writeToDisk(clean);
  return clean;
}
