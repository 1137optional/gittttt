import { useState } from 'react';
import { useApp } from '../store';
import { RepoSwitcher } from './RepoSwitcher';

export function Toolbar(): JSX.Element {
  const repo = useApp((s) => s.repo);
  const isLoading = useApp((s) => s.isLoading);
  const searchQuery = useApp((s) => s.searchQuery);
  const setSearchQuery = useApp((s) => s.setSearchQuery);
  const pull = useApp((s) => s.pull);
  const push = useApp((s) => s.push);
  const sync = useApp((s) => s.sync);
  const refreshAll = useApp((s) => s.refreshAll);

  const [showSwitcher, setShowSwitcher] = useState(false);
  const repoName = repo?.path ? repo.path.split(/[\\/]/).filter(Boolean).pop() : '';

  return (
    <div className="toolbar">
      <div
        className="toolbar-repo"
        title={repo?.path ?? 'No repo open'}
        onClick={() => setShowSwitcher(true)}
      >
        <span className="name">{repoName ?? '—'}</span>
        <span className="branch">
          {repo?.detachedHead ? '(detached HEAD)' : (repo?.currentBranchName || '—')}
        </span>
      </div>

      <div className="toolbar-search">
        <input
          type="text"
          placeholder="grep commit subjects…"
          value={searchQuery}
          onChange={(e) => void setSearchQuery(e.target.value)}
        />
      </div>

      <div className="toolbar-spacer" />

      <button
        className="btn"
        onClick={() => void pull()}
        disabled={isLoading}
        title="Pull from origin"
      >
        pull
      </button>
      <button
        className="btn"
        onClick={() => void push()}
        disabled={isLoading}
        title="Push to origin"
      >
        push
      </button>
      <button
        className="btn primary"
        onClick={() => void sync()}
        disabled={isLoading}
        title="Pull then push"
      >
        sync
      </button>
      <button
        className="btn-text"
        onClick={() => void refreshAll()}
        title="Refresh"
        style={{ fontSize: 14 }}
      >
        ↻
      </button>
      {showSwitcher ? <RepoSwitcher onClose={() => setShowSwitcher(false)} /> : null}
    </div>
  );
}
