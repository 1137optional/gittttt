import { useEffect, useMemo, useState } from 'react';

// Default Chinese reference for the commit-graph right-click menu. Stored as
// Markdown so the user can edit it freely (Markdown is the most common note
// format developers know). Saved overrides live in localStorage.
//
// We intentionally do NOT bundle a third-party Markdown library — the doc is
// short and the rendered subset is tiny, so a hand-rolled renderer (~100 LOC)
// keeps the bundle clean. Supported syntax (block-level): h1–h4, paragraph,
// bullet list (`- ` / `* `), code fences (```), table (GFM `|` syntax with a
// separator row). Inline: `**bold**`, `` `code` ``, plain text. Anything
// else falls through as a plain paragraph.

const DOCS_KEY = 'gittttt:docs:content';

const DEFAULT_DOCS_MD = `# 右键菜单说明

在提交历史图上 **右键单击任意 commit 节点（或所在行）** 会弹出下列菜单。
当工作区有未提交改动、或正处于 merge / rebase 中时，相关操作会先弹确认或被拒绝。

## 操作清单

| 菜单项 | 作用 |
| --- | --- |
| Checkout this commit (detached) | 把 \`HEAD\` 移到该 commit。之后处于 detached HEAD 状态，需要再 checkout 一个分支或基于此创建新分支才能继续。 |
| Create branch from this commit… | 弹窗新建一个以该 commit 为起点的分支。这是新建分支的 **唯一入口**（左侧栏不再有 "+ New branch" 按钮）。 |
| Cherry-pick onto … | 把该 commit 的 patch 重新应用到 **当前分支**。如果该 commit 已经是 \`HEAD\`，会被禁用。 |
| Revert this commit | 生成一个新的 commit 用来撤销该 commit 的改动（适合共享分支，不会改写历史）。 |
| Merge into … | 把该 commit（作为 ref）合并进当前分支。等价于合并指向该 commit 的分支顶端。 |
| Rebase … onto this commit | 把当前分支的 commits 在该 commit 之上重新应用。该 commit 已是 \`HEAD\` 时无意义。 |
| Push 当前分支 → 某分支 | 仅当该 commit 上挂着 **本地分支标签** 且不是当前分支时显示。每个符合条件的分支会出现一行，执行 \`git push origin <current>:<target>\`，把当前分支的 tip 推到远程的目标分支 ref。detached HEAD 时整组都不显示。 |
| Copy hash / Copy short hash | 复制完整 SHA 或 7 位短 SHA 到剪贴板。 |

## 小提示

- 这份文档是 **可编辑** 的，点右上角 \`Edit\` 即可。改完按 \`Save\` 存到浏览器；\`Reset\` 会恢复成内置版本。
- 内容用 **Markdown** 写：标题、段落、列表、表格、\`行内代码\`、\`\`\`代码块\`\`\`、**加粗** 都能用。
- 当前主题（浅 / 深）通过右上角 \`☀ / ☾\` 切换，会记住你的选择。
`;

