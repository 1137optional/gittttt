import { useApp } from '../store';
import { Icon } from './Icon';

// Top navigation bar.
//
//   ┌───────────┬────────────────────────────────────────┬──────────────┐
//   │  Brand    │  [tab1] [tab2*] [tab3] … [+]           │ ☼  ↻         │
//   └───────────┴────────────────────────────────────────┴──────────────┘
//
//   - Brand is now a static label (no longer a click target — the previous
//     duplicate "click brand to switch repos" entry was removed).
//   - The middle is a browser-style tab strip: one tab per opened repo,
//     persisted to localStorage. Click a tab to switch; × to close. The
//     trailing `+` button is the single entry point that opens RepoPicker.
//   - Right side keeps theme + refresh as before.
export function TopNav(): JSX.Element {
  const repo = useApp((s) => s.repo);
  const tabs = useApp((s) => s.openTabs);
  const openRepo = useApp((s) => s.openRepo);
  const closeTab = useApp((s) => s.closeTab);
  const refreshAll = useApp((s) => s.refreshAll);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const setShowRepoPicker = useApp((s) => s.setShowRepoPicker);

  const activePath = repo?.path ?? '';
  const openPicker = (): void => setShowRepoPicker(true);

  return (
    <div className="topnav">
      <div className="topnav-brand">
        <span className="title">GitFlow</span>
      </div>

      <div className="topnav-tabs" role="tablist" aria-label="Open repositories">
        {tabs.map((tab) => {
          const active = tab.path === activePath;
          const showClose = tabs.length > 1; // never let the user nuke the last tab
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={active}
              className={`topnav-tab ${active ? 'active' : ''}`}
              title={tab.path}
              onClick={() => {
                if (active) return;
                void openRepo(tab.path);
              }}
            >
              <span className="topnav-tab-name">{tab.name}</span>
              {showClose ? (
                <button
                  type="button"
                  className="topnav-tab-close"
                  title="关闭这个标签"
                  aria-label="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.path);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="topnav-tab-add"
          onClick={openPicker}
          title="打开或新建仓库"
          aria-label="打开或新建仓库"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <button
        type="button"
        className="topnav-action icon-only"
        onClick={() => toggleTheme()}
        title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
        aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
      <button
        type="button"
        className="topnav-action icon-only"
        onClick={() => void refreshAll()}
        title="刷新"
        aria-label="刷新"
      >
        <Icon name="refresh" size={16} />
      </button>
    </div>
  );
}
