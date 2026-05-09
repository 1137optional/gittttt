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
      canAccessLogs: true,
      canSearchCode: false,
      canAccessGit: false,
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
      canAccessLogs: false,
      canSearchCode: false,
      canAccessGit: false,
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
      canAccessLogs: false,
      canSearchCode: false,
      canAccessGit: false,
    },
    trigger: { auto: false, manual: true, keywords: ['修改', '创建', '写入', 'fix'] },
    systemPrompt:
      'writeFile({path, content}) 整体覆盖文件；deleteFile({path}) 删除单个文件。'
      + '给用户做修改前，请用 readFile 确认你看到的是最新内容；改完简短说明改了什么、为何这么改。',
  },
  {
    id: 'core.terminal',
    name: '执行命令',
    description: '在项目根目录下跑 shell 命令（30s 超时，危险命令会被拦）',
    icon: 'play',
    enabled: false,
    category: 'core',
    permissions: {
      canReadFiles: false,
      canWriteFiles: false,
      canRunTerminal: true,
      canAccessLogs: false,
      canSearchCode: false,
      canAccessGit: false,
    },
    trigger: { auto: false, manual: true, keywords: ['运行', '执行', 'npm', 'yarn', 'pnpm'] },
    systemPrompt:
      'runCommand({command}) 在项目根执行。结果含 stdout / stderr / exitCode。'
      + '不要重复执行同一条命令；如果要长时间跑的命令（dev server）请告诉用户手动起。',
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
      canAccessLogs: false,
      canSearchCode: false,
      canAccessGit: true,
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
      canAccessLogs: false,
      canSearchCode: true,
      canAccessGit: false,
    },
    trigger: { auto: true, manual: true, keywords: ['搜索', '查找', '哪里用到', 'grep'] },
    systemPrompt:
      'searchCode({query, fileTypes?}) 在项目里全文搜索。'
      + '返回 file/line/text。可选 fileTypes 是逗号分隔后缀，如 ".ts,.tsx"。',
  },
];

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
    return parsed.skills.filter(isSkill);
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
  if (changed) {
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
