import { useApp } from '../store';
import { Icon } from './Icon';

// Top navigation bar.
//   - "Switch repository" button on the right opens the full RepoPicker
//     overlay (GitHub list / local clones / paste a path), which is the only
//     way to swap repos at runtime.
//   - The brand area (title + repo name) is also clickable as a shortcut to
//     the same overlay; the chevron next to it advertises that affordance.
//   - Theme toggle (sun / moon) + Refresh action sit beside the switch button.
//   - The legacy commit-message search popover and the bare RepoSwitcher
//     modal were removed in earlier passes.
export function TopNav(): JSX.Element {
  const repo = useApp((s) => s.repo);
  const refreshAll = useApp((s) => s.refreshAll);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const setShowRepoPicker = useApp((s) => s.setShowRepoPicker);

  const repoName = repo?.path ? repo.path.split(/[\\/]/).filter(Boolean).pop() : '—';
  const openPicker = (): void => setShowRepoPicker(true);

  return (
    <div className="topnav">
      <button
        type="button"
        className="topnav-brand"
        onClick={openPicker}
        title={repo?.path ? `${repo.path} (点击切换仓库)` : '点击切换仓库'}
      >
        <span className="topnav-brand-text">
          <span className="title">GitFlow</span>
          <span className="subtitle">{repoName}</span>
        </span>
        <Icon name="chevron-down" size={14} className="topnav-brand-chev" />
      </button>

      <div className="topnav-spacer" />

      <button
        type="button"
        className="topnav-action"
        onClick={openPicker}
        title="切换或新建仓库"
      >
        <Icon name="swap" size={14} />
        <span>切换仓库</span>
      </button>
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
    </div>
  );
}
