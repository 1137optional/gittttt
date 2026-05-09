import { useEffect } from 'react';
import { useApp } from './store';
import { subscribeRepoChanged } from './api';
import { Toolbar } from './components/Toolbar';
import { BranchTree } from './components/BranchTree';
import { CommitGraph } from './components/CommitGraph';
import { CommitDetail } from './components/CommitDetail';
import { WorkingTree } from './components/WorkingTree';
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
      <Toolbar />
      <div className="main">
        <div className="col">
          <BranchTree />
        </div>
        <div className="col" style={{ padding: 0 }}>
          <CommitGraph />
        </div>
        <div className="col">
          <CommitDetail />
        </div>
      </div>
      <WorkingTree />
      <ToastStack />
    </div>
  );
}
