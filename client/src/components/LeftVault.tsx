import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../api';
import type { VaultDoc, VaultDocSummary, VaultDocType } from '@shared/types';

// =============================================================================
// LeftVault — left-sidebar page that shows all Vault docs across all projects.
//
// Vault docs are structured (typed, titled) documents the AI writes and the
// user can read. Only the user can delete them (requires Guardian unlock).
// The AI cannot delete Vault docs.
// =============================================================================

const TYPE_LABELS: Record<VaultDocType, string> = {
  overview: '📋 概览',
  decision: '🏛 决策',
  retrospective: '🔁 复盘',
  gotcha: '⚠️ 坑',
  note: '📝 笔记',
  daily_report: '📅 日报',
};

const TYPE_COLORS: Record<VaultDocType, string> = {
  overview: '#4a90d9',
  decision: '#7c5cbf',
  retrospective: '#2d9c5e',
  gotcha: '#c0392b',
  note: '#888',
  daily_report: '#d4811a',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shortPath(abs: string | null): string {
  if (!abs) return '(未知项目)';
  const parts = abs.split('/').filter(Boolean);
  return parts[parts.length - 1] || abs;
}

// =============================================================================
// Doc detail view
// =============================================================================
function DocDetail({
  id,
  onBack,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const [doc, setDoc] = useState<VaultDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void api.getVaultDoc(id).then(setDoc).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [id]);

  async function handleDelete() {
    if (!confirm('删除 Vault 文档无法撤销。继续？')) return;
    setDeleting(true);
    try {
      const { token } = await api.guardianUnlock();
      await api.deleteVaultDoc(id, token);
      await api.guardianRevoke();
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  if (loading) return <div className="vault-loading">加载中…</div>;
  if (error) return <div className="vault-error">{error}</div>;
  if (!doc) return <div className="vault-error">文档不存在</div>;

  const color = TYPE_COLORS[doc.type] ?? '#888';

  return (
    <div className="vault-detail">
      <div className="vault-detail-head">
        <button className="vault-back-btn" onClick={onBack}>← 返回</button>
        <span className="vault-type-badge" style={{ color }}>
          {TYPE_LABELS[doc.type] ?? doc.type}
        </span>
      </div>
      <h2 className="vault-detail-title">{doc.title}</h2>
      <div className="vault-detail-meta">
        <span>{shortPath(doc.projectRef)}</span>
        <span>·</span>
        <span>{doc.author === 'soul' ? '🤖 AI 写' : '✏️ 你写'}</span>
        <span>·</span>
        <span>{formatTime(doc.updatedAt)}</span>
        {doc.tags.length > 0 && (
          <>
            <span>·</span>
            <span>{doc.tags.join(', ')}</span>
          </>
        )}
      </div>
      <pre className="vault-detail-content">{doc.content}</pre>
      <div className="vault-detail-actions">
        <button
          className="vault-delete-btn"
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? '删除中…' : '🗑 删除此文档'}
        </button>
      </div>
      {error && <div className="vault-error">{error}</div>}
    </div>
  );
}

// =============================================================================
// Main list view
// =============================================================================
export function LeftVault(): JSX.Element {
  const [items, setItems] = useState<VaultDocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<VaultDocType | 'all'>('all');
  const [generating, setGenerating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listVault(filterType !== 'all' ? { type: filterType } : undefined);
      setItems(r.items);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [filterType]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleGenerateReport() {
    setGenerating(true);
    try {
      await api.generateDailyReport();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  if (openId) {
    return (
      <DocDetail
        id={openId}
        onBack={() => setOpenId(null)}
        onDeleted={() => { setOpenId(null); void reload(); }}
      />
    );
  }

  return (
    <div className="vault-list">
      <div className="vault-list-head">
        <span className="vault-list-title">文档库</span>
        <button
          className="vault-gen-btn"
          onClick={() => void handleGenerateReport()}
          disabled={generating}
          title="立即生成今日日报"
        >
          {generating ? '…' : '📅'}
        </button>
        <button className="vault-refresh-btn" onClick={() => void reload()} title="刷新">
          <Icon name="refresh" />
        </button>
      </div>

      <div className="vault-filter-row">
        {(['all', 'overview', 'decision', 'retrospective', 'gotcha', 'note', 'daily_report'] as const).map((t) => (
          <button
            key={t}
            className={`vault-filter-btn ${filterType === t ? 'active' : ''}`}
            onClick={() => setFilterType(t)}
          >
            {t === 'all' ? '全部' : (TYPE_LABELS[t] ?? t)}
          </button>
        ))}
      </div>

      {loading && <div className="vault-loading">加载中…</div>}
      {error && <div className="vault-error">{error}</div>}
      {!loading && items.length === 0 && (
        <div className="vault-empty">
          暂无文档。AI 在完成功能、调试踩坑后会自动写入。
        </div>
      )}

      <div className="vault-items">
        {items.map((doc) => {
          const color = TYPE_COLORS[doc.type] ?? '#888';
          return (
            <div
              key={doc.id}
              className="vault-item"
              onClick={() => setOpenId(doc.id)}
            >
              <div className="vault-item-head">
                <span className="vault-item-type" style={{ color }}>
                  {TYPE_LABELS[doc.type] ?? doc.type}
                </span>
                <span className="vault-item-project">{shortPath(doc.projectRef)}</span>
                <span className="vault-item-author">
                  {doc.author === 'soul' ? '🤖' : '✏️'}
                </span>
              </div>
              <div className="vault-item-title">{doc.title}</div>
              {doc.excerpt && <div className="vault-item-excerpt">{doc.excerpt}</div>}
              <div className="vault-item-time">{formatTime(doc.updatedAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
