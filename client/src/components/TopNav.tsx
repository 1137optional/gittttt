import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { RepoSwitcher } from './RepoSwitcher';

export function TopNav(): JSX.Element {
  const repo = useApp((s) => s.repo);
  const searchQuery = useApp((s) => s.searchQuery);
  const setSearchQuery = useApp((s) => s.setSearchQuery);
  const refreshAll = useApp((s) => s.refreshAll);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);

  const [showSearch, setShowSearch] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Close search popover on outside click / escape.
  useEffect(() => {
    if (!showSearch) return;
    function onDown(e: MouseEvent): void {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setShowSearch(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setShowSearch(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showSearch]);

  const repoName = repo?.path ? repo.path.split(/[\\/]/).filter(Boolean).pop() : '—';

  return (
    <div className="topnav">
      <div className="brand" onClick={() => setShowSwitcher(true)} title={repo?.path ?? ''}>
        <div className="brand-logo">G</div>
        <div className="brand-text">
          <span className="title">GitFlow</span>
          <span className="subtitle">{repoName}</span>
        </div>
      </div>

      <div className="topnav-spacer" />

      <button
        className="topnav-action"
        onClick={() => toggleTheme()}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button
        className="topnav-action"
        onClick={() => void refreshAll()}
        title="Refresh"
      >
        ↻
      </button>
      <button
        className="topnav-action"
        onClick={() => setShowSearch((v) => !v)}
        title="Search commit messages"
      >
        🔍 <span style={{ fontSize: 12 }}>Search</span>
      </button>

      {showSearch ? (
        <div className="search-pop" ref={popRef}>
          <input
            type="text"
            placeholder="Search commit messages…"
            value={searchQuery}
            onChange={(e) => void setSearchQuery(e.target.value)}
            autoFocus
          />
        </div>
      ) : null}

      {showSwitcher ? <RepoSwitcher onClose={() => setShowSwitcher(false)} /> : null}
    </div>
  );
}
