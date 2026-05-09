import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../api';
import type { ProjectMemory, ProjectMemorySummary } from '@shared/types';

// =============================================================================
// LeftMemory — left-sidebar page that lists ALL stored project memories
// (including ones whose project folder no longer exists), and lets the
// user view + permanently delete each one.
//
// Memory is AI-managed: there's no "edit" button here. The AI writes it
// during chat (writeMemory / appendMemory tools); the user only reads
// + deletes. Showing orphaned memories matters because the whole point
// of decoupling memory from the project folder is "if you re-open this
// project later you don't lose the AI's accumulated context."
// =============================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getTime() === 0) return '从未';
  // Show "刚刚 / N 分钟前 / N 小时前 / yyyy-mm-dd hh:mm" depending on age.
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortPath(abs: string | null): string {
  if (!abs) return '(未知路径)';
  // Last two segments are usually enough — full path lives in the title attr.
  const parts = abs.split('/').filter(Boolean);
  if (parts.length <= 2) return abs;
  return `…/${parts.slice(-2).join('/')}`;
}

export function LeftMemory(): JSX.Element {
  const [items, setItems] = useState<ProjectMemorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Currently expanded memory (null = list view; key = detail view).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<ProjectMemory | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listMemories();
      setItems(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  // Reload when the window regains focus — covers the case where the AI
  // wrote a new memory while user had a different tab open.
  useEffect(() => {
    function onFocus(): void { void reload(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  async function openMemory(key: string): Promise<void> {
    if (openKey === key) {
      setOpenKey(null);
      setOpenDetail(null);
      return;
    }
    setOpenKey(key);
    setOpenDetail(null);
    try {
      const m = await api.getMemoryByKey(key);
      // Guard against stale fetch: only commit if the user is still on
      // this key when the request returns.
      setOpenKey((cur) => {
        if (cur === key) setOpenDetail(m);
        return cur;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteMemory(key: string): Promise<void> {
    try {
      await api.deleteMemory(key);
      if (openKey === key) {
        setOpenKey(null);
        setOpenDetail(null);
      }
      setPendingDelete(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="left-memory">
      <div className="left-memory-head">
        <div className="left-memory-title">
          <Icon name="file" size={13} />
          项目记忆
        </div>
        <button
          type="button"
          className="topnav-action icon-only"
          onClick={() => void reload()}
          title="刷新"
          aria-label="刷新"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="left-memory-hint">
        每个项目一份 Markdown 笔记，AI 自己写、自己更新。
        项目删了笔记还在；只有在这里删才真删。
      </div>

      {error ? <div className="left-memory-error">{error}</div> : null}

      {loading && items.length === 0 ? (
        <div className="left-memory-empty">加载中…</div>
      ) : items.length === 0 ? (
        <div className="left-memory-empty">
          还没有任何记忆。
          <br />
          打开一个项目 → 在调试模式开「项目记忆」skill →
          AI 会在对话里自己生成。
        </div>
      ) : (
        <ul className="left-memory-list">
          {items.map((it) => {
            const open = openKey === it.key;
            const orphan = !it.repoExists;
            return (
              <li
                key={it.key}
                className={`left-memory-item ${open ? 'open' : ''} ${orphan ? 'orphan' : ''}`}
              >
                <div
                  className="left-memory-row"
                  onClick={() => void openMemory(it.key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void openMemory(it.key);
                    }
                  }}
                  title={it.repoPath ?? '(原路径未记录)'}
                >
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                  <div className="left-memory-row-meta">
                    <div className="left-memory-row-name">
                      {shortPath(it.repoPath)}
                      {orphan ? <span className="left-memory-orphan-tag">已不存在</span> : null}
                    </div>
                    <div className="left-memory-row-sub">
                      {formatBytes(it.bytes)} · {formatTime(it.updatedAt)}
                    </div>
                    {it.excerpt ? (
                      <div className="left-memory-row-excerpt">{it.excerpt}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="left-memory-del-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(it.key);
                    }}
                    title="删除这条记忆"
                    aria-label="删除"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
                {open ? (
                  <div className="left-memory-detail">
                    {openDetail && openDetail.key === it.key ? (
                      openDetail.content ? (
                        <pre className="left-memory-md">{openDetail.content}</pre>
                      ) : (
                        <div className="left-memory-empty-detail">（空）</div>
                      )
                    ) : (
                      <div className="left-memory-empty-detail">读取中…</div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {pendingDelete ? (
        <div
          className="left-memory-confirm-backdrop"
          onClick={() => setPendingDelete(null)}
          role="presentation"
        >
          <div
            className="left-memory-confirm"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="确认删除记忆"
          >
            <div className="left-memory-confirm-title">删除这条记忆？</div>
            <div className="left-memory-confirm-body">
              这会永久删掉 AI 给该项目积累的全部笔记。
              如果以后再打开这个项目，AI 会从零开始重新认识它。
            </div>
            <div className="left-memory-confirm-actions">
              <button
                type="button"
                className="dbg-text-btn"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="dbg-primary-btn warn"
                onClick={() => void deleteMemory(pendingDelete)}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
