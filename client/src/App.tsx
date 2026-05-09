import { useEffect } from 'react';
import { useApp } from './store';
import { subscribeRepoChanged } from './api';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import { CommitGraph } from './components/CommitGraph';
import { BottomPanel } from './components/BottomPanel';
import { RepoPicker } from './components/RepoPicker';
import { ToastStack } from './components/ToastStack';

export default function App(): JSX.Element {
  const repoOpen = useApp((s) => s.repoOpen);
  const init = useApp((s) => s.init);
  const refreshAll = useApp((s) => s.refreshAll);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const unsub = subscribeRepoChanged(() => {
      void refreshAll();
    });
    return unsub;
  }, [refreshAll]);

  if (!repoOpen) {
    return (
      <>
        <RepoPicker />
        <ToastStack />
      </>
    );
  }

  return (
    <div className="app">
      <div className="topnav-area">
        <TopNav />
      </div>
      <div className="sidebar-area">
        <Sidebar />
      </div>
      <div className="main-area">
        <div className="graph-pane">
          <GraphPaneHead />
          <CommitGraph />
        </div>
      </div>
      <div className="detail-area">
        <BottomPanel />
      </div>
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
