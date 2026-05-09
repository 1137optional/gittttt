import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { FsBrowseResult, FsEntry } from '@shared/types';
import { Icon } from './Icon';

// =============================================================================
// FolderBrowserModal — replaces the old "paste a path" textbox.
//
// Layout:
//   ┌───────────────────────────────────────────────────────────┐
//   │  [↑]  /Users/mac › projects › my-app          [☐ hidden] │  <breadcrumbs row>
//   ├───────────────────────────────────────────────────────────┤
//   │  ⌘  my-app          [Git]                       [打开] →  │
//   │  ⌘  another-folder                                     →  │
//   │  ⌘  notes                                              →  │
//   │  …                                                        │
//   ├───────────────────────────────────────────────────────────┤
//   │                          [打开当前文件夹] (if .git here)  │
//   │                                          [取消]            │
//   └───────────────────────────────────────────────────────────┘
//
// Behaviour:
//   - Click a row → navigate INTO that folder.
//   - Git-repo rows have an extra "打开" button that opens the repo without
//     navigating (since 9 times out of 10 you don't need to look inside).
//   - "打开当前文件夹" footer appears only when the current directory itself
//     is a git repo (i.e. you navigated into one).
// =============================================================================

interface Props {
  onClose: () => void;
  /** Called with an absolute path to a *git repo* the user picked. */
  onPick: (path: string) => Promise<void> | void;
  /** Optional starting directory; defaults to $HOME. */
  initialPath?: string;
}

export function FolderBrowserModal({ onClose, onPick, initialPath }: Props): JSX.Element {
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .fsBrowse(path, showHidden)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, showHidden]);

  // ESC closes; ⌘/Ctrl+↑ goes to parent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp' && data?.parent) {
        e.preventDefault();
        setPath(data.parent);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, data?.parent]);

  // Split current path into clickable breadcrumb segments.
  const crumbs = useMemo(() => buildCrumbs(data?.path), [data?.path]);

  async function pick(p: string): Promise<void> {
    setOpening(p);
    try {
      await onPick(p);
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-browser" onClick={(e) => e.stopPropagation()}>
        <div className="folder-browser-head">
          <button
            type="button"
            className="topnav-action icon-only"
            onClick={() => data?.parent && setPath(data.parent)}
            disabled={!data?.parent}
            title="上一级 (⌘/Ctrl + ↑)"
            aria-label="上一级"
          >
            <Icon name="arrow-up" size={15} />
          </button>
          <button
            type="button"
            className="topnav-action icon-only"
            onClick={() => setPath(undefined)}
            title="主目录"
            aria-label="主目录"
          >
            <Icon name="home" size={15} />
          </button>

          <div className="folder-breadcrumbs">
            {crumbs.length === 0 ? (
              <span className="folder-breadcrumb-current">/</span>
            ) : (
              crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <span key={c.path} className="folder-breadcrumb-segment">
                    <button
                      type="button"
                      className={`folder-breadcrumb ${isLast ? 'current' : ''}`}
                      onClick={() => !isLast && setPath(c.path)}
                      disabled={isLast}
                      title={c.path}
                    >
                      {c.label}
                    </button>
                    {isLast ? null : <Icon name="chevron-right" size={12} className="folder-breadcrumb-sep" />}
                  </span>
                );
              })
            )}
          </div>

          <label className="folder-hidden-toggle" title="显示以 . 开头的隐藏目录">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>隐藏</span>
          </label>
        </div>

        <div className="folder-browser-body">
          {loading && !data ? (
            <p className="picker-empty">…</p>
          ) : error ? (
            <p className="picker-empty" style={{ color: 'var(--error)' }}>{error}</p>
          ) : data && data.entries.length === 0 ? (
            <p className="picker-empty">空</p>
          ) : (
            data?.entries.map((entry) => (
              <FolderRow
                key={entry.path}
                entry={entry}
                opening={opening === entry.path}
                disabled={opening !== null}
                onEnter={() => setPath(entry.path)}
                onOpen={() => void pick(entry.path)}
              />
            ))
          )}
        </div>

        <div className="folder-browser-foot">
          <span className="folder-browser-foot-hint">
            {data?.isGitRepo ? '当前是 git 仓库' : '点文件夹进入'}
          </span>
          {data?.isGitRepo ? (
            <button
              className="btn primary"
              onClick={() => void pick(data.path)}
              disabled={opening !== null}
            >
              {opening === data.path ? '…' : '打开此处'}
            </button>
          ) : null}
          <button className="text-btn" onClick={onClose} disabled={opening !== null}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

interface FolderRowProps {
  entry: FsEntry;
  opening: boolean;
  disabled: boolean;
  onEnter: () => void;
  onOpen: () => void;
}

function FolderRow({ entry, opening, disabled, onEnter, onOpen }: FolderRowProps): JSX.Element {
  return (
    <div
      className={`folder-row ${entry.isGitRepo ? 'is-git' : ''} ${entry.hidden ? 'is-hidden-name' : ''}`}
      onClick={onEnter}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEnter();
        }
      }}
    >
      <Icon
        name={entry.isGitRepo ? 'folder-git' : 'folder'}
        size={16}
        className={entry.isGitRepo ? 'folder-icon git' : 'folder-icon'}
      />
      <span className="folder-row-name">{entry.name}</span>
      {entry.isGitRepo ? <span className="pill ok">Git</span> : null}
      <span className="folder-row-spacer" />
      {entry.isGitRepo ? (
        <button
          type="button"
          className="btn primary folder-row-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          disabled={disabled}
        >
          {opening ? '…' : '打开'}
        </button>
      ) : (
        <Icon name="chevron-right" size={14} className="folder-row-chev" />
      )}
    </div>
  );
}

interface Crumb {
  label: string;
  path: string;
}

// Split an absolute path into clickable segments.
//   "/Users/mac/projects/my-app"
//   → [{label:"/", path:"/"}, {label:"Users", path:"/Users"}, …]
// Windows-y backslash paths are handled the same way.
function buildCrumbs(p: string | undefined): Crumb[] {
  if (!p) return [];
  const sep = p.includes('\\') ? '\\' : '/';
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const parts = p.split(/[\\/]/).filter(Boolean);
  const out: Crumb[] = [];
  if (isAbsolute && sep === '/') out.push({ label: '/', path: '/' });
  let acc = isAbsolute && sep === '/' ? '' : '';
  for (const part of parts) {
    acc = acc.endsWith(sep) || acc === '' ? `${acc}${part}` : `${acc}${sep}${part}`;
    if (sep === '/' && !acc.startsWith('/')) acc = `/${acc}`;
    out.push({ label: part, path: acc });
  }
  return out;
}
