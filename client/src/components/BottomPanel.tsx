import { useApp } from '../store';
import { CommitDetail } from './CommitDetail';
import { WorkingChanges } from './WorkingChanges';

// Tabbed bottom pane below the commit graph. Shows the selected commit on
// one tab and the working-tree changes / commit composer on the other.
export function BottomPanel(): JSX.Element {
  const tab = useApp((s) => s.bottomTab);
  const setTab = useApp((s) => s.setBottomTab);
  const status = useApp((s) => s.status);
  const selected = useApp((s) => s.selectedCommitHash);

  const changesCount =
    (status?.unstaged.length ?? 0) +
    (status?.staged.length ?? 0) +
    (status?.conflicted.length ?? 0);

  return (
    <div className="bottom-pane">
      <div className="bottom-tabs">
        <button
          className={`bottom-tab ${tab === 'detail' ? 'active' : ''}`}
          onClick={() => setTab('detail')}
        >
          <span>Commit Detail</span>
          {selected ? <span className="pill">{selected.slice(0, 7)}</span> : null}
        </button>
        <button
          className={`bottom-tab ${tab === 'changes' ? 'active' : ''}`}
          onClick={() => setTab('changes')}
        >
          <span>Working Changes</span>
          {changesCount > 0 ? <span className="pill">{changesCount}</span> : null}
        </button>
        <span className="spacer" />
      </div>
      <div className="bottom-content">
        {tab === 'detail' ? <CommitDetail /> : <WorkingChanges />}
      </div>
    </div>
  );
}
