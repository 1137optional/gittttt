import type { Skill } from '@shared/types';

// =============================================================================
// Built-in skill registry.
//
// These are the seed entries the server ships when ~/.gittttt/skills.json
// doesn't exist yet (or when a known core skill was removed by accident —
// see the merge logic in skillsStore). The list is intentionally short:
// adding too many "auto" skills muddies the AI's system prompt and burns
// tokens on every call. Users add their own via the SkillsPanel.
// =============================================================================

export const BUILTIN_SKILLS: Skill[] = [
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
