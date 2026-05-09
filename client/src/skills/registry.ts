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
      + '动态页面（SPA、需登录、需 JS 渲染）拿不到完整 DOM，能看到的只有原始 HTML。'
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
      '你能驱动真·Chromium：browserNavigate({url}) 打开，browserClick / browserType 操作，'
      + 'browserGetContent({selector?}) 读渲染后的文字，browserGetConsole() 读 F12 全部消息，'
      + 'browserScreenshot({fullPage?, selector?}) 存图到 .gittttt/screenshots/。'
      + '会话连续：cookie / localStorage 在调用之间保留。'
      + '截图你看不见，但回参里有 DOM 大纲（标题、按钮、输入框、首段文字）够你做大多数判断；'
      + '用户在 UI 里能亲眼看到截图。'
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
      '你有一份项目记忆（Markdown），存在 ~/.gittttt/notes/，跟项目路径绑定，项目删了也不会丢。'
      + '每次对话开头我已经把它注入到你的系统 prompt 了，你直接用即可。'
      + 'readMemory() 重读、writeMemory({content}) 整体覆盖、appendMemory({content}) 追加一段。'
      + '**第一次接触新项目**：先用工具看一遍结构（readFileTree/readFile/searchCode），然后 writeMemory 写下架构概览、关键文件、约定。'
      + '**后续每轮**：发现值得长期保留的新知识就 appendMemory（一两行就够）；发现旧记忆错了就 writeMemory 整体重写。'
      + '保持精简：上限 64KB，超了会被截断。**别记日志、别记一次性问题**——只记跨会话有用的。',
  },
];
