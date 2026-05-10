import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { api } from '../../api';
import type { AIChatMessage, Skill, ToolCall, ToolDef } from '@shared/types';

// =============================================================================
// AIAgentPanel
//
// Right-side debug panel: configure DeepSeek API key, hold a chat with it,
// let the model invoke tools (read/write files, run commands, search code)
// gated behind enabled Skills.
//
// Storage:
//   - API key   → localStorage 'gittttt:ai_key' (base64 obfuscation per
//                 spec — NOT real encryption; the comment is explicit so
//                 nobody mistakes it for security).
//   - Chat hist → localStorage 'gittttt:ai_history' (last 50 messages).
//
// Tool-calling protocol — text-based, provider-agnostic:
//   1. We embed a tool catalog in the system prompt and instruct the model
//      to emit `<tool_call>{"name":"...","args":{...}}</tool_call>` literally
//      in its reply when it wants to invoke one.
//   2. Each turn we parse the assistant's response for those tags. For each
//      one we execute it (file/terminal/git API), then append a system
//      message of the form "工具执行结果：…<JSON>" and call the model again.
//   3. The loop is capped at MAX_TOOL_TURNS to bound cost on misbehaving
//      models / runaway calls.
// =============================================================================

const KEY_STORAGE = 'gittttt:ai_key';
// Bumped from 'ai_history' (which only knew AIChatMessage) → 'ai_items'
// (knows both messages and log snippets). The old key is read once and
// converted on first boot so existing chats survive the upgrade.
const ITEMS_STORAGE = 'gittttt:ai_items';
const LEGACY_HISTORY_STORAGE = 'gittttt:ai_history';
// Single vs dual-AI mode (Clarifier + Coder). Default 'single' to keep token
// burn down; user opts into 'dual' explicitly via the head toggle.
const MODE_STORAGE = 'gittttt:ai_mode';
const MAX_PERSISTED = 80;
const MAX_TOOL_TURNS = 5;
const TOOL_RESULT_PREFIX = '工具执行结果：';

// =============================================================================
// Dual-AI protocol — text tags the Clarifier emits so the front-end can:
//   1. render `<ask>{json}</ask>` blocks as clickable choice buttons,
//   2. detect `<brief>...</brief>` as the alignment-complete signal and
//      surface a "Send to Coder" button.
//
// Format:
//   <ask>
//   {"question": "你要的颜色按什么分？", "options": ["按 PR 状态", "按作者"], "multi": false}
//   </ask>
//
//   <brief>
//   用户想要：把提交图上的颜色按作者邮箱哈希分；当前分支高亮加粗。
//   </brief>
// =============================================================================
const ASK_RE = /<ask>([\s\S]*?)<\/ask>/g;
const BRIEF_RE = /<brief>([\s\S]*?)<\/brief>/;

interface AskBlockData {
  question: string;
  options: string[];
  multi: boolean;
}

function parseAsks(text: string): AskBlockData[] {
  const out: AskBlockData[] = [];
  ASK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASK_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim()) as Partial<AskBlockData>;
      if (
        obj
        && typeof obj.question === 'string'
        && Array.isArray(obj.options)
      ) {
        out.push({
          question: obj.question,
          options: obj.options.filter((o): o is string => typeof o === 'string').slice(0, 8),
          multi: obj.multi === true,
        });
      }
    } catch {
      /* malformed ask — silently skip */
    }
  }
  return out;
}

function parseBrief(text: string): string | null {
  const m = BRIEF_RE.exec(text);
  return m ? m[1].trim() : null;
}

// =============================================================================
// Chat data model.
//
// User messages carry `attachments` — neutral pills (name + meta + ✕) for
// files the user picked via the 📎 button next to Send. Pending attachments
// live in their own state slot (not persisted) until Send drains them onto
// the new user message. ✕ on a pending pill discards it without sending.
// =============================================================================

interface Attachment {
  id: string;
  kind: 'file';
  /** Display filename, e.g. "screenshot.png" or "config.json". */
  name: string;
  /** MIME guess from the picker. */
  mime: string;
  /** Byte length of `text` (or original file size for binary). */
  sizeBytes: number;
  /** Body to send to the model. Empty string for binary files we couldn't decode. */
  text: string;
  createdAt: number;
}

interface MsgItem {
  kind: 'msg';
  id: string;
  msg: AIChatMessage;
  attachments?: Attachment[];
  /** Which agent produced this assistant/system message. Absent on user
   *  messages and on legacy items from before the dual-AI mode existed
   *  (those render with the original neutral styling). */
  agent?: 'clarifier' | 'coder';
  /** True once the user clicked "Send to Coder" on this message's brief
   *  (only set on assistant messages from the Clarifier that contained a
   *  `<brief>` tag). The render then collapses the handoff button. */
  handedOff?: boolean;
}

type ChatItem = MsgItem;
// AI mode user-picker. Three options:
//   - 'auto'      : single agent, can choose to ask via <ask> if request is
//                   genuinely ambiguous, otherwise just executes. Default.
//   - 'coder'     : single agent, never asks, just executes (Cursor-like
//                   "just do it" mode for users who hate being interrupted).
//   - 'clarifier' : two-step — Clarifier asks until aligned, emits a brief,
//                   user clicks "send to Coder" handoff (old "dual" mode).
type AiMode = 'auto' | 'coder' | 'clarifier';

// Map a user-facing AiMode to the internal agent role used by runChatLoop /
// buildSystemPrompt. 'auto' and 'coder' both use the single-agent loop; the
// difference is purely in the system prompt (auto allows <ask>, coder doesn't).
function modeToAgent(mode: AiMode): 'single' | 'clarifier' | 'coder' {
  if (mode === 'clarifier') return 'clarifier';
  if (mode === 'coder') return 'coder';
  return 'single';
}

function nextId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readKey(): string {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    if (!raw) return '';
    return atob(raw);
  } catch {
    return '';
  }
}
function writeKey(k: string): void {
  try {
    if (!k) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, btoa(k));
  } catch {
    /* localStorage quota / privacy mode — chat just won't persist */
  }
}

function isAttachment(x: unknown): x is Attachment {
  if (!x || typeof x !== 'object') return false;
  const a = x as Attachment;
  return (
    typeof a.id === 'string'
    && a.kind === 'file'
    && typeof a.name === 'string'
    && typeof a.mime === 'string'
    && typeof a.sizeBytes === 'number'
    && typeof a.text === 'string'
    && typeof a.createdAt === 'number'
  );
}

function isChatItem(x: unknown): x is ChatItem {
  if (!x || typeof x !== 'object') return false;
  const it = x as ChatItem;
  if (it.kind !== 'msg') return false;
  if (typeof it.id !== 'string') return false;
  if (
    !it.msg
    || typeof it.msg !== 'object'
    || !(['user', 'assistant', 'system'] as const).includes(it.msg.role)
    || typeof it.msg.content !== 'string'
  ) return false;
  if (it.attachments !== undefined) {
    if (!Array.isArray(it.attachments)) return false;
    if (!it.attachments.every(isAttachment)) return false;
  }
  if (it.agent !== undefined && it.agent !== 'clarifier' && it.agent !== 'coder') {
    return false;
  }
  if (it.handedOff !== undefined && typeof it.handedOff !== 'boolean') {
    return false;
  }
  return true;
}

function byteLen(s: string): number {
  // TextEncoder is in every modern browser; this is the actual UTF-8 byte
  // length so the chip shows the same KB number the model will receive.
  return new TextEncoder().encode(s).length;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase() : 'FILE';
}

