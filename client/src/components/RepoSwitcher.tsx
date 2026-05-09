import { useState } from 'react';
import { useApp } from '../store';

export function RepoSwitcher({ onClose }: { onClose: () => void }): JSX.Element {
  const current = useApp((s) => s.repo?.path) ?? '';
  const openRepo = useApp((s) => s.openRepo);
  const [path, setPath] = useState(current);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!path.trim() || path === current) {
      onClose();
      return;
    }
    setBusy(true);
    await openRepo(path.trim());
    setBusy(false);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Switch repository</h3>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onClose();
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
