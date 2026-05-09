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
const MAX_PERSISTED = 80;
const MAX_TOOL_TURNS = 5;
const TOOL_RESULT_PREFIX = '工具执行结果：';

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
}

type ChatItem = MsgItem;

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
    description: '在项目根执行 shell 命令（30s 超时）',
    paramsHint: '{"command": string, "cwd"?: string, "timeout"?: number}',
  },
  {
    name: 'gitOperation',
    description: '调当前仓库的 Git 命令',
    paramsHint: '{"op": "status"|"diff"|"log"|"checkout", "args"?: object}',
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
};

function buildToolList(skills: Skill[]): ToolDef[] {
  const enabled = skills.filter((s) => s.enabled);
  const grant = (perm: keyof Skill['permissions']): boolean =>
    enabled.some((s) => s.permissions[perm]);
  return ALL_TOOLS.filter((t) => grant(TOOL_PERMS[t.name]));
}

function buildSystemPrompt(skills: Skill[], tools: ToolDef[]): string {
  const enabled = skills.filter((s) => s.enabled);
  const lines: string[] = [
    '你是 gittttt 的调试助手。回答尽量简洁、给出可执行的解决方案，不要写废话。',
    '所有回复使用中文。',
  ];
  for (const s of enabled) {
    if (s.systemPrompt.trim()) lines.push(s.systemPrompt.trim());
  }
  if (tools.length > 0) {
    lines.push('');
    lines.push('你有以下工具可调用。**调用方式**：在你的回复正文里直接写出（每个一行）：');
    lines.push('<tool_call>{"name":"工具名","args":{...}}</tool_call>');
    lines.push('每条 <tool_call> 必须是合法 JSON。我会执行它们，把结果作为 system 消息回给你，然后你再继续。');
    lines.push('如果不需要调用工具就直接回答即可。一次最多发 3 个 tool_call。');
    lines.push('');
    lines.push('可用工具：');
    for (const t of tools) {
      lines.push(`- ${t.name} : ${t.description}  args: ${t.paramsHint}`);
    }
  }
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
async function executeTool(call: ToolCall, allowed: Set<string>): Promise<string> {
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
    default:
      throw new Error(`未知工具: ${call.name as string}`);
  }
}

interface Props {
  /** Skills, owned by the parent (DebugLayout) so the gear button can mutate. */
  skills: Skill[];
  /** Open the SkillsPanel overlay. */
  onOpenSkills(): void;
}

export function AIAgentPanel({ skills, onOpenSkills }: Props): JSX.Element {
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
  const listRef = useRef<HTMLDivElement | null>(null);

  const isConfigured = apiKey.length > 0;

  // Recompute tool list / system prompt only when the skill catalog changes.
  // useMemo here keeps the system prompt out of the per-keystroke render path.
  const tools = useMemo(() => buildToolList(skills), [skills]);
  const systemPrompt = useMemo(() => buildSystemPrompt(skills, tools), [skills, tools]);
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

  useEffect(() => {
    writeItems(items);
  }, [items]);

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
  // -------------------------------------------------------------------------
  async function runChatLoop(seedItems: ChatItem[]): Promise<ChatItem[]> {
    let convo = seedItems;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const wire: AIChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...convo.map(toWireMsg),
      ];
      const res = await api.aiChat({ provider: 'deepseek', apiKey, messages: wire });
      const reply: MsgItem = {
        kind: 'msg',
        id: nextId('m'),
        msg: { role: 'assistant', content: res.content },
      };
      convo = [...convo, reply];
      setItems(convo);

      const calls = parseToolCalls(res.content);
      if (calls.length === 0) return convo;

      const outputs: string[] = [];
      for (const call of calls) {
        try {
          const out = await executeTool(call, allowedPerms);
          outputs.push(`【${call.name}】 ok\n${clampResult(out)}`);
        } catch (e) {
          outputs.push(`【${call.name}】 err\n${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const sys: MsgItem = {
        kind: 'msg',
        id: nextId('m'),
        msg: {
          role: 'system',
          content: TOOL_RESULT_PREFIX + '\n' + outputs.join('\n\n---\n\n'),
        },
      };
      convo = [...convo, sys];
      setItems(convo);
    }
    return [
      ...convo,
      {
        kind: 'msg',
        id: nextId('m'),
        msg: {
          role: 'system',
          content: `${TOOL_RESULT_PREFIX}\n（已达到 ${MAX_TOOL_TURNS} 轮工具调用上限，停止）`,
        },
      },
    ];
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
    setError(null);

    const userItem: MsgItem = {
      kind: 'msg',
      id: nextId('m'),
      msg: { role: 'user', content: text },
      attachments: pending.length > 0 ? pending.slice() : undefined,
    };

    const next: ChatItem[] = [...items, userItem];
    setItems(next);
    setInput('');
    // Drain the pending queue — these are now persisted on the user msg.
    setPending([]);
    setBusy(true);
    try {
      const final = await runChatLoop(next);
      setItems(final);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems(next);
    } finally {
      setBusy(false);
    }
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
                />
              ))
            )}
            {busy ? (
              <div className="dbg-ai-msg role-assistant pending">
                <div className="dbg-ai-msg-role">DeepSeek</div>
                <div className="dbg-ai-dots">
                  <span /> <span /> <span />
                </div>
              </div>
            ) : null}
          </div>

          <div className="dbg-ai-composer">
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
                  pending.length > 0
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
                  className="dbg-primary-btn dbg-send-btn"
                  onClick={() => void send()}
                  disabled={busy || (!input.trim() && pending.length === 0)}
                  title="发送 (⌘/Ctrl + Enter)"
                >
                  <Icon name="send" size={14} />
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
}: {
  item: MsgItem;
  onDelete?: () => void;
  onPreview?: (a: Attachment) => void;
}): JSX.Element | null {
  const { msg, attachments } = item;
  if (msg.role === 'system' && msg.content.startsWith(TOOL_RESULT_PREFIX)) {
    const body = msg.content.slice(TOOL_RESULT_PREFIX.length).trim();
    const blocks = body.split(/\n\n---\n\n/);
    return (
      <div className="dbg-ai-msg role-tool">
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
    return (
      <div className="dbg-ai-msg role-assistant">
        <div className="dbg-ai-msg-role">DeepSeek</div>
        <div className="dbg-ai-msg-body">
          <AssistantContent text={msg.content} />
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
function AssistantContent({ text }: { text: string }): JSX.Element {
  const parts: { kind: 'text' | 'call'; value: string }[] = [];
  let cursor = 0;
  TOOL_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    if (m.index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, m.index) });
    parts.push({ kind: 'call', value: m[1].trim() });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });

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
