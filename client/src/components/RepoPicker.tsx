import { useEffect, useMemo, useState } from 'react';
import type { GitHubAuthStatus, GitHubRepoSummary, LocalRepoSummary } from '@shared/types';
import { useApp } from '../store';
import { api } from '../api';

// =============================================================================
// RepoPicker — first-run / "no repo open" landing page.
//
// Three sections, in priority order:
//   1. GitHub repos        → list every repo on the user's account, one-click
//      (open if cloned / clone if not), plus a "+ New repo" button.
//   2. Local clones        → repos already present in the configured repos dir
//      so a one-click reopen doesn't require GitHub auth.
//   3. "Open any folder…"  → escape hatch for repos outside the managed dir.
//
// All GitHub operations go through `gh` on the server. If the user hasn't
// installed / logged into `gh`, section 1 collapses to an explainer and the
// other sections still work.
// =============================================================================

export function RepoPicker(): JSX.Element {
  const openRepo = useApp((s) => s.openRepo);
  const refreshAll = useApp((s) => s.refreshAll);

  const [auth, setAuth] = useState<GitHubAuthStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [localRepos, setLocalRepos] = useState<LocalRepoSummary[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showCustomPath, setShowCustomPath] = useState(false);
  const [customPath, setCustomPath] = useState('');

  useEffect(() => {
    void loadAuthAndLists();
  }, []);

  async function loadAuthAndLists(): Promise<void> {
    try {
      const a = await api.githubAuth();
      setAuth(a);
      if (a.authenticated) {
        setLoadingRepos(true);
        try {
          const list = await api.githubRepos();
          setRepos(list);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoadingRepos(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      setLocalRepos(await api.localRepos());
    } catch {
      // non-fatal: local-repo scan failures shouldn't block the picker
    }
  }

  const filtered = useMemo<GitHubRepoSummary[]>(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.nameWithOwner.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [repos, query]);

  async function openOrClone(r: GitHubRepoSummary): Promise<void> {
    setBusyKey(`gh:${r.nameWithOwner}`);
    setError(null);
    try {
      if (r.localPath) {
        await openRepo(r.localPath);
        return;
      }
      // Server-side clone also attaches the resulting repo. Calling
      // `openRepo(path)` again would just re-attach (no-op). We use
      // refreshAll so the standard "Opened repository" toast comes from a
      // single code path.
      await api.githubClone(r.nameWithOwner);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function openLocal(r: LocalRepoSummary): Promise<void> {
    setBusyKey(`local:${r.path}`);
    setError(null);
    try {
      await openRepo(r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function openCustom(): Promise<void> {
    if (!customPath.trim()) return;
    setBusyKey('custom');
    setError(null);
    try {
      await openRepo(customPath.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="repo-picker">
      <div className="glyph">
        <div className="brand-logo">G</div>
        <span>GitFlow</span>
      </div>

      <div className="picker-grid">
        {/* ---- GitHub section ---- */}
        <section className="picker-card">
          <header className="picker-card-head">
            <div>
              <h2>GitHub 仓库</h2>
              <p className="picker-card-sub">
                {auth?.authenticated
                  ? `已登录：${auth.user ?? '未知账号'}  ·  克隆到 ${auth.reposDir}`
                  : '通过本机 gh CLI 一次性导入你的所有 GitHub 仓库'}
              </p>
            </div>
            {auth?.authenticated ? (
              <div className="picker-actions">
                <button
                  className="text-btn"
                  onClick={() => void loadAuthAndLists()}
                  disabled={loadingRepos}
                >
                  {loadingRepos ? '刷新中…' : '刷新'}
                </button>
                <button className="btn primary" onClick={() => setShowCreate(true)}>
                  + 新建仓库
                </button>
              </div>
            ) : null}
          </header>

          {!auth ? (
            <p className="picker-empty">正在检查 gh 登录状态…</p>
          ) : !auth.authenticated ? (
            <div className="picker-auth-help">
              <p>{auth.error ?? '未登录到 GitHub。'}</p>
              <ol>
                <li>
                  安装 GitHub CLI：<code>brew install gh</code> （或访问{' '}
                  <a href="https://cli.github.com" target="_blank" rel="noreferrer">
                    cli.github.com
                  </a>
                  ）
                </li>
                <li>
                  登录：<code>gh auth login</code>
                </li>
                <li>
                  回到这里点{' '}
                  <button className="text-btn" onClick={() => void loadAuthAndLists()}>
                    重新检查
                  </button>
                </li>
              </ol>
            </div>
          ) : (
            <>
              <input
                className="picker-search"
                type="text"
                placeholder="按名称 / 描述过滤…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="picker-list">
                {repos && filtered.length === 0 ? (
                  <p className="picker-empty">
                    {repos.length === 0 ? '账号下没有仓库。' : '没有匹配的仓库。'}
                  </p>
                ) : null}
                {filtered.map((r) => {
                  const key = `gh:${r.nameWithOwner}`;
                  const busy = busyKey === key;
                  return (
                    <div className="picker-row" key={r.nameWithOwner}>
                      <div className="picker-row-main">
                        <div className="picker-row-title">
                          {r.name}
                          <span className={`pill visibility ${r.visibility.toLowerCase()}`}>
                            {r.visibility === 'PRIVATE' ? '私有' : r.visibility === 'INTERNAL' ? '内部' : '公开'}
                          </span>
                          {r.isFork ? <span className="pill subtle">fork</span> : null}
                          {r.isArchived ? <span className="pill subtle">归档</span> : null}
                          {r.localPath ? <span className="pill ok">已克隆</span> : null}
                        </div>
                        <div className="picker-row-sub">
                          <span className="picker-row-owner">{r.nameWithOwner}</span>
                          {r.description ? <span> · {r.description}</span> : null}
                        </div>
                      </div>
                      <button
                        className="btn"
                        onClick={() => void openOrClone(r)}
                        disabled={busy || busyKey !== null}
                      >
                        {busy ? '处理中…' : r.localPath ? '打开' : '克隆并打开'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* ---- Local clones section ---- */}
        {localRepos.length > 0 ? (
          <section className="picker-card picker-card-compact">
            <header className="picker-card-head">
              <div>
                <h2>本地仓库</h2>
                <p className="picker-card-sub">
                  之前克隆 / 打开过的本地仓库（{auth?.reposDir ?? '默认目录'}）
                </p>
              </div>
            </header>
            <div className="picker-list">
              {localRepos.map((r) => {
                const key = `local:${r.path}`;
                const busy = busyKey === key;
                return (
                  <div className="picker-row" key={r.path}>
                    <div className="picker-row-main">
                      <div className="picker-row-title">
                        {r.name}
                        {r.isCurrent ? <span className="pill ok">当前</span> : null}
                      </div>
                      <div className="picker-row-sub">{r.path}</div>
                    </div>
                    <button
                      className="btn"
                      onClick={() => void openLocal(r)}
                      disabled={busy || busyKey !== null}
                    >
                      {busy ? '打开中…' : '打开'}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* ---- Custom path fallback ---- */}
        <section className="picker-card picker-card-compact">
          <header className="picker-card-head">
            <div>
              <h2>打开任意本地路径</h2>
              <p className="picker-card-sub">仓库不在管理目录里时，手动粘贴路径打开</p>
            </div>
            <button
              className="text-btn"
              onClick={() => setShowCustomPath((v) => !v)}
            >
              {showCustomPath ? '收起' : '展开'}
            </button>
          </header>
          {showCustomPath ? (
            <div className="picker-custom-row">
              <input
                type="text"
                placeholder="/Users/you/projects/repo"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void openCustom();
                }}
              />
              <button
                className="btn primary"
                onClick={() => void openCustom()}
                disabled={busyKey === 'custom' || !customPath.trim()}
              >
                {busyKey === 'custom' ? '打开中…' : '打开'}
              </button>
            </div>
          ) : null}
        </section>

        {error ? <div className="picker-error">{error}</div> : null}
      </div>

      {showCreate ? (
        <CreateRepoModal
          reposDir={auth?.reposDir ?? ''}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refreshAll();
          }}
        />
      ) : null}
    </div>
  );
}

interface CreateRepoModalProps {
  reposDir: string;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

function CreateRepoModal({ reposDir, onClose, onCreated }: CreateRepoModalProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [addReadme, setAddReadme] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^[A-Za-z0-9._-]+$/.test(name) && name.length > 0;

  async function submit(): Promise<void> {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.githubCreate({ name: name.trim(), description: description.trim(), isPrivate, addReadme });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>新建 GitHub 仓库</h3>
        <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--fg-muted)' }}>
          会同时在 GitHub 上创建并克隆到 {reposDir || '本地默认目录'}
        </p>

        <label className="modal-field">
          <span>仓库名</span>
          <input
            type="text"
            placeholder="my-new-app"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) void submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          {name && !valid ? (
            <span className="modal-hint warning">只能包含字母、数字、点、横线、下划线。</span>
          ) : null}
        </label>

        <label className="modal-field">
          <span>描述（可选）</span>
          <input
            type="text"
            placeholder="一句话说明…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="modal-field-group">
          <label className="modal-radio">
            <input
              type="radio"
              checked={isPrivate}
              onChange={() => setIsPrivate(true)}
            />
            <span>私有</span>
          </label>
          <label className="modal-radio">
            <input
              type="radio"
              checked={!isPrivate}
              onChange={() => setIsPrivate(false)}
            />
            <span>公开</span>
          </label>
        </div>

        <label className="modal-checkbox">
          <input type="checkbox" checked={addReadme} onChange={(e) => setAddReadme(e.target.checked)} />
          <span>初始化 README（推荐，避免空仓库克隆失败）</span>
        </label>

        {error ? <div className="modal-error">{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="text-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? '创建中…' : '创建并克隆'}
          </button>
        </div>
      </div>
    </div>
  );
}
