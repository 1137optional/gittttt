import { useEffect, useMemo, useState } from 'react';
import type { GitHubAuthStatus, GitHubRepoSummary, LocalRepoSummary } from '@shared/types';
import { useApp } from '../store';
import { api } from '../api';
import { FolderBrowserModal } from './FolderBrowserModal';
import { Icon } from './Icon';

// =============================================================================
// RepoPicker — first-run / "no repo open" landing page.
//
// Three sections, in priority order:
//   1. GitHub repos        — list every repo on the user's account, one-click
//      (open if cloned / clone if not), plus a "+ New repo" button.
//   2. Local clones        — repos already present in the configured repos dir
//      so a one-click reopen doesn't require GitHub auth.
//   3. "Open any folder…"  — escape hatch for repos outside the managed dir.
//
// GitHub auth is purely in-app: a Personal Access Token is pasted into the
// `TokenLoginModal`, validated via GET /user, then persisted server-side at
// ~/.gittttt/token (chmod 600). No CLI dependency.
// =============================================================================

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=gittttt';

interface Props {
  /** When provided, the picker behaves as a dismissable overlay (used when
   *  invoked from the TopNav while a repo is already open). When absent, it
   *  fills the screen as the cold-start landing page. */
  onClose?: () => void;
}

export function RepoPicker({ onClose }: Props = {}): JSX.Element {
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
  const [showLogin, setShowLogin] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

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
      } else {
        setRepos(null);
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

  async function signOut(): Promise<void> {
    setError(null);
    try {
      await api.githubSignOut();
      setAuth({ authenticated: false, reposDir: auth?.reposDir ?? '' });
      setRepos(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      // Server-side clone also attaches the resulting repo. We then call
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

  async function openPickedFolder(path: string): Promise<void> {
    setBusyKey('folder');
    setError(null);
    try {
      await openRepo(path);
      setShowFolderBrowser(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  // ESC closes the overlay variant. The cold-start variant has no close
  // semantics (there's no main view behind it).
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`repo-picker ${onClose ? 'repo-picker-overlay' : ''}`}>
      {onClose ? (
        <div className="picker-overlay-bar">
          <h1 className="picker-overlay-title">切换</h1>
          <button
            type="button"
            className="topnav-action icon-only"
            onClick={onClose}
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
      <div className="picker-grid">
        {/* ---- Local clones section (priority slot — most users have the
                repo on disk already and just want to pick it) ---- */}
        <section className="picker-card">
          <header className="picker-card-head">
            <div className="picker-head-titles">
              <h2>本地</h2>
              <p className="picker-card-sub">
                {localRepos.length > 0
                  ? `${localRepos.length} 个 · 最近打开 + ${auth?.reposDir ?? '默认目录'}`
                  : '暂无 — 从 GitHub 克隆，或浏览本地'}
              </p>
            </div>
          </header>
          {localRepos.length > 0 ? (
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
                      {busy ? '…' : '打开'}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        {/* ---- Browse local folders (replaces the old "paste a path" textbox).
                One click opens an in-app folder picker; the picker tags
                git-repo subfolders so you can open them without typing. ---- */}
        <section className="picker-card picker-card-compact">
          <header className="picker-card-head">
            <div className="picker-head-titles">
              <h2>浏览</h2>
              <p className="picker-card-sub">选个本地目录打开</p>
            </div>
            <button className="btn primary" onClick={() => setShowFolderBrowser(true)}>
              <Icon name="folder" size={14} />
              <span>浏览</span>
            </button>
          </header>
        </section>

        {/* ---- GitHub section (now bottom — useful for clone/create but
                not the first thing most users need) ---- */}
        <section className="picker-card">
          <header className="picker-card-head">
            <div className="picker-head-titles">
              <h2>
                <Icon name="github" size={18} />
                <span>GitHub</span>
              </h2>
              <p className="picker-card-sub">
                {auth?.authenticated
                  ? `${auth.user ?? '未知'} · ${auth.reposDir}`
                  : '粘贴 Personal Access Token 登录'}
              </p>
            </div>
            {auth?.authenticated ? (
              <div className="picker-actions">
                <button
                  type="button"
                  className="topnav-action icon-only"
                  onClick={() => void loadAuthAndLists()}
                  disabled={loadingRepos}
                  title={loadingRepos ? '刷新中…' : '刷新'}
                  aria-label="刷新"
                >
                  <Icon name="refresh" size={16} className={loadingRepos ? 'spin' : undefined} />
                </button>
                <button className="btn primary" onClick={() => setShowCreate(true)}>
                  <Icon name="plus" size={14} /> 新建
                </button>
                <button className="text-btn warning" onClick={() => void signOut()}>
                  退出
                </button>
              </div>
            ) : null}
          </header>

          {!auth ? (
            <p className="picker-empty">检查中…</p>
          ) : !auth.authenticated ? (
            <div className="picker-auth-help">
              <p>{auth.error ?? '未登录。'}</p>
              <p className="picker-auth-blurb">
                粘贴 Personal Access Token 即可，token 仅存在本机{' '}
                <code>~/.gittttt/token</code>（权限 600）。
              </p>
              <div className="picker-actions">
                <button className="btn primary" onClick={() => setShowLogin(true)}>
                  <Icon name="github" size={14} /> 登录
                </button>
                <button className="text-btn" onClick={() => void loadAuthAndLists()}>
                  重试
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                className="picker-search"
                type="text"
                placeholder="搜索…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="picker-list">
                {repos && filtered.length === 0 ? (
                  <p className="picker-empty">
                    {repos.length === 0 ? '无仓库' : '无匹配'}
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
                        {busy ? '…' : r.localPath ? '打开' : '克隆'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {error ? <div className="picker-error">{error}</div> : null}
      </div>

      {showLogin ? (
        <TokenLoginModal
          onClose={() => setShowLogin(false)}
          onSignedIn={async () => {
            setShowLogin(false);
            await loadAuthAndLists();
          }}
        />
      ) : null}

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

      {showFolderBrowser ? (
        <FolderBrowserModal
          onClose={() => setShowFolderBrowser(false)}
          onPick={openPickedFolder}
        />
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// PAT login modal
// -----------------------------------------------------------------------------

interface TokenLoginModalProps {
  onClose: () => void;
  onSignedIn: () => Promise<void> | void;
}

function TokenLoginModal({ onClose, onSignedIn }: TokenLoginModalProps): JSX.Element {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.githubSignIn(t);
      await onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="github" size={18} />
          <span>登录 GitHub</span>
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          点按钮去 GitHub 生成 token（scope 已预填），粘贴回来即可。token 仅存于本机
          <code> ~/.gittttt/token</code>。
        </p>

        <div className="picker-actions" style={{ marginTop: 4 }}>
          <a
            className="btn primary"
            href={TOKEN_URL}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
          >
            <Icon name="external" size={14} />
            <span>去创建 Token</span>
          </a>
        </div>

        <label className="modal-field">
          <span>Token</span>
          <textarea
            placeholder="ghp_xxx... 或 github_pat_xxx..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={3}
            spellCheck={false}
            autoFocus
            style={{ fontFamily: 'var(--font-code)', fontSize: 12 }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          <span className="modal-hint">⌘/Ctrl + Enter</span>
        </label>

        {error ? <div className="modal-error">{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="text-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || token.trim().length < 20}
          >
            {busy ? '…' : '登录'}
          </button>
        </div>
      </div>
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
        <h3 style={{ margin: 0 }}>新建仓库</h3>
        <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--fg-muted)' }}>
          克隆到 {reposDir || '默认目录'}
        </p>

        <label className="modal-field">
          <span>名称</span>
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
            <span className="modal-hint warning">只允许 A-Z 0-9 . _ -</span>
          ) : null}
        </label>

        <label className="modal-field">
          <span>描述</span>
          <input
            type="text"
            placeholder="可选"
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
          <span>包含 README</span>
        </label>

        {error ? <div className="modal-error">{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="text-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? '…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
