import { useState } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';
import { RepoSwitcher } from './RepoSwitcher';

// Top navigation bar.
//   - Title doubles as the click target for the repo switcher (the old
//     standalone "G" brand mark was removed; the title carries the role).
//   - Theme toggle (☀ / ☾ in SVG) + Refresh action on the right.
//   - The legacy commit-message search popover was removed in this pass —
//     it didn't survive the redesign, and `searchQuery` / `highlightedHashes`
//     were dropped from the store at the same time. If we revive search, we'll
//     own it as a dedicated overlay rather than crowding the topnav.
export function TopNav(): JSX.Element {
  const repo = useApp((s) => s.repo);
  const refreshAll = useApp((s) => s.refreshAll);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);

  const [showSwitcher, setShowSwitcher] = useState(false);

  const repoName = repo?.path ? repo.path.split(/[\\/]/).filter(Boolean).pop() : '—';

  return (
    <div className="topnav">
      <button
        type="button"
        className="topnav-brand"
        onClick={() => setShowSwitcher(true)}
        title={repo?.path ?? ''}
      >
        <span className="title">GitFlow</span>
        <span className="subtitle">{repoName}</span>
      </button>

      <div className="topnav-spacer" />

      <button
        type="button"
        className="topnav-action icon-only"
        onClick={() => toggleTheme()}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
      <button
        type="button"
        className="topnav-action icon-only"
        onClick={() => void refreshAll()}
        title="Refresh"
        aria-label="Refresh"
      >
        <Icon name="refresh" size={16} />
      </button>

      {showSwitcher ? <RepoSwitcher onClose={() => setShowSwitcher(false)} /> : null}
    </div>
  );
}