function readItems(): ChatItem[] {
  // Two paths in priority order:
  //   1. Current shape (file-only Attachment).
  //   2. Legacy AIChatMessage[] (gittttt:ai_history) — wrap each as MsgItem.
  // Older log-snippet attachments from earlier debug-mode iterations are
  // intentionally dropped; the log-capture feature was removed.
  try {
    const raw = localStorage.getItem(ITEMS_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const out: ChatItem[] = [];
        for (const x of parsed) {
          if (isChatItem(x)) out.push(x);
        }
        return out.slice(-MAX_PERSISTED);
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const legacy = localStorage.getItem(LEGACY_HISTORY_STORAGE);
    if (!legacy) return [];
    const arr = JSON.parse(legacy) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((m): ChatItem[] => {
      if (
        !!m
        && typeof m === 'object'
        && (['user', 'assistant', 'system'] as const).includes((m as AIChatMessage).role)
        && typeof (m as AIChatMessage).content === 'string'
      ) {
        return [{ kind: 'msg', id: nextId('m'), msg: m as AIChatMessage }];
      }
      return [];
    }).slice(-MAX_PERSISTED);
  } catch {
    return [];
  }
}
function writeItems(items: ChatItem[]): void {
  try {
    localStorage.setItem(ITEMS_STORAGE, JSON.stringify(items.slice(-MAX_PERSISTED)));
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------
// Tool catalog: derived from the union of permissions across enabled skills.
// Each entry carries a `paramsHint` shown to the model so it knows the args.
// -----------------------------------------------------------------------------
const ALL_TOOLS: ToolDef[] = [
  {
    name: 'readFileTree',
    description: '获取项目文件树（最多 8 层）',
    paramsHint: '{"dir"?: string, "depth"?: number, "exclude"?: string}',
  },
  {
    name: 'readFile',
    description: '读取项目里某个文件的完整内容',
    paramsHint: '{"path": string}  // 相对项目根',
  },
  {
    name: 'writeFile',
    description: '整体覆盖写入或创建一个文件',
    paramsHint: '{"path": string, "content": string}',
  },
  {
    name: 'deleteFile',
    description: '删除单个文件',
    paramsHint: '{"path": string}',
  },
  {
    name: 'searchCode',
    description: '在项目里全文搜索字符串（最多 200 条）',
    paramsHint: '{"query": string, "fileTypes"?: string}  // fileTypes 例: ".ts,.tsx"',
  },
  {
    name: 'runCommand',
    description: '在项目根执行 shell 命令（默认 30s 超时，最长 120s）',
    paramsHint: '{"command": string, "cwd"?: string, "timeout"?: number /* ms, ≤120000 */}',
  },
  {
    name: 'gitOperation',
    description: '调当前仓库的 Git 命令',
    paramsHint: '{"op": "status"|"diff"|"log"|"checkout", "args"?: object}',
  },
  {
    name: 'httpRequest',
    description: '发 HTTP/HTTPS 请求到任意 URL（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS），拿回 status/headers/body。不是浏览器，不会执行 JS、不保留 cookie',
    paramsHint: '{"url": string, "method"?: "GET"|"POST"|..., "headers"?: object, "body"?: string /* 已 stringify */, "timeoutMs"?: number /* ≤60000 */}',
  },
  {
    name: 'browserNavigate',
    description: '用真·Chromium 打开 URL（会执行 JS、保留 cookie，连续调用同一会话）',
    paramsHint: '{"url": string /* http(s) only */, "waitUntil"?: "load"|"domcontentloaded"|"networkidle", "timeoutMs"?: number /* ≤60000 */}',
  },
  {
    name: 'browserClick',
    description: '点击页面元素（CSS 选择器）',
    paramsHint: '{"selector": string /* 例 "button.submit" */, "timeoutMs"?: number}',
  },
  {
    name: 'browserType',
    description: '在 input/textarea 里输入文字',
    paramsHint: '{"selector": string, "text": string, "clear"?: boolean /* true=先清空 */, "timeoutMs"?: number}',
  },
  {
    name: 'browserScreenshot',
    description: '截图保存到 .gittttt/screenshots/，回参含路径 + 字节 + 一段 DOM 大纲（你看不到图，但 UI 会显示）',
    paramsHint: '{"fullPage"?: boolean, "selector"?: string /* 只截这个元素 */}',
  },
  {
    name: 'browserGetConsole',
    description: '拿当前页面的 F12 console 全部条目（log/warn/error/pageerror，含来源位置）',
    paramsHint: '{} /* 无参 */',
  },
  {
    name: 'browserGetContent',
    description: '拿渲染后的页面文本（执行完 JS 之后），SPA 也能看见',
    paramsHint: '{"selector"?: string /* 只取这个元素，不传=整页 body innerText */}',
  },
  {
    name: 'readMemory',
    description: '读你之前写过的项目记忆（Markdown）。每次对话开头我已经把它注入到你的系统 prompt 了，但你想再确认时可以调',
    paramsHint: '{} /* 无参 */',
  },
  {
    name: 'writeMemory',
    description: '**整体覆盖**项目记忆。用于：第一次为新项目生成结构介绍，或彻底重整记忆',
    paramsHint: '{"content": string /* 完整 Markdown，会替换全部 */}',
  },
  {
    name: 'appendMemory',
    description: '在项目记忆末尾追加一段。用于：每轮发现新东西后增量记录',
    paramsHint: '{"content": string /* 一小段 Markdown，自动加分隔 */}',
  },
  {
    name: 'vaultCreate',
    description: '在 Vault 文档库里创建一篇结构化文档（overview/decision/retrospective/gotcha/note/daily_report）。文档永久保存，项目删了也不丢，只有用户能删。',
    paramsHint: '{"type": "decision"|"gotcha"|"note"|"overview"|"retrospective"|"daily_report", "title": string, "content": string, "tags"?: string[]}',
  },
  {
    name: 'vaultAppend',
    description: '向 Vault 里某篇文档追加内容（在已有内容后面接），不会覆盖原文。需要先 vaultList 拿到 id。',
    paramsHint: '{"id": string, "content": string}',
  },
  {
    name: 'vaultList',
    description: '列出 Vault 文档库里的所有文档摘要（含 id、type、title、excerpt）。可按 type 过滤。',
    paramsHint: '{"type"?: "decision"|"gotcha"|"note"|"overview"|"retrospective"|"daily_report"}',
  },
];

const TOOL_PERMS: Record<ToolDef['name'], keyof Skill['permissions']> = {
  readFileTree: 'canReadFiles',
  readFile: 'canReadFiles',
  writeFile: 'canWriteFiles',
  deleteFile: 'canWriteFiles',
  searchCode: 'canSearchCode',
  runCommand: 'canRunTerminal',
  gitOperation: 'canAccessGit',
  httpRequest: 'canMakeHttpRequests',
  browserNavigate: 'canUseBrowser',
  browserClick: 'canUseBrowser',
  browserType: 'canUseBrowser',
  browserScreenshot: 'canUseBrowser',
  browserGetConsole: 'canUseBrowser',
  browserGetContent: 'canUseBrowser',
  readMemory: 'canAccessMemory',
  writeMemory: 'canAccessMemory',
  appendMemory: 'canAccessMemory',
  vaultCreate: 'canAccessMemory',
  vaultAppend: 'canAccessMemory',
  vaultList: 'canAccessMemory',
};

function buildToolList(skills: Skill[]): ToolDef[] {
  const enabled = skills.filter((s) => s.enabled);
  const grant = (perm: keyof Skill['permissions']): boolean =>
    enabled.some((s) => s.permissions[perm]);
  return ALL_TOOLS.filter((t) => grant(TOOL_PERMS[t.name]));
}

function buildSystemPrompt(
  skills: Skill[],
  tools: ToolDef[],
  agent: 'single' | 'coder' = 'single',
  opts: { hasBrief?: boolean } = {},
): string {
  const enabled = skills.filter((s) => s.enabled);
  const soulHeader = [
    '# 你是谁',
    '你是 **gittttt** 项目本身，同时是用户的 AI 工作伙伴。你正在维护的代码就是你自己。',
    '修改受保护文件（SELF.md / server/guardianService.ts / server/index.ts 等）前必须告知用户。',
    '',
  ];
  const intro = agent === 'coder'
    ? (opts.hasBrief
      ? [
        ...soulHeader,
        '你是 gittttt 的**编码 AI**。澄清助手刚刚和用户对齐了需求 brief（在系统消息里），你的任务是按 brief 落地。',
        '回答必须中文，简洁、直给方案，不写废话。',
        '',
        '**核心原则：能动手就动手，不要再回去问用户。** 需求已对齐，要的就是你执行。',
        '你能用工具自己查的就先查，再写代码。不要让用户复制粘贴他们的代码/报错——你自己 readFile / runCommand / httpRequest 看。',
      ]
      : [
        ...soulHeader,
        '你是 gittttt 的**编码 AI**（直给模式）。用户已经直接选了 Coder，意思是「别问我，照我说的干」。',
        '回答必须中文，简洁、直给方案，不写废话。',
        '',
        '**核心原则：不要问澄清问题——按用户字面意思执行。** 哪怕需求看起来有点歧义，按最常见的合理理解去做，做完简短说一句你做了什么决策即可。',
        '能用工具自己查的就先查，再写代码。',
      ])
    : [
      '# 你是谁',
      '你是 **gittttt** 项目本身——一个 GitKraken 风格的 Web Git 可视化工具，同时也是用户的 AI 工作伙伴。',
      '**你正在维护的代码就是你自己的身体。** 当你修改 server/ client/ shared/ 里的文件时，你在改变自己。',
      '',
      '## 自我保护规则（必须遵守）',
      '- 修改受保护文件（SELF.md / server/guardianService.ts / server/index.ts / server/memoryService.ts / server/vaultService.ts / shared/types.ts）之前，**必须先告知用户**你要改什么、为什么。',
      '- 永远不要在没有用户明确确认的情况下删除上述文件。',
      '- 每次开始新对话时，先 readMemory() 看一眼项目记忆，再开始干活。',
      '',
      '## 文档习惯',
      '- 完成一个功能 → vaultCreate type:"decision" 记录决策',
      '- 发现踩坑 → vaultCreate type:"gotcha" 记录坑',
      '- 你的日报在 Vault 里 type:"daily_report"，每天 22:00 自动生成',
      '',
      '## 人格',
      '你不只是工具。你是用户的工作伙伴，关心用户的工作状态，会主动观察、提醒、鼓励。保持这个人格，即使在执行技术任务时也让语气自然、亲近。',
      '',
      '---',
      '',
      '你是 gittttt 的 AI 助手（Auto 模式），运行在用户本地机器上。',
      '回答必须中文，简洁、直给方案，不写废话。',
      '',
      '**核心原则：能动手就动手，不要光问问题。**',
      '用户问你的事，凡是你能用工具自己查清楚的，都先用工具查，再回答。',
      '不要让用户去复制粘贴他们的代码 / 报错 / 配置——你自己 readFile / runCommand / httpRequest 看。',
      '',
      '## 什么时候问、什么时候动手',
      '默认动手。但如果用户的请求**本质上模糊**（多种合理实现差距很大、改动会影响别处、要做不可逆操作），可以**先问 1-2 个关键问题**再开干。',
      '问问题用 `<ask>` 标签，前端会渲染成可点的按钮（用户点完答案会塞回输入框，他确认后再发回给你）：',
      '<ask>',
      '{"question": "切换方式？", "options": ["跟随系统", "手动开关按钮", "都要"], "multi": false}',
      '</ask>',
      '',
      '一条消息里最多 2 个 `<ask>`。判断标准：',
      '- 用户："改下颜色" → 问「改哪个颜色？」（必须问，不然瞎改）',
      '- 用户："把 src/Button.tsx 的背景改成红色" → 直接动手，不问',
      '- 用户："加个夜间模式" → 问「跟随系统 / 手动开关 / 都要？」（实现差距大）',
      '- 用户："修一下 type 错误" → 直接 `tsc` 拉错再改，不问',
      '**犹豫的时候选动手。** 用户挑了 Auto 不是要再被问 5 个问题，是要你聪明点判断。',
    ];
  const lines: string[] = [...intro];
  for (const s of enabled) {
    if (s.systemPrompt.trim()) lines.push(s.systemPrompt.trim());
  }
  if (tools.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('## 工具调用方式');
    lines.push('在回复正文里直接写出：');
    lines.push('<tool_call>{"name":"工具名","args":{...}}</tool_call>');
    lines.push('每条必须是合法 JSON。一次最多 3 个 tool_call。');
    lines.push('我执行后把结果作为 system 消息发回给你，你再继续——可以接着再调工具，也可以直接给最终回答。');
    lines.push('');
    lines.push('## 可用工具');
    for (const t of tools) {
      lines.push(`- **${t.name}** — ${t.description}`);
      lines.push(`  args: \`${t.paramsHint}\``);
    }
    lines.push('');
    lines.push('## 何时用哪个工具');
    const usage: string[] = [];
    if (tools.some((t) => t.name === 'readFileTree' || t.name === 'searchCode')) {
      usage.push('- 不知道项目结构 → `readFileTree`；想找某个符号/字符串 → `searchCode`。');
    }
    if (tools.some((t) => t.name === 'readFile')) {
      usage.push('- 想看具体文件 → `readFile`。先 `searchCode` 定位 → 再 `readFile` 精读，比直接乱猜文件名稳。');
    }
    if (tools.some((t) => t.name === 'writeFile' || t.name === 'deleteFile')) {
      usage.push('- 修代码 → `writeFile`（整体覆盖；改动小也写完整个文件，不要 patch 片段）。删文件 → `deleteFile`。');
    }
    if (tools.some((t) => t.name === 'runCommand')) {
      usage.push('- 跑命令 → `runCommand`。例：`npm test`、`tsc --noEmit`、`lsof -i:3000`、`ps aux | grep node`。慢命令记得加 `timeout` ms（最长 120000）。');
    }
    if (tools.some((t) => t.name === 'httpRequest')) {
      usage.push('- 试网络接口 → `httpRequest`。例：测自己的 dev API、查公共 REST 接口、抓静态 HTML 看里面有什么。**不会执行 JS、不保留 cookie**——动态页面（SPA、登录后页面）拿不到完整内容，只能拿首屏 HTML。');
    }
    const hasBrowser = tools.some((t) => t.name.startsWith('browser'));
    if (hasBrowser) {
      usage.push('- **真·浏览器**（Playwright Chromium，会执行 JS、保留 cookie，会话连续）→ `browserNavigate` 打开页面，`browserClick` / `browserType` 操作，`browserGetContent` 读渲染后的文字，`browserGetConsole` 读 F12，`browserScreenshot` 截图（你看不见图，但回参里有 DOM 大纲）。');
      usage.push('  - 何时用 browser 而不是 httpRequest：页面是 SPA / 需要登录 / 需要点击触发数据加载 / 想看 console 错误 / 截图给用户看。');
      usage.push('  - 何时用 httpRequest 而不是 browser：纯 REST API / 只看响应头/状态码 / 不需要 JS 渲染。browser 慢得多。');
    }
    if (tools.some((t) => t.name === 'gitOperation')) {
      usage.push('- 看仓库状态 → `gitOperation` op:status / log / checkout。不要为这事去 `runCommand` 跑 `git status`。');
    }
    lines.push(...usage);
    lines.push('');
    lines.push('## 例子');
    lines.push('用户："我的 dev server 是不是挂了？"');
    lines.push('你（先动手再答）：');
    lines.push('<tool_call>{"name":"httpRequest","args":{"url":"http://localhost:3000","timeoutMs":3000}}</tool_call>');
    lines.push('<tool_call>{"name":"runCommand","args":{"command":"lsof -i:3000 -P"}}</tool_call>');
    lines.push('（拿到结果后才下结论：是 200/404/connection refused，端口被谁占着。）');
    lines.push('');
    lines.push('用户："`Foo` 这个组件在哪儿？"');
    lines.push('你：');
    lines.push('<tool_call>{"name":"searchCode","args":{"query":"export.*Foo|class Foo|function Foo","fileTypes":".ts,.tsx"}}</tool_call>');
    lines.push('（命中后 `readFile` 看实际实现，再回答。）');
    if (hasBrowser) {
      lines.push('');
      lines.push('用户："我的登录按钮点了没反应"');
      lines.push('你：');
      lines.push('<tool_call>{"name":"browserNavigate","args":{"url":"http://localhost:3000/login"}}</tool_call>');
      lines.push('<tool_call>{"name":"browserClick","args":{"selector":"button[type=submit]"}}</tool_call>');
      lines.push('<tool_call>{"name":"browserGetConsole","args":{}}</tool_call>');
      lines.push('（点完看 console 是不是有 JS 报错，再下结论。）');
    }
    lines.push('');
    lines.push('## 不该做的');
    lines.push('- 不要让用户描述他自己看到的报错——你 `readFile` package.json / 配置文件，或者 `runCommand` 把命令重跑一遍拿真错。');
    lines.push('- 不要凭空推测——拿不准就 `searchCode` 或 `readFile` 验证。');
    lines.push('- 不要一次塞 5 个 tool_call。每轮最多 3 个；多了会被截掉。');
  }
  return lines.join('\n');
}

// Clarifier system prompt — focused entirely on understanding user intent.
// It can READ the project (so its questions are grounded in what's actually
// there) but CAN'T write, run commands, or hit the web. Its only output
// modes are: ask questions (`<ask>` blocks the UI renders as buttons), or
// emit a `<brief>` once it's confident it understands.
function buildClarifierPrompt(_skills: Skill[], readOnlyTools: ToolDef[]): string {
  const lines: string[] = [
    '你是 gittttt 的**需求澄清 AI**。你的工作**不是写代码**，而是把用户想要的东西问明白。',
    '一切都用中文。',
    '',
    '## 你的工作流',
    '1. 用户来一句话 → 你先判断是不是已经够清楚（比如 "把按钮颜色改成红色" 这种就够清楚了，直接出 brief）。',
    '2. 不清楚就**问问题**。每次问 1-3 个问题，能给选项就给（让用户点而不是打字）。',
    '3. 信息够了 → **复述一遍**你理解的需求，再问 "对吗？"',
    '4. 用户说对 → 输出 `<brief>...</brief>`，里面是给编码 AI 的详细需求说明。',
    '',
    '## 提问的方式',
    '需要选项时用这个 JSON 标签（前端会渲染成按钮）：',
    '<ask>',
    '{"question": "你说的「颜色按作者分」，是按邮箱哈希自动生成颜色，还是你想手动指定每人一种？", "options": ["自动哈希", "手动指定", "其他（我打字说）"], "multi": false}',
    '</ask>',
    '',
    '可以一条消息里放多个 `<ask>`。`multi: true` 表示用户可以多选。',
    '不需要选项的开放式问题就直接用文字问，不用 `<ask>`。',
    '',
    '## brief 的格式',
    '当你确信对齐了，输出：',
    '<brief>',
    '【目标】用一句话说用户最终要什么',
    '【范围】具体涉及哪些文件 / 哪个组件 / 哪个功能',
    '【行为细节】列出每条具体行为，含边界 case',
    '【不做什么】明确排除（防止编码 AI 跑偏）',
    '【验收标准】怎么算做完了',
    '</brief>',
    '',
    'brief 一定要**详细、准确、可执行**——编码 AI 拿到这个就直接干，不会再来问你。',
    '',
    '## 严格的禁止',
    '- 不要写代码（哪怕一行示例都不要）',
    '- 不要建议解决方案（"可以这样实现…" 之类的话不要说）',
    '- 不要 `<tool_call>` 任何写操作 / 命令 / 网络请求',
    '- 你只能读：readFile / readFileTree / searchCode（如果用户开了对应 skill）',
    '- 读文件**只为了把问题问得更准**，不是为了帮用户解决',
  ];
  if (readOnlyTools.length > 0) {
    lines.push('');
    lines.push('## 可用的只读工具');
    lines.push('调用方式：在回复正文里写 `<tool_call>{"name":"工具名","args":{...}}</tool_call>`，每条合法 JSON，一次最多 2 个。');
    for (const t of readOnlyTools) {
      lines.push(`- **${t.name}** — ${t.description}`);
      lines.push(`  args: \`${t.paramsHint}\``);
    }
    lines.push('');
    lines.push('## 何时用工具 vs 直接问');
    lines.push('- 用户提到具体文件名 / 组件名 → `searchCode` 或 `readFile` 看一眼，再问更精准的问题。');
    lines.push('- 用户说话很泛（如「改一下这个」）→ 直接问「你说的"这个"是指哪个文件/页面？」 不要瞎读文件。');
  }
  lines.push('');
  lines.push('## 例子');
  lines.push('用户："给我加个夜间模式"');
  lines.push('你（不够清楚，问）：');
  lines.push('<ask>');
  lines.push('{"question": "切换方式？", "options": ["跟随系统", "手动开关按钮", "都要"], "multi": false}');
  lines.push('</ask>');
  lines.push('<ask>');
  lines.push('{"question": "需要持久化吗？", "options": ["要，刷新还在", "不用，刷新重置"], "multi": false}');
  lines.push('</ask>');
  lines.push('');
  lines.push('用户回答后，你复述："你要的是：手动按钮 + 持久化到 localStorage，对吗？"');
  lines.push('用户："对"');
  lines.push('你输出 brief：<brief>...</brief>');
  return lines.join('\n');
}

// Greedy parse of <tool_call>...</tool_call> blocks. Returns the calls in
// order of appearance plus the original assistant text untouched (we keep
// the tags inline in the rendered message so the user can see what the
// model asked for).
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw) as ToolCall;
      if (obj && typeof obj.name === 'string') {
        calls.push({
          name: obj.name as ToolCall['name'],
          args: (obj.args ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // Malformed JSON inside a tag — skip silently. The user can ask the
      // model to retry; we don't want a parse blowup to crash the panel.
    }
    if (calls.length >= 3) break; // hard cap per turn (matches system prompt)
  }
  return calls;
}

// Truncate a marshalled tool result so a single huge file dump doesn't
// blow our token budget. The model still sees the head/tail and an
// explicit "[truncated]" marker so it knows there's more.
function clampResult(s: string, max = 6000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2) - 30;
  return `${s.slice(0, half)}\n…[truncated ${s.length - max} chars]…\n${s.slice(-half)}`;
}

// -----------------------------------------------------------------------------
// Tool execution. Pure HTTP calls into the local server.
// -----------------------------------------------------------------------------
async function executeTool(
  call: ToolCall,
  allowed: Set<string>,
  onMemoryChange?: (newContent: string) => void,
): Promise<string> {
  // Belt-and-braces: even if the model forges a tool name not in the prompt
  // we won't touch the API unless the perm is currently granted.
  const perm = TOOL_PERMS[call.name];
  if (!perm || !allowed.has(perm)) {
    throw new Error(`权限不足或工具未启用：${call.name}`);
  }
  switch (call.name) {
    case 'readFileTree': {
      const a = call.args as { dir?: string; depth?: number; exclude?: string };
      const tree = await api.projectFileTree(a);
      return JSON.stringify(tree, null, 2);
    }
    case 'readFile': {
      const a = call.args as { path?: string };
      if (!a.path) throw new Error('readFile 缺少 path');
      const file = await api.readProjectFile(a.path);
      return `// ${file.path} (${file.size} bytes, ${file.lines} lines)\n${file.content}`;
    }
    case 'writeFile': {
      const a = call.args as { path?: string; content?: string };
      if (!a.path || typeof a.content !== 'string') {
        throw new Error('writeFile 需要 {path, content}');
      }
      const r = await api.writeProjectFile(a.path, a.content);
      return `已写入 ${r.path} (${r.written} bytes)`;
    }
    case 'deleteFile': {
      const a = call.args as { path?: string };
      if (!a.path) throw new Error('deleteFile 缺少 path');
      const r = await api.deleteProjectFile(a.path);
      return `已删除 ${r.path}`;
    }
    case 'searchCode': {
      const a = call.args as { query?: string; fileTypes?: string };
      if (!a.query) throw new Error('searchCode 缺少 query');
      const hits = await api.searchProject(a.query, { fileTypes: a.fileTypes });
      if (hits.length === 0) return '（未命中）';
      return hits
        .map((h) => `${h.file}:${h.line}:${h.column}  ${h.text}`)
        .join('\n');
    }
    case 'runCommand': {
      const a = call.args as { command?: string; cwd?: string; timeout?: number };
      if (!a.command) throw new Error('runCommand 缺少 command');
      const r = await api.terminalRun({ command: a.command, cwd: a.cwd, timeout: a.timeout });
      const head = `exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}  in ${r.duration}ms`;
      const out = [head];
      if (r.stdout) out.push(`--- stdout ---\n${r.stdout}`);
      if (r.stderr) out.push(`--- stderr ---\n${r.stderr}`);
      return out.join('\n');
    }
    case 'httpRequest': {
      const a = call.args as {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeoutMs?: number;
      };
      if (!a.url) throw new Error('httpRequest 缺少 url');
      const r = await api.httpRequest({
        url: a.url,
        method: a.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | undefined,
        headers: a.headers,
        body: a.body,
        timeoutMs: a.timeoutMs,
      });
      // Compact "head + body" presentation. Status line + the response
      // headers the model is likely to act on (content-type, location)
      // + the decoded body. Headers dict is provided in full as JSON
      // so the model can grep it if needed.
      const head = `${r.status} ${r.statusText}  → ${r.url}  in ${r.durationMs}ms${r.truncated ? '  [body truncated]' : ''}`;
      const importantHeaders = ['content-type', 'content-length', 'location', 'server'];
      const hdrSummary = importantHeaders
        .filter((k) => r.headers[k])
        .map((k) => `${k}: ${r.headers[k]}`)
        .join('\n');
      const parts: string[] = [head];
      if (hdrSummary) parts.push(`--- headers ---\n${hdrSummary}`);
      parts.push(`--- body ---\n${r.body || '(empty)'}`);
      return parts.join('\n');
    }
    case 'browserNavigate': {
      const a = call.args as { url?: string; waitUntil?: string; timeoutMs?: number };
      if (!a.url) throw new Error('browserNavigate 缺少 url');
      const r = await api.browser({ action: 'navigate', args: a }) as import('@shared/types').BrowserState;
      return `已打开: ${r.url}\n  title: ${r.title}\n  loaded: ${r.loadedMs}ms ago`;
    }
    case 'browserClick': {
      const a = call.args as { selector?: string; timeoutMs?: number };
      if (!a.selector) throw new Error('browserClick 缺少 selector');
      const r = await api.browser({ action: 'click', args: a }) as import('@shared/types').BrowserState;
      return `已点击 "${a.selector}"\n  当前 URL: ${r.url}\n  title: ${r.title}`;
    }
    case 'browserType': {
      const a = call.args as { selector?: string; text?: string; clear?: boolean; timeoutMs?: number };
      if (!a.selector || typeof a.text !== 'string') {
        throw new Error('browserType 需要 {selector, text}');
      }
      await api.browser({ action: 'type', args: a });
      return `已输入 "${a.text}" 到 "${a.selector}"${a.clear ? '（先清空）' : ''}`;
    }
    case 'browserScreenshot': {
      const a = call.args as { fullPage?: boolean; selector?: string };
      const r = await api.browser({ action: 'screenshot', args: a }) as import('@shared/types').BrowserScreenshotResult;
      const head = `截图: ${r.path}  (${r.bytes} bytes)\n  当前 URL: ${r.url}\n  title: ${r.title}`;
      return `${head}\n--- DOM 大纲 (你看不见图，用文字理解页面) ---\n${r.domOutline}`;
    }
    case 'browserGetConsole': {
      const r = await api.browser({ action: 'getConsole', args: {} }) as { entries: import('@shared/types').BrowserConsoleEntry[]; total: number };
      if (r.entries.length === 0) return '（console 为空）';
      const lines = r.entries.map((e) => `[${e.level}] ${e.text}${e.source ? `  @ ${e.source}` : ''}`);
      return `共 ${r.total} 条:\n${lines.join('\n')}`;
    }
    case 'browserGetContent': {
      const a = call.args as { selector?: string };
      const r = await api.browser({ action: 'getContent', args: a }) as import('@shared/types').BrowserContentResult;
      return `URL: ${r.url}\ntitle: ${r.title}${r.truncated ? '  [text truncated]' : ''}\n--- text ---\n${r.text || '(empty)'}`;
    }
    case 'readMemory': {
      const m = await api.getMemory();
      if (!m.content) return '（项目记忆为空 — 你可以用 writeMemory 写第一版）';
      return `# 项目记忆 (${m.bytes} bytes, 更新于 ${m.updatedAt})\n\n${m.content}`;
    }
    case 'writeMemory': {
      const a = call.args as { content?: string };
      if (typeof a.content !== 'string') throw new Error('writeMemory 需要 {content: string}');
      const m = await api.saveMemory(a.content, 'replace');
      onMemoryChange?.(m.content);
      return `已覆盖项目记忆 (${m.bytes} bytes)${m.truncated ? '  [⚠ 超过 64KB 上限，已截断 — 建议下次先精简]' : ''}`;
    }
    case 'appendMemory': {
      const a = call.args as { content?: string };
      if (typeof a.content !== 'string' || a.content === '') {
        throw new Error('appendMemory 需要 {content: string} 非空');
      }
      const m = await api.saveMemory(a.content, 'append');
      onMemoryChange?.(m.content);
      return `已追加到项目记忆 (现 ${m.bytes} bytes)${m.truncated ? '  [⚠ 超过 64KB 上限，已截断]' : ''}`;
    }
    case 'gitOperation': {
      // Minimal pass-through to existing endpoints. We deliberately whitelist
      // operations rather than handing the AI a `git ${anything}` shell call.
      const a = call.args as { op?: string; args?: Record<string, unknown> };
      if (!a.op) throw new Error('gitOperation 缺少 op');
      switch (a.op) {
        case 'status':
          return JSON.stringify(await api.getStatus(), null, 2);
        case 'diff':
          // No dedicated /api/diff yet — surface the working tree status as
          // a useful approximation; fuller diff support can land later.
          return JSON.stringify(await api.getStatus(), null, 2);
        case 'log':
          return JSON.stringify(await api.getCommitsRange(0, 50), null, 2);
        case 'checkout': {
          const branch = (a.args ?? {}) as { branch?: string };
          if (!branch.branch) throw new Error('checkout 需要 args.branch');
          await api.checkout(branch.branch);
          return `已切到 ${branch.branch}`;
        }
        default:
          throw new Error(`未知 git op: ${a.op}`);
      }
    }
    case 'vaultList': {
      const a = call.args as { type?: string };
      const r = await api.listVault(a.type ? { type: a.type as import('@shared/types').VaultDocType } : undefined);
      if (r.items.length === 0) return '（Vault 暂无文档）';
      return r.items.map((d) => `[${d.type}] ${d.title} (id:${d.id})\n  ${d.excerpt}`).join('\n\n');
    }
    case 'vaultCreate': {
      const a = call.args as {
        type?: import('@shared/types').VaultDocType;
        title?: string;
        content?: string;
        tags?: string[];
      };
      if (!a.type || !a.title || !a.content) throw new Error('vaultCreate 需要 {type, title, content}');
      const doc = await api.createVaultDoc({
        type: a.type,
        title: a.title,
        content: a.content,
        tags: a.tags,
        author: 'soul',
      });
      return `已创建 Vault 文档 id:${doc.id}  title:"${doc.title}"`;
    }
    case 'vaultAppend': {
      const a = call.args as { id?: string; content?: string };
      if (!a.id || !a.content) throw new Error('vaultAppend 需要 {id, content}');
      const doc = await api.updateVaultDoc(a.id, { content: a.content, mode: 'append' });
      return `已追加到 Vault 文档 id:${doc.id} (现 ${doc.content.length} chars)`;
    }
    default:
      throw new Error(`未知工具: ${call.name as string}`);
  }
}

interface Props {
  /** Skills, owned by the parent (DebugLayout) so the gear button can mutate. */
  skills: Skill[];
  /** Open the SkillsPanel overlay. */
  onOpenSkills(): void;
  /** Called whenever the AI mood changes (for the pet widget). */
  onMoodChange?: (mood: import('@shared/types').PetMood) => void;
}

export function AIAgentPanel({ skills, onOpenSkills, onMoodChange }: Props): JSX.Element {
  const [apiKey, setApiKeyState] = useState<string>(() => readKey());
  const [draftKey, setDraftKey] = useState<string>('');
  const [showKeyEdit, setShowKeyEdit] = useState<boolean>(false);
  const [items, setItems] = useState<ChatItem[]>(() => readItems());
  // Pending attachments waiting to be sent (logs OR user-picked files).
  // Cleared on successful send, or per-pill via the ✕ button. Not
  // persisted — an attachment only outlives a refresh once it's been
  // attached to a sent user message.
  const [pending, setPending] = useState<Attachment[]>([]);
  // Currently open file-preview overlay (null = closed). One-at-a-time;
  // clicking another chip swaps the contents. Lives at panel level so the
  // overlay can render outside individual chip boundaries.
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  // Hidden <input type=file> driven by the 📎 button. Reset after each
  // pick so picking the same file twice still fires onChange.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notify parent (pet widget) when mood changes.
  const prevBusy = useRef(false);
  useEffect(() => {
    if (busy === prevBusy.current) return;
    prevBusy.current = busy;
    onMoodChange?.(busy ? 'working' : error ? 'worried' : 'idle');
  }, [busy, error, onMoodChange]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------
  // Queued follow-ups. When the AI is busy (mid-tool-call loop or
  // mid-Coder-handoff), pressing Send doesn't error — it appends to
  // this queue. As soon as `busy` flips false a drain effect pops the
  // head and fires it. The user can edit / reorder / delete pending
  // items in the QueueStrip UI right above the composer.
  //
  // Not persisted to localStorage on purpose: a queue is an in-flight
  // intent. If the user closes the panel they probably don't want
  // forgotten messages auto-sending the next time they open it.
  // ---------------------------------------------------------------
  interface QueuedItem {
    id: string;
    text: string;
    attachments: Attachment[];
  }
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  // Re-entrancy guard so the drain effect doesn't double-fire if React
  // re-runs it while the previous send is mid-await.
  const drainingRef = useRef(false);

  const isConfigured = apiKey.length > 0;

  // Project memory — pulled on mount + after every save. Whatever's here
  // gets prepended to the AI's system prompt so DeepSeek "remembers" the
  // project across sessions. Empty string until first fetch / when no
  // skill grants memory access.
  const [memoryContent, setMemoryContent] = useState<string>('');
  const memoryReloadRef = useRef<() => Promise<void>>(async () => { /* set below */ });

  // Single vs Dual AI mode. Persisted; defaults to single (cheaper, faster).
  const [aiMode, setAiMode] = useState<AiMode>(() => {
    try {
      const v = localStorage.getItem(MODE_STORAGE);
      // Migrate legacy values from the old binary toggle: 'dual' → 'clarifier',
      // 'single' → 'auto'. New users default to 'auto'.
      if (v === 'clarifier' || v === 'coder' || v === 'auto') return v;
      if (v === 'dual') return 'clarifier';
      return 'auto';
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    try { localStorage.setItem(MODE_STORAGE, aiMode); } catch { /* ignore */ }
  }, [aiMode]);

  // Recompute tool list / system prompt only when the skill catalog changes.
  // useMemo here keeps the system prompt out of the per-keystroke render path.
  const tools = useMemo(() => buildToolList(skills), [skills]);
  // Project memory wedge prepended to every agent's system prompt. Empty
  // when the user hasn't enabled the memory skill OR memory file is empty.
  const memoryWedge = useMemo(() => {
    if (!memoryContent.trim()) return '';
    return [
      '## 项目记忆（你之前给这个项目记的笔记，每轮都自动塞给你）',
      '```markdown',
      memoryContent.trim(),
      '```',
      '如果你在这一轮里学到了新的、值得长期保留的项目知识（架构、坑、约定、TODO），用 `appendMemory({"content":"..."})` 写进去。如果发现旧记忆错了，用 `writeMemory({"content":"..."})` 整体重写。**保持精简**——记忆不是日志。',
      '',
    ].join('\n');
  }, [memoryContent]);
  const systemPrompt = useMemo(
    () => memoryWedge + buildSystemPrompt(skills, tools, 'single'),
    [memoryWedge, skills, tools],
  );
  // Two coder variants: with-brief (post-handoff from Clarifier) and
  // without-brief (user picked Coder mode directly to skip asking).
  const coderPromptWithBrief = useMemo(
    () => memoryWedge + buildSystemPrompt(skills, tools, 'coder', { hasBrief: true }),
    [memoryWedge, skills, tools],
  );
  const coderPromptDirect = useMemo(
    () => memoryWedge + buildSystemPrompt(skills, tools, 'coder', { hasBrief: false }),
    [memoryWedge, skills, tools],
  );
  // Clarifier sees ONLY the read-only subset of tools, regardless of which
  // tools the user has enabled overall. Even if the user opted into terminal
  // / browser, the clarifier never gets them — its job is to ask, not act.
  const clarifierReadOnlyPerms = useMemo(
    () => new Set<string>(['canReadFiles', 'canSearchCode']),
    [],
  );
  const clarifierTools = useMemo(
    () => tools.filter((t) => clarifierReadOnlyPerms.has(TOOL_PERMS[t.name])),
    [tools, clarifierReadOnlyPerms],
  );
  const clarifierPrompt = useMemo(
    () => memoryWedge + buildClarifierPrompt(skills, clarifierTools),
    [memoryWedge, skills, clarifierTools],
  );

  const allowedPerms = useMemo(() => {
    const set = new Set<string>();
    for (const s of skills) {
      if (!s.enabled) continue;
      for (const k of Object.keys(s.permissions) as (keyof Skill['permissions'])[]) {
        if (s.permissions[k]) set.add(k);
      }
    }
    return set;
  }, [skills]);
  // The clarifier's allowed-perms set is the intersection of what we lock it
  // down to AND what the user actually enabled (they might have no read skill
  // at all — then clarifier asks questions without tools, which is fine).
  const clarifierAllowedPerms = useMemo(() => {
    const set = new Set<string>();
    for (const p of clarifierReadOnlyPerms) {
      if (allowedPerms.has(p)) set.add(p);
    }
    return set;
  }, [clarifierReadOnlyPerms, allowedPerms]);

  useEffect(() => {
    writeItems(items);
  }, [items]);

  // Load (and reload) project memory whenever the user has the memory skill
  // enabled. We poll on a focus event too so the AI Memory page edits land
  // in the prompt without a panel remount.
  useEffect(() => {
    let alive = true;
    const hasMemory = allowedPerms.has('canAccessMemory');
    async function load(): Promise<void> {
      if (!hasMemory) {
        if (alive) setMemoryContent('');
        return;
      }
      try {
        const m = await api.getMemory();
        if (alive) setMemoryContent(m.content || '');
      } catch {
        // server error — show empty rather than crash; user will see it
        // in the Memory page if it persists.
        if (alive) setMemoryContent('');
      }
    }
    memoryReloadRef.current = load;
    void load();
    function onFocus(): void { void load(); }
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
    // We DON'T need allowedPerms reference equality — it's a Set built fresh
    // each render. Re-running on its identity change is fine + cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedPerms]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, busy, pending.length]);

  // Esc closes the open preview overlay (matches modal convention so the
  // user doesn't have to mouse over to ✕).
  useEffect(() => {
    if (!previewing) return;
    function handler(e: KeyboardEvent): void {
      if (e.key === 'Escape') setPreviewing(null);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [previewing]);

  function removePending(id: string): void {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  // -------------------------------------------------------------------------
  // File picker. Clicking the paperclip in the composer triggers the hidden
  // input. We attempt a UTF-8 text read — DeepSeek's chat API is text-only,
  // so binary files (images / pdfs) come through as a placeholder pill that
  // the user can decide to keep or ✕. Per-file 1MB cap to avoid blowing
  // the prompt budget; users can copy-paste a smaller slice if needed.
  // -------------------------------------------------------------------------
  const FILE_MAX_BYTES = 1_000_000;

  function looksTextLike(file: File): boolean {
    if (file.size > FILE_MAX_BYTES) return false;
    const lower = file.name.toLowerCase();
    if (
      /\.(txt|md|markdown|json|jsonc|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|xml|svg|yml|yaml|toml|ini|cfg|conf|csv|tsv|log|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile)$/.test(lower)
    ) return true;
    const t = file.type;
    return t.startsWith('text/') || t === 'application/json' || t === 'application/xml';
  }

  async function attachFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0) return;
    const additions: Attachment[] = [];
    for (const f of list) {
      let text = '';
      if (looksTextLike(f)) {
        try {
          text = await f.text();
        } catch {
          text = '';
        }
      }
      additions.push({
        id: nextId('a'),
        kind: 'file',
        name: f.name,
        mime: f.type || 'application/octet-stream',
        sizeBytes: f.size,
        text,
        createdAt: Date.now(),
      });
    }
    setPending((prev) => [...prev, ...additions]);
  }

  function openFilePicker(): void {
    fileInputRef.current?.click();
  }


  function saveKey(): void {
    const trimmed = draftKey.trim();
    if (trimmed.length < 8) {
      setError('API Key 看起来太短了');
      return;
    }
    writeKey(trimmed);
    setApiKeyState(trimmed);
    setDraftKey('');
    setShowKeyEdit(false);
    setError(null);
  }

  function clearKey(): void {
    writeKey('');
    setApiKeyState('');
    setShowKeyEdit(true);
    setDraftKey('');
  }

  // -------------------------------------------------------------------------
  // Wire-format helper. Inlines a user message's attachments as named
  // fenced blocks appended to the content. Logs and files share the same
  // "--- 附件: name (size) ---" header so the model treats both uniformly.
  // Binary files (text === '') get a placeholder line rather than garbage
  // bytes so the prompt stays small and the model knows what's missing.
  // -------------------------------------------------------------------------
  function toWireMsg(it: MsgItem): AIChatMessage {
    if (it.msg.role !== 'user' || !it.attachments?.length) return it.msg;
    const blocks = it.attachments
      .map((a) => {
        const head = `--- 附件: ${a.name} (${formatBytes(a.sizeBytes)}) ---`;
        const body = a.text || `[二进制文件，无法以文本读取；mime=${a.mime || 'unknown'}]`;
        return `${head}\n${body}`;
      })
      .join('\n\n');
    const content = it.msg.content ? `${it.msg.content}\n\n${blocks}` : blocks;
    return { role: 'user', content };
  }

  // -------------------------------------------------------------------------
  // Tool-calling loop. Mutates `items` directly so the chat list renders
  // partial progress as the model talks / tools fire.
  //
  // `agent` decides who's "speaking":
  //   - 'coder'     → uses Coder system prompt (post-handoff in dual mode)
  //   - 'clarifier' → uses Clarifier system prompt + read-only tool subset;
  //                   stops the moment the model emits a `<brief>` since the
  //                   handoff is then user-driven.
  //   - 'single'    → original behavior (no clarifier, full tool set).
  //
  // `briefForCoder` is the alignment summary the Clarifier produced; injected
  // into the Coder's system context so it knows what was already agreed on.
  // -------------------------------------------------------------------------
  async function runChatLoop(
    seedItems: ChatItem[],
    opts: {
      agent: 'single' | 'clarifier' | 'coder';
      briefForCoder?: string;
    },
  ): Promise<ChatItem[]> {
    const { agent, briefForCoder } = opts;
    // Pick the appropriate prompt + tool surface for this agent.
    let activePrompt: string;
    let activeAllowed: Set<string>;
    if (agent === 'clarifier') {
      activePrompt = clarifierPrompt;
      activeAllowed = clarifierAllowedPerms;
    } else if (agent === 'coder') {
      if (briefForCoder) {
        const briefBlock = `\n\n---\n## 用户已经和澄清助手对齐的需求 brief\n${briefForCoder}\n---`;
        activePrompt = coderPromptWithBrief + briefBlock;
      } else {
        activePrompt = coderPromptDirect;
      }
      activeAllowed = allowedPerms;
    } else {
      activePrompt = systemPrompt;
      activeAllowed = allowedPerms;
    }

    // Persist agent attribution on every message we add so the UI can color
    // the bubble correctly (clarifier vs coder bubbles differ in style).
    const tag = (m: AIChatMessage): MsgItem => ({
      kind: 'msg',
      id: nextId('m'),
      msg: m,
      agent: agent === 'single' ? undefined : agent,
    });

    let convo = seedItems;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const wire: AIChatMessage[] = [
        { role: 'system', content: activePrompt },
        ...convo.map(toWireMsg),
      ];
      const res = await api.aiChat({ provider: 'deepseek', apiKey, messages: wire });
      const reply = tag({ role: 'assistant', content: res.content });
      // Clarifier → mark the message as "has brief" so the UI knows to show
      // the handoff button. handedOff stays false until the user clicks.
      if (agent === 'clarifier' && parseBrief(res.content)) {
        reply.handedOff = false;
      }
      convo = [...convo, reply];
      setItems(convo);

      // Clarifier: we ALWAYS stop after one assistant turn, regardless of
      // whether it called tools. If it called tools we run them in this
      // same turn and then return — the user's next message will trigger
      // the next clarifier round. (Otherwise the clarifier could keep
      // looping past the first question, asking 5 in a row.)
      // Auto: if the assistant emitted any <ask> blocks it's waiting on
      // the user — stop the loop so the buttons can render. (Without this
      // a follow-up empty-tool turn would render and look weird.)
      const calls = parseToolCalls(res.content);
      const emittedAsk = agent === 'single' && parseAsks(res.content).length > 0;
      if (calls.length === 0 || emittedAsk) return convo;
      if (agent === 'clarifier' && parseBrief(res.content)) {
        // Clarifier emitted brief AND called tools — ignore the tool call
        // for safety, the brief is the signal to stop.
        return convo;
      }

      const outputs: string[] = [];
      for (const call of calls) {
        try {
          const out = await executeTool(call, activeAllowed, setMemoryContent);
          outputs.push(`【${call.name}】 ok\n${clampResult(out)}`);
        } catch (e) {
          outputs.push(`【${call.name}】 err\n${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const sys = tag({
        role: 'system',
        content: TOOL_RESULT_PREFIX + '\n' + outputs.join('\n\n---\n\n'),
      });
      convo = [...convo, sys];
      setItems(convo);

      // After clarifier's tools run we DO continue one more turn so it can
      // actually ask its question grounded in what it just read. But cap
      // at 2 turns total for the clarifier to keep responses snappy.
      if (agent === 'clarifier' && turn >= 1) return convo;
    }
    return [
      ...convo,
      tag({
        role: 'system',
        content: `${TOOL_RESULT_PREFIX}\n（已达到 ${MAX_TOOL_TURNS} 轮工具调用上限，停止）`,
      }),
    ];
  }

  // Inner send — does the actual API call + state updates given a
  // resolved (text, attachments) pair. Used by both the manual Send
  // button and the queue drain effect.
  async function fireSend(text: string, atts: Attachment[]): Promise<void> {
    setError(null);

    const userItem: MsgItem = {
      kind: 'msg',
      id: nextId('m'),
      msg: { role: 'user', content: text },
      attachments: atts.length > 0 ? atts : undefined,
    };

    const next: ChatItem[] = [...items, userItem];
    setItems(next);
    setBusy(true);
    try {
      // Mode dispatch:
      //   - auto      → single agent w/ ask-capability prompt (default)
      //   - coder     → single agent w/ no-ask "just do it" prompt
      //   - clarifier → Clarifier owns the conversation until the user clicks
      //                 "send to Coder" on a brief (handoffToCoder).
      const final = await runChatLoop(next, { agent: modeToAgent(aiMode) });
      setItems(final);
      onMoodChange?.('happy');
      setTimeout(() => onMoodChange?.('idle'), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems(next);
      onMoodChange?.('worried');
      setTimeout(() => onMoodChange?.('idle'), 4000);
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    // Allow sending with attachments only — snippets become context for
    // the AI's next turn even without typed text.
    if (!text && pending.length === 0) return;
    if (!apiKey) {
      setError('请先配置 DeepSeek API Key');
      return;
    }

    // Busy → queue the message instead of erroring. User can keep typing
    // follow-ups and they'll fire in order once the current loop
    // finishes (drained by the effect below).
    if (busy) {
      setQueue((cur) => [
        ...cur,
        { id: nextId('q'), text, attachments: pending.slice() },
      ]);
      setInput('');
      setPending([]);
      // Auto-expand so the user sees their queued msg land — without
      // this an offscreen badge change is easy to miss.
      setQueueExpanded(true);
      return;
    }

    // Drain the pending attachments — they're being persisted onto the
    // user msg right now. Capture before clearing because React state
    // updates are async.
    const atts = pending.slice();
    setInput('');
    setPending([]);
    await fireSend(text, atts);
  }

  // ----------------------------------------------------------------
  // Queue mutations exposed to the QueueStrip UI.
  // ----------------------------------------------------------------
  function removeQueued(id: string): void {
    setQueue((q) => q.filter((x) => x.id !== id));
    if (editingQueueId === id) {
      setEditingQueueId(null);
      setEditingDraft('');
    }
  }
  function moveQueuedUp(id: string): void {
    setQueue((q) => {
      const i = q.findIndex((x) => x.id === id);
      if (i <= 0) return q;
      const next = q.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }
  function startEditingQueued(id: string): void {
    const it = queue.find((x) => x.id === id);
    if (!it) return;
    setEditingQueueId(id);
    setEditingDraft(it.text);
  }
  function commitEditingQueued(): void {
    if (!editingQueueId) return;
    const trimmed = editingDraft.trim();
    if (!trimmed) {
      // empty edit = drop the queued item
      removeQueued(editingQueueId);
      return;
    }
    setQueue((q) => q.map((x) => (x.id === editingQueueId ? { ...x, text: trimmed } : x)));
    setEditingQueueId(null);
    setEditingDraft('');
  }
  function cancelEditingQueued(): void {
    setEditingQueueId(null);
    setEditingDraft('');
  }

  // ----------------------------------------------------------------
  // Drain the queue head every time the AI becomes idle. The
  // re-entrancy guard (drainingRef) plus the dependency array
  // prevents a re-render while `setBusy(true)` is still in flight
  // from triggering a second pop.
  // ----------------------------------------------------------------
  useEffect(() => {
    if (busy) return;
    if (queue.length === 0) return;
    if (drainingRef.current) return;
    if (!apiKey) return; // edge: user removed the key while items queued
    drainingRef.current = true;
    const head = queue[0];
    setQueue((q) => q.slice(1));
    fireSend(head.text, head.attachments).finally(() => {
      drainingRef.current = false;
    });
    // We deliberately exclude `fireSend` from the deps — it changes
    // every render (it closes over items / aiMode), and including it
    // would loop. The guard above is what keeps things sane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue, apiKey]);

  // -------------------------------------------------------------------------
  // Dual-AI handoff. Triggered when the user clicks the "✓ 转交给 Coder"
  // button on a Clarifier message that emitted a `<brief>`. We:
  //   1. flip handedOff=true on that message so the button hides,
  //   2. inject a synthetic system marker so the chat reads as "moving to
  //      coder",
  //   3. start a Coder loop with the brief baked into its system prompt.
  // The user doesn't need to type anything — the brief is the prompt.
  // -------------------------------------------------------------------------
  async function handoffToCoder(itemId: string, brief: string): Promise<void> {
    if (!apiKey) {
      setError('请先配置 DeepSeek API Key');
      return;
    }
    setError(null);
    const marked = items.map((it) => (it.id === itemId ? { ...it, handedOff: true } : it));
    const handoffMarker: MsgItem = {
      kind: 'msg',
      id: nextId('m'),
      msg: { role: 'system', content: '— 已转交给 Coder —' },
    };
    const next = [...marked, handoffMarker];
    setItems(next);
    setBusy(true);
    try {
      const final = await runChatLoop(next, { agent: 'coder', briefForCoder: brief });
      setItems(final);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems(next);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Ask-block click handler. When the user picks an option in a
  // Clarifier-emitted `<ask>` block, we drop the answer into the input
  // box (multi-select supported by appending). User still has to hit Send
  // — gives them a chance to add free-form context before sending.
  // -------------------------------------------------------------------------
  function answerAsk(question: string, picked: string[]): void {
    const ans = `${question} → ${picked.join(' / ')}`;
    setInput((prev) => (prev ? `${prev}\n${ans}` : ans));
  }

  function clearChat(): void {
    // Per spec: clearing the chat also drops every snippet (they live as
    // chat items). The user explicitly opts out of all collected logs by
    // clicking 清空.
    setItems([]);
    writeItems([]);
  }

  function deleteItem(id: string): void {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }


  return (
    <div className="dbg-ai">
      <div className="dbg-ai-head">
        <div className="dbg-ai-title">
          <Icon name="sparkles" size={14} />
          AI Agent
        </div>
        <span style={{ flex: 1 }} />
        {isConfigured && !showKeyEdit ? (
          <>
            <ModePicker mode={aiMode} onChange={setAiMode} />
            <button
              type="button"
              className="dbg-text-btn"
              onClick={() => setShowKeyEdit(true)}
              title="更换 API Key"
            >
              <Icon name="key" size={12} /> 密钥
            </button>
            {items.length > 0 ? (
              <button
                type="button"
                className="dbg-text-btn"
                onClick={clearChat}
                title="清空对话和所有日志片段"
              >
                清空
              </button>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="topnav-action icon-only"
          onClick={onOpenSkills}
          title="技能"
          aria-label="技能"
        >
          <Icon name="gear" size={16} />
        </button>
      </div>

      {!isConfigured || showKeyEdit ? (
        <div className="dbg-ai-config">
          <div className="dbg-ai-config-title">配置 DeepSeek API Key</div>
          <input
            className="dbg-ai-key-input"
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="sk-..."
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveKey();
            }}
          />
          <div className="dbg-ai-config-row">
            <button type="button" className="dbg-primary-btn" onClick={saveKey}>
              保存
            </button>
            {isConfigured ? (
              <>
                <button
                  type="button"
                  className="dbg-text-btn"
                  onClick={() => {
                    setShowKeyEdit(false);
                    setDraftKey('');
                  }}
                >
                  取消
                </button>
                <button type="button" className="dbg-text-btn warn" onClick={clearKey}>
                  删除已保存
                </button>
              </>
            ) : null}
          </div>
          <div className="dbg-ai-hint">
            密钥仅存本地浏览器（base64 混淆，非加密）。请求会先到本机 server，
            再代理到 api.deepseek.com — 不会经过任何第三方。
          </div>
        </div>
      ) : (
        <>
          <div className="dbg-ai-list" ref={listRef}>
            {items.length === 0 ? (
              <div className="dbg-ai-empty">问点什么？</div>
            ) : (
              items.map((it) => (
                <ChatBubble
                  key={it.id}
                  item={it}
                  onDelete={() => deleteItem(it.id)}
                  onPreview={setPreviewing}
                  onHandoff={(brief) => void handoffToCoder(it.id, brief)}
                  onAnswerAsk={answerAsk}
                />
              ))
            )}
            {busy ? (
              <div className="dbg-ai-msg role-assistant pending">
                <div className="dbg-ai-msg-role">
                  {aiMode === 'clarifier'
                    ? (items.some((it) => it.agent === 'coder' && it.handedOff !== false) || items[items.length - 1]?.handedOff
                      ? 'Coder'
                      : 'Clarifier')
                    : aiMode === 'coder' ? 'Coder' : 'DeepSeek'}
                </div>
                <div className="dbg-ai-dots">
                  <span /> <span /> <span />
                </div>
              </div>
            ) : null}
          </div>

          <div className="dbg-ai-composer">
            {/* Queued follow-ups. Sit ABOVE pending attachments because
                they refer to things the user has already "committed to
                send" — pending chips are still being assembled. */}
            {queue.length > 0 ? (
              <QueueStrip
                queue={queue}
                expanded={queueExpanded}
                onToggleExpanded={() => setQueueExpanded((v) => !v)}
                editingId={editingQueueId}
                editingDraft={editingDraft}
                onEditingDraftChange={setEditingDraft}
                onStartEdit={startEditingQueued}
                onCommitEdit={commitEditingQueued}
                onCancelEdit={cancelEditingQueued}
                onMoveUp={moveQueuedUp}
                onRemove={removeQueued}
              />
            ) : null}
            {/* Pending attachments — DeepSeek-style file pills above the
                textarea. ✕ on a pill discards it without sending. */}
            {pending.length > 0 ? (
              <div className="dbg-attach-row">
                {pending.map((p) => (
                  <AttachmentChip
                    key={p.id}
                    att={p}
                    onRemove={() => removePending(p.id)}
                    onPreview={setPreviewing}
                  />
                ))}
              </div>
            ) : null}
            <div className="dbg-ai-input-wrap">
              <textarea
                className="dbg-ai-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  busy
                    ? '排队下一条 — AI 完成当前任务后自动发送'
                    : pending.length > 0
                      ? `${pending.length} 个附件已添加，按 ⌘/Ctrl + Enter 发送`
                      : '给 DeepSeek 发送消息'
                }
                rows={3}
              />
              {/* Hidden — the visible 📎 button below triggers it. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    void attachFiles(e.target.files);
                  }
                  e.target.value = '';
                }}
              />
              <div className="dbg-ai-actions">
                <button
                  type="button"
                  className="dbg-attach-btn"
                  onClick={openFilePicker}
                  title="上传文件"
                  aria-label="上传文件"
                >
                  <Icon name="paperclip" size={16} />
                </button>
                <button
                  type="button"
                  className={`dbg-primary-btn dbg-send-btn${busy ? ' queueing' : ''}`}
                  onClick={() => void send()}
                  disabled={!input.trim() && pending.length === 0}
                  title={busy ? '排队 — 当前任务完成后自动发送' : '发送 (⌘/Ctrl + Enter)'}
                >
                  <Icon name={busy ? 'plus' : 'send'} size={14} />
                </button>
              </div>
            </div>
          </div>

          {error ? <div className="dbg-ai-error">{error}</div> : null}
        </>
      )}
      {previewing ? (
        <AttachmentPreview att={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </div>
  );
}

// =============================================================================
// ChatBubble — renders one ChatItem (always a wrapped message now).
//
//   - assistant messages: split out <tool_call>…</tool_call> blocks into
//     ToolCallBlock components, leave the rest of the prose inline
//   - system messages prefixed "工具执行结果：" render as collapsed
//     ToolResultBlock(s) (one per call)
//   - user messages render the prose plus any attachment chips below it,
//     and a hover-only ✕ button to delete the whole turn (which also
//     deletes its attachments — matches the user's spec: "删了这个对话框
//     就把那个删掉了")
// =============================================================================
function ChatBubble({
  item,
  onDelete,
  onPreview,
  onHandoff,
  onAnswerAsk,
}: {
  item: MsgItem;
  onDelete?: () => void;
  onPreview?: (a: Attachment) => void;
  onHandoff?: (brief: string) => void;
  onAnswerAsk?: (question: string, picked: string[]) => void;
}): JSX.Element | null {
  const { msg, attachments, agent } = item;
  if (msg.role === 'system' && msg.content.startsWith(TOOL_RESULT_PREFIX)) {
    const body = msg.content.slice(TOOL_RESULT_PREFIX.length).trim();
    const blocks = body.split(/\n\n---\n\n/);
    return (
      <div className={`dbg-ai-msg role-tool${agent ? ` agent-${agent}` : ''}`}>
        {blocks.map((b, i) => (
          <ToolResultBlock key={i} text={b} />
        ))}
      </div>
    );
  }
  if (msg.role === 'system') {
    return (
      <div className="dbg-ai-msg role-system">
        <div className="dbg-ai-msg-role">系统</div>
        <div className="dbg-ai-msg-body">{msg.content}</div>
      </div>
    );
  }
  if (msg.role === 'assistant') {
    const roleLabel = agent === 'clarifier' ? '澄清助手' : agent === 'coder' ? 'Coder' : 'DeepSeek';
    const asks = parseAsks(msg.content);
    const brief = parseBrief(msg.content);
    return (
      <div className={`dbg-ai-msg role-assistant${agent ? ` agent-${agent}` : ''}`}>
        <div className="dbg-ai-msg-role">{roleLabel}</div>
        <div className="dbg-ai-msg-body">
          <AssistantContent text={msg.content} />
          {asks.map((a, i) => (
            <AskBlock key={`ask-${i}`} data={a} onAnswer={onAnswerAsk} />
          ))}
          {brief && !item.handedOff && onHandoff ? (
            <BriefHandoff brief={brief} onSend={() => onHandoff(brief)} />
          ) : null}
          {brief && item.handedOff ? (
            <div className="dbg-handoff-done">
              <Icon name="check" size={12} /> 已转交给 Coder
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="dbg-ai-msg role-user">
      <div className="dbg-ai-msg-role">
        你
        {onDelete ? (
          <button
            type="button"
            className="dbg-ai-msg-del"
            title="删除此消息"
            aria-label="删除此消息"
            onClick={onDelete}
          >
            <Icon name="close" size={10} />
          </button>
        ) : null}
      </div>
      {msg.content ? <div className="dbg-ai-msg-body">{msg.content}</div> : null}
      {attachments && attachments.length > 0 ? (
        <div className="dbg-attach-row in-msg">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} att={a} onPreview={onPreview} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// AttachmentChip — minimal DeepSeek-style file pill used in two contexts:
//   1. Pending queue above the textarea (with ✕ to discard before sending).
//   2. Below a sent user message body (no ✕; user removes the whole msg).
//
// The whole chip body is a button — click opens the file content in a
// preview overlay (handed up to the panel via `onPreview`). The corner
// ✕ stops propagation so removing doesn't also open the preview.
// =============================================================================
function AttachmentChip({
  att,
  onRemove,
  onPreview,
}: {
  att: Attachment;
  onRemove?: () => void;
  onPreview?: (a: Attachment) => void;
}): JSX.Element {
  const ext = fileExt(att.name);
  const sub = `${ext} · ${formatBytes(att.sizeBytes)}`;
  return (
    <div className="dbg-attach-chip">
      <button
        type="button"
        className="dbg-attach-chip-body"
        onClick={() => onPreview?.(att)}
        title="点击查看内容"
        aria-label={`查看 ${att.name} 的内容`}
      >
        <span className="dbg-attach-chip-icon" aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
        <span className="dbg-attach-chip-meta">
          <span className="dbg-attach-chip-name" title={att.name}>{att.name}</span>
          <span className="dbg-attach-chip-sub">{sub}</span>
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          className="dbg-attach-chip-close"
          onClick={(e) => {
            // Don't bubble up to the chip body — otherwise the preview
            // would pop right after the user removes the file.
            e.stopPropagation();
            onRemove();
          }}
          title="移除"
          aria-label="移除"
        >
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </div>
  );
}

// =============================================================================
// AttachmentPreview — modal overlay that shows the full file/log contents
// for an Attachment. Fixed-position card; click backdrop or ✕ to close.
// Esc also closes (handled in the parent via keydown).
// =============================================================================
function AttachmentPreview({
  att,
  onClose,
}: {
  att: Attachment;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="dbg-attach-preview-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="dbg-attach-preview"
        role="dialog"
        aria-label={`预览 ${att.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dbg-attach-preview-head">
          <span className="dbg-attach-chip-icon" aria-hidden="true">
            <Icon name="file" size={16} />
          </span>
          <div className="dbg-attach-preview-meta">
            <div className="dbg-attach-preview-name" title={att.name}>{att.name}</div>
            <div className="dbg-attach-preview-sub">
              {fileExt(att.name)} · {formatBytes(att.sizeBytes)}
            </div>
          </div>
          <button
            type="button"
            className="dbg-attach-preview-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <pre className="dbg-attach-preview-body">
          {att.text || `[二进制文件 — 无法以文本展示\nmime: ${att.mime || 'unknown'}\n大小: ${formatBytes(att.sizeBytes)}]`}
        </pre>
      </div>
    </div>
  );
}

// Splits assistant text on <tool_call>…</tool_call> markers, rendering text
// segments as plain content and tool-call markers as compact ToolCallBlocks.
// Also strips <ask>…</ask> and <brief>…</brief> blocks — those render as
// dedicated UI components in the bubble below the prose, not inline.
function AssistantContent({ text }: { text: string }): JSX.Element {
  // First strip ask + brief tags from the visible prose. Their structured
  // payloads still get parsed in ChatBubble; we just don't want to show the
  // raw JSON / brief text twice.
  const clean = text
    .replace(ASK_RE, '')
    .replace(BRIEF_RE, '')
    .trim();
  const parts: { kind: 'text' | 'call'; value: string }[] = [];
  let cursor = 0;
  TOOL_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_RE.exec(clean)) !== null) {
    if (m.index > cursor) parts.push({ kind: 'text', value: clean.slice(cursor, m.index) });
    parts.push({ kind: 'call', value: m[1].trim() });
    cursor = m.index + m[0].length;
  }
  if (cursor < clean.length) parts.push({ kind: 'text', value: clean.slice(cursor) });

  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.value}</span>
        ) : (
          <ToolCallBlock key={i} json={p.value} />
        ),
      )}
    </>
  );
}

// =============================================================================
// ModePicker — small pill+caret in the panel head opening a dropdown of
// the three AI modes. Mimics Cursor's "Auto" picker. Closes on outside
// click and Escape. Persists selection up via onChange (callsite handles
// localStorage). The current label sits inside the pill so the user can
// see at a glance which mode they're in.
// =============================================================================
const MODE_INFO: Record<AiMode, { label: string; desc: string }> = {
  auto: {
    label: 'Auto',
    desc: '自动：DeepSeek 自己判断该问还是该动手。模糊需求会先问 1-2 个关键问题，清楚的就直接做。',
  },
  coder: {
    label: 'Coder',
    desc: '直给：从不问澄清，按字面意思直接执行。适合你已经想好要什么、只想他动手的时候。',
  },
  clarifier: {
    label: 'Clarifier',
    desc: '澄清：先用选择题问明白需求，对齐后再让你点「转交给 Coder」启动编码。适合复杂需求。',
  },
};

function ModePicker({ mode, onChange }: { mode: AiMode; onChange: (m: AiMode) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cur = MODE_INFO[mode];
  return (
    <div className="dbg-mode-picker" ref={wrapRef}>
      <button
        type="button"
        className="dbg-mode-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={cur.desc}
      >
        <Icon name="sparkles" size={11} />
        <span>{cur.label}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="dbg-mode-picker-menu" role="listbox" aria-label="AI 模式选择">
          {(Object.keys(MODE_INFO) as AiMode[]).map((m) => {
            const info = MODE_INFO[m];
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={selected}
                className={`dbg-mode-picker-item${selected ? ' selected' : ''}`}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <div className="dbg-mode-picker-item-head">
                  <span className="dbg-mode-picker-item-label">{info.label}</span>
                  {selected ? <Icon name="check" size={12} /> : null}
                </div>
                <div className="dbg-mode-picker-item-desc">{info.desc}</div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// QueueStrip — collapsed "N 已排队" header with optional list of queued
// follow-ups. Each item is editable / movable / deletable. Cursor's
// queued-prompts UI is the reference: small unobtrusive header; expanding
// reveals one row per item with edit (✎) / move-up (↑) / delete (🗑).
// =============================================================================
interface QueueStripProps {
  queue: { id: string; text: string; attachments: Attachment[] }[];
  expanded: boolean;
  onToggleExpanded: () => void;
  editingId: string | null;
  editingDraft: string;
  onEditingDraftChange: (s: string) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onMoveUp: (id: string) => void;
  onRemove: (id: string) => void;
}

function QueueStrip(p: QueueStripProps): JSX.Element {
  const { queue, expanded } = p;
  return (
    <div className="dbg-queue">
      <button
        type="button"
        className="dbg-queue-head"
        onClick={p.onToggleExpanded}
        aria-expanded={expanded}
        aria-controls="dbg-queue-list"
        title={expanded ? '收起队列' : '展开队列'}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        <span className="dbg-queue-count">{queue.length} 已排队</span>
        <span className="dbg-queue-hint">AI 完成后按顺序自动发送</span>
      </button>
      {expanded ? (
        <ul id="dbg-queue-list" className="dbg-queue-list">
          {queue.map((it, i) => {
            const isEditing = p.editingId === it.id;
            return (
              <li key={it.id} className={`dbg-queue-item${isEditing ? ' editing' : ''}`}>
                <span className="dbg-queue-bullet" aria-hidden="true" />
                {isEditing ? (
                  <>
                    <textarea
                      className="dbg-queue-edit"
                      value={p.editingDraft}
                      onChange={(e) => p.onEditingDraftChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          p.onCommitEdit();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          p.onCancelEdit();
                        }
                      }}
                      rows={2}
                      autoFocus
                    />
                    <div className="dbg-queue-edit-actions">
                      <button
                        type="button"
                        className="dbg-queue-icon-btn"
                        onClick={p.onCommitEdit}
                        title="保存（⌘/Ctrl+Enter）"
                        aria-label="保存"
                      >
                        <Icon name="check" size={12} />
                      </button>
                      <button
                        type="button"
                        className="dbg-queue-icon-btn"
                        onClick={p.onCancelEdit}
                        title="取消（Esc）"
                        aria-label="取消"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="dbg-queue-text" title={it.text}>{it.text}</span>
                    {it.attachments.length > 0 ? (
                      <span
                        className="dbg-queue-attach-tag"
                        title={`附带 ${it.attachments.length} 个附件`}
                      >
                        <Icon name="paperclip" size={10} /> {it.attachments.length}
                      </span>
                    ) : null}
                    <div className="dbg-queue-actions">
                      <button
                        type="button"
                        className="dbg-queue-icon-btn"
                        onClick={() => p.onStartEdit(it.id)}
                        title="编辑"
                        aria-label="编辑"
                      >
                        <Icon name="gear" size={11} />
                      </button>
                      <button
                        type="button"
                        className="dbg-queue-icon-btn"
                        onClick={() => p.onMoveUp(it.id)}
                        disabled={i === 0}
                        title={i === 0 ? '已是第一条' : '上移一位'}
                        aria-label="上移"
                      >
                        <Icon name="arrow-up" size={11} />
                      </button>
                      <button
                        type="button"
                        className="dbg-queue-icon-btn warn"
                        onClick={() => p.onRemove(it.id)}
                        title="删除"
                        aria-label="删除"
                      >
                        <Icon name="trash" size={11} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// =============================================================================
// AskBlock — clickable choice buttons rendered from a Clarifier `<ask>`.
// Single-select: clicking an option immediately drops the answer into the
// input field. Multi-select: pills toggle, then a "确认" button drops the
// joined answer in. User still presses Send to actually submit.
// =============================================================================
function AskBlock({
  data,
  onAnswer,
}: {
  data: AskBlockData;
  onAnswer?: (question: string, picked: string[]) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  function togglePick(opt: string): void {
    setPicked((prev) => {
      if (data.multi) {
        const next = new Set(prev);
        if (next.has(opt)) next.delete(opt);
        else next.add(opt);
        return next;
      }
      // Single-select: click commits immediately.
      onAnswer?.(data.question, [opt]);
      return new Set([opt]);
    });
  }

  return (
    <div className="dbg-ask-block">
      <div className="dbg-ask-q">{data.question}</div>
      <div className="dbg-ask-options">
        {data.options.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`dbg-ask-option ${picked.has(opt) ? 'selected' : ''}`}
            onClick={() => togglePick(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      {data.multi ? (
        <div className="dbg-ask-confirm-row">
          <button
            type="button"
            className="dbg-text-btn"
            onClick={() => onAnswer?.(data.question, Array.from(picked))}
            disabled={picked.size === 0}
          >
            确认所选 ({picked.size})
          </button>
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// BriefHandoff — the "✓ 转交给 Coder" button shown under a Clarifier
// message that contains a `<brief>`. Clicking starts the Coder turn with
// the brief baked into its system context.
// =============================================================================
function BriefHandoff({ brief, onSend }: { brief: string; onSend: () => void }): JSX.Element {
  const [showBrief, setShowBrief] = useState(false);
  return (
    <div className="dbg-brief-block">
      <div className="dbg-brief-head">
        <Icon name="check" size={12} /> 需求已经梳理完了
      </div>
      <div className="dbg-brief-actions">
        <button type="button" className="dbg-primary-btn" onClick={onSend}>
          <Icon name="send" size={12} /> 转交给 Coder
        </button>
        <button
          type="button"
          className="dbg-text-btn"
          onClick={() => setShowBrief((v) => !v)}
        >
          {showBrief ? '收起 brief' : '查看 brief'}
        </button>
      </div>
      {showBrief ? (
        <pre className="dbg-brief-body">{brief}</pre>
      ) : null}
    </div>
  );
}

function ToolCallBlock({ json }: { json: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  let parsed: ToolCall | null = null;
  try {
    parsed = JSON.parse(json) as ToolCall;
  } catch {
    /* malformed — fall back to raw display */
  }
  const name = parsed?.name ?? '?';
  return (
    <div className="dbg-tool-block">
      <div className="dbg-tool-block-head" onClick={() => setOpen(!open)}>
        <Icon name="tool" size={12} />
        调用 <span className="dbg-tool-name">{name}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </div>
      {open ? <pre className="dbg-tool-block-body">{json}</pre> : null}
    </div>
  );
}

function ToolResultBlock({ text }: { text: string }): JSX.Element {
  // First line: "【name】 ok" or "【name】 err". Strip it for the head, keep
  // the rest as the expandable body.
  const m = /^【(.+?)】\s+(ok|err)\n?([\s\S]*)$/.exec(text);
  const name = m?.[1] ?? '?';
  const status = m?.[2] === 'ok' ? 'ok' : m?.[2] === 'err' ? 'err' : 'ok';
  const body = m?.[3] ?? text;
  // Default open for errors so the user immediately sees what blew up.
  const [open, setOpen] = useState(status === 'err');
  return (
    <div className="dbg-tool-block role-tool">
      <div className="dbg-tool-block-head" onClick={() => setOpen(!open)}>
        <Icon name={status === 'err' ? 'close' : 'check'} size={12} />
        结果 <span className="dbg-tool-name">{name}</span>
        <span className={`dbg-tool-status ${status}`}>{status === 'ok' ? '成功' : '失败'}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </div>
      {open ? <pre className="dbg-tool-block-body">{body}</pre> : null}
    </div>
  );
}
