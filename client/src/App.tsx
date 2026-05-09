import { useEffect } from 'react';
import { useApp } from './store';
import { subscribeRepoChanged } from './api';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import { CommitGraph } from './components/CommitGraph';
import { WorkingChanges } from './components/WorkingChanges';
import { RepoPicker } from './components/RepoPicker';
import { ToastStack } from './components/ToastStack';
import { StatusBar } from './components/StatusBar';
import { DebugLayout } from './components/debug/DebugLayout';
import { useSplitter } from './components/Splitter';

export default function App(): JSX.Element {
  const repoOpen = useApp((s) => s.repoOpen);
  const init = useApp((s) => s.init);
  const refreshAll = useApp((s) => s.refreshAll);
  const showRepoPicker = useApp((s) => s.showRepoPicker);
  const setShowRepoPicker = useApp((s) => s.setShowRepoPicker);
  const currentMode = useApp((s) => s.currentMode);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const unsub = subscribeRepoChanged(() => {
      void refreshAll();
    });
    return unsub;
  }, [refreshAll]);

  // Debug mode is a self-contained workspace (its own TopNav already, so we
  // don't wrap it in the graph-mode layout chrome). Independent from whether
  // a repo is currently attached — debug works against any URL even with no
  // repo open.
  if (currentMode === 'debug') {
    return (
      <>
        <DebugLayout />
        <StatusBar />
        {showRepoPicker ? <RepoPicker onClose={() => setShowRepoPicker(false)} /> : null}
        <ToastStack />
      </>
    );
  }

  // Cold-start in graph mode: no repo attached → fill the screen with the
  // picker (no close button — there's nothing to close back to). Status
  // bar still useful here for the mode/refresh affordances.
  if (!repoOpen) {
    return (
      <>
        <RepoPicker />
        <StatusBar />
        <ToastStack />
      </>
    );
  }

  return <GraphLayout showRepoPicker={showRepoPicker} setShowRepoPicker={setShowRepoPicker} />;
}

// =============================================================================
// GraphLayout — extracted so we can use the useSplitter hook (which needs
// a stable component instance to host its useState calls). The previous
// inline JSX in App() worked fine, but adding two splitters made it cleaner
// to give the layout its own component scope.
// =============================================================================
interface GraphLayoutProps {
  showRepoPicker: boolean;
  setShowRepoPicker(open: boolean): void;
}

function GraphLayout({ showRepoPicker, setShowRepoPicker }: GraphLayoutProps): JSX.Element {
  // Two splitters: sidebar (left) and pages (right). Both persist their
  // sizes so the user's preferred layout survives a refresh.
  const { size: sidebarW, Splitter: SidebarSplit } = useSplitter({
    storageKey: 'gittttt:graph-side-w',
    defaultSize: 240,
    minSize: 180,
    maxSize: 480,
    direction: 'vertical',
    target: 'a', // sidebar is the LEFT pane → drag right increases its width
  });
  const { size: pagesW, Splitter: PagesSplit } = useSplitter({
    storageKey: 'gittttt:graph-pages-w',
    defaultSize: 320,
    minSize: 240,
    maxSize: 640,
    direction: 'vertical',
    target: 'b', // pages is the RIGHT pane → drag left increases its width
  });

  // Inline grid template fed by both splitters. Falls back to the CSS
  // default during the brief moment before React hydrates.
  const appStyle: React.CSSProperties = {
    gridTemplateColumns: `${sidebarW}px 6px 1fr 6px ${pagesW}px`,
  };

  return (
    <div className="app" style={appStyle}>
      <div className="topnav-area">
        <TopNav />
      </div>
      <div className="sidebar-area">
        <Sidebar />
      </div>
      {/* Splitters are direct grid children so they fill their assigned
          area cleanly. The className places them via grid-area:splv{1,2}. */}
      <SidebarSplit className="app-splitter-left" />
      <div className="main-area">
        <div className="graph-pane">
          <GraphPaneHead />
          <CommitGraph />
        </div>
      </div>
      <PagesSplit className="app-splitter-right" />
      <div className="pages-area">
        {/* Right sidebar = a single page: Working Changes (stage / unstage
            / commit composer). The old Overview and Commit Detail tabs
            were dropped — the graph row already carries the per-commit
            info, and stat cards on a tiny repo were noise. */}
        <WorkingChanges />
      </div>
      {/* Switch-repo overlay — invoked from the TopNav. Sits on top of the
          main view, dismissable via the X button or Escape. */}
      {showRepoPicker ? <RepoPicker onClose={() => setShowRepoPicker(false)} /> : null}
      <StatusBar />
      <ToastStack />
    </div>
  );
}

function GraphPaneHead(): JSX.Element {
  const branch = useApp((s) => s.repo?.currentBranchName ?? '');
  const total = useApp((s) => s.totalCommitCount);
  const isLoading = useApp((s) => s.isLoading);
  const pull = useApp((s) => s.pull);
  const push = useApp((s) => s.push);
  const sync = useApp((s) => s.sync);
  return (
    <div className="graph-pane-head">
      <span className="title">Commit history</span>
      <span className="subtitle">
        {branch ? `on ${branch}` : 'detached HEAD'} · {total} total
      </span>
      <span className="spacer" />
      <span className="pull-push">
        <button className="topnav-action" onClick={() => void pull()} disabled={isLoading}>
          Pull
        </button>
        <button className="topnav-action" onClick={() => void push()} disabled={isLoading}>
          Push
        </button>
        <button className="topnav-action primary" onClick={() => void sync()} disabled={isLoading}>
          Sync
        </button>
      </span>
    </div>
  );
}
