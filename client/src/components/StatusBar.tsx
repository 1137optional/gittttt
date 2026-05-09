import { useApp } from '../store';
import { Icon } from './Icon';

// =============================================================================
// StatusBar
//
// VS Code / Cursor-style strip pinned to the bottom of the window. Reflects
// repo state at a glance so the user doesn't have to glance up at multiple
// panels.
//
// Layout (left → right, then far-right cluster):
//   ⟳   ●branch   ↑N ↓M       │       ⊘ N · ⚠ M · + N · 调试模式
//   ↑   ↑         ↑                  ↑       ↑       ↑
//   |   |         ahead/behind       conflicts modified staged
//   |   click → branches page
//   refresh
//
// Click semantics:
//   - refresh icon → re-pull repo state (cheap, idempotent)
//   - branch       → opens the Branches page in the left sidebar
//   - mode label   → toggles graph ↔ debug mode
//
// Design notes:
//   - Static 24px tall — anything smaller becomes hard to click on hi-DPI
//     trackpads, anything bigger eats real estate that should go to the
//     graph.
//   - Counts hide when zero (less visual clutter), with one exception:
//     conflicts ALWAYS shows when in a conflicted state, even at 0, so the
//     user notices the merge marker.
//   - Branch name truncates with ellipsis past ~28 chars.
// =============================================================================

const MAX_BRANCH_LEN = 28;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function StatusBar(): JSX.Element | null {
  const repoOpen = useApp((s) => s.repoOpen);
  const repo = useApp((s) => s.repo);
  const branches = useApp((s) => s.branches);
  const status = useApp((s) => s.status);
  const isLoading = useApp((s) => s.isLoading);
  const refreshAll = useApp((s) => s.refreshAll);
  const currentMode = useApp((s) => s.currentMode);
  const setCurrentMode = useApp((s) => s.setCurrentMode);
  const setLeftPage = useApp((s) => s.setLeftPage);

  // No repo attached → render the bar but only with the mode toggle so
  // the user can still see / switch modes from the bottom strip.
  const branch = repo?.currentBranchName ?? '';
  // ahead / behind live on the matching local Branch entry. We grab the
  // first non-remote entry whose name matches the current HEAD branch.
  const currentBranchEntry = branch
    ? branches.find((b) => !b.isRemote && b.name === branch)
    : undefined;
  const ahead = currentBranchEntry?.ahead ?? 0;
  const behind = currentBranchEntry?.behind ?? 0;

  // Status counts — staged includes conflicts in some git states; we
  // explicitly subtract conflicted to keep the breakdown unambiguous.
  const conflicted = status?.conflicted.length ?? 0;
  const modified = status?.unstaged.length ?? 0;
  const staged = status?.staged.length ?? 0;
  const inMerge = status?.inMerge ?? false;
  const inRebase = status?.inRebase ?? false;

  function focusBranches(): void {
    setLeftPage('branches');
  }

  function toggleMode(): void {
    setCurrentMode(currentMode === 'debug' ? 'graph' : 'debug');
  }

  return (
    <div className="status-bar" role="status" aria-label="状态栏">
      <div className="status-bar-section status-bar-left">
        <button
          type="button"
          className={`status-bar-btn icon-only${isLoading ? ' spinning' : ''}`}
          onClick={() => void refreshAll()}
          disabled={!repoOpen || isLoading}
          title={isLoading ? '正在刷新…' : '刷新仓库状态'}
          aria-label="刷新"
        >
          <Icon name="refresh" size={12} />
        </button>

        {repoOpen ? (
          <button
            type="button"
            className="status-bar-btn"
            onClick={focusBranches}
            title={`当前分支: ${branch || 'detached HEAD'}（点击查看分支列表）`}
          >
            <Icon name="branch" size={12} />
            <span className="status-bar-branch">
              {branch ? truncate(branch, MAX_BRANCH_LEN) : 'detached'}
            </span>
          </button>
        ) : null}

        {repoOpen && (ahead > 0 || behind > 0) ? (
          <span className="status-bar-syncpair" title={`本地领先 ${ahead}，落后 ${behind}`}>
            {behind > 0 ? (
              <span className="status-bar-syncitem">
                <span className="status-bar-arrow rot180">
                  <Icon name="arrow-up" size={11} />
                </span>
                {behind}
              </span>
            ) : null}
            {ahead > 0 ? (
              <span className="status-bar-syncitem">
                <Icon name="arrow-up" size={11} />
                {ahead}
              </span>
            ) : null}
          </span>
        ) : null}

        {repoOpen && (inMerge || inRebase) ? (
          <span
            className="status-bar-state-tag"
            title={inMerge ? '正在 merge — 解决冲突后 commit' : '正在 rebase — 继续 / 中止'}
          >
            {inMerge ? 'MERGING' : 'REBASING'}
          </span>
        ) : null}
      </div>

      <div className="status-bar-section status-bar-right">
        {repoOpen && (conflicted > 0 || inMerge) ? (
          <span
            className="status-bar-count count-error"
            title={`${conflicted} 个文件冲突`}
          >
            <Icon name="close" size={11} /> {conflicted}
          </span>
        ) : null}

        {repoOpen && modified > 0 ? (
          <span
            className="status-bar-count count-warn"
            title={`${modified} 个未暂存改动`}
          >
            <span className="status-bar-mark">M</span> {modified}
          </span>
        ) : null}

        {repoOpen && staged > 0 ? (
          <span
            className="status-bar-count count-ok"
            title={`${staged} 个已暂存改动`}
          >
            <span className="status-bar-mark">+</span> {staged}
          </span>
        ) : null}

        <button
          type="button"
          className="status-bar-btn status-bar-mode"
          onClick={toggleMode}
          title="切换 Graph / Debug 模式"
        >
          <Icon name={currentMode === 'debug' ? 'bug' : 'branch'} size={11} />
          <span>{currentMode === 'debug' ? '调试模式' : '图模式'}</span>
        </button>
      </div>
    </div>
  );
}