export function LeftDocs(): JSX.Element {
  const [content, setContent] = useState<string>(() => loadStoredDocs());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');

  // Keep state in sync if another tab edited the docs.
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key !== DOCS_KEY) return;
      setContent(loadStoredDocs());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const isCustomized = useMemo(() => content !== DEFAULT_DOCS_MD, [content]);

  function startEdit(): void {
    setDraft(content);
    setEditing(true);
  }

  function save(): void {
    const next = draft.trimEnd() + '\n';
    try {
      window.localStorage.setItem(DOCS_KEY, next);
    } catch {
      // ignore — show the change anyway, it just won't persist
    }
    setContent(next);
    setEditing(false);
  }

  function cancel(): void {
    setEditing(false);
    setDraft('');
  }

  function reset(): void {
    if (!window.confirm('恢复成默认中文说明？当前自定义内容会丢失。')) return;
    try {
      window.localStorage.removeItem(DOCS_KEY);
    } catch {
      // ignore
    }
    setContent(DEFAULT_DOCS_MD);
    setEditing(false);
    setDraft('');
  }

  return (
    <div className="left-docs-pane">
      <div className="left-docs-toolbar">
        <span className="left-docs-status">
          {editing ? '编辑中' : isCustomized ? '已自定义' : '默认内容'}
        </span>
        <span className="left-docs-toolbar-spacer" />
        {editing ? (
          <>
            <button type="button" className="text-btn" onClick={cancel}>
              取消
            </button>
            <button type="button" className="text-btn primary" onClick={save}>
              保存
            </button>
          </>
        ) : (
          <>
            {isCustomized ? (
              <button type="button" className="text-btn warning" onClick={reset}>
                恢复默认
              </button>
            ) : null}
            <button type="button" className="text-btn primary" onClick={startEdit}>
              编辑
            </button>
          </>
        )}
      </div>

      {editing ? (
        <textarea
          className="left-docs-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      ) : (
        <div className="left-docs-rendered">
          {blocks.map((b, i) => (
            <BlockNode key={i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function loadStoredDocs(): string {
  try {
    const saved = window.localStorage.getItem(DOCS_KEY);
    if (saved !== null && saved.length > 0) return saved;
  } catch {
    // ignore
  }
  return DEFAULT_DOCS_MD;
}

// ---------------------------------------------------------------------------
// Tiny Markdown renderer — block-level parser + inline pass.
// Intentionally narrow: only what the docs need today.
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Blank line — separator.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block.
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimEnd().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      out.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }

    // Headings (# .. ####).
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4;
      out.push({ kind: 'heading', level, text: h[2].trim() });
      i++;
      continue;
    }

    // Table — at least a header row, separator row, and one body row.
    if (line.startsWith('|')) {
      const sep = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';
      if (/^\|[\s:|-]+\|?$/.test(sep)) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trimEnd().startsWith('|')) {
          rows.push(splitTableRow(lines[i].trimEnd()));
          i++;
        }
        out.push({ kind: 'table', header, rows });
        continue;
      }
    }

    // Bulleted list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, '').trimEnd());
        i++;
      }
      out.push({ kind: 'list', items });
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !lines[i].startsWith('|') &&
      !lines[i].startsWith('```')
    ) {
      para.push(lines[i].trimEnd());
      i++;
    }
    out.push({ kind: 'paragraph', text: para.join(' ') });
  }
  return out;
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function BlockNode({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${block.level}` as unknown) as 'h1';
      return <Tag className={`md-h md-h-${block.level}`}>{renderInline(block.text)}</Tag>;
    }
    case 'paragraph':
      return <p className="md-p">{renderInline(block.text)}</p>;
    case 'list':
      return (
        <ul className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'table':
      return (
        <table className="md-table">
          <thead>
            <tr>
              {block.header.map((h, i) => (
                <th key={i}>{renderInline(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{renderInline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

// Inline pass: split on backtick code spans and **bold** runs. Order matters
// — we tokenise code spans first so backticks inside `**` don't fight bold.
function renderInline(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  // Split into [code | nonCode]+ pairs.
  const re = /`([^`]+)`/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      pushBoldOrText(out, text.slice(cursor, m.index), key);
      key++;
    }
    out.push(
      <code key={`c-${key}`} className="md-inline-code">
        {m[1]}
      </code>,
    );
    key++;
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    pushBoldOrText(out, text.slice(cursor), key);
  }
  return out;
}

function pushBoldOrText(out: JSX.Element[], chunk: string, baseKey: number): void {
  const parts = chunk.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((p, i) => {
    if (!p) return;
    if (p.startsWith('**') && p.endsWith('**') && p.length >= 4) {
      out.push(
        <strong key={`b-${baseKey}-${i}`}>{p.slice(2, -2)}</strong>,
      );
    } else {
      out.push(<span key={`t-${baseKey}-${i}`}>{p}</span>);
    }
  });
}
