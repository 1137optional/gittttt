import { useState } from 'react';
import { useApp } from '../store';

interface Props {
  onClose: () => void;
  // Optional starting point for the new branch — can be a commit hash, a
  // branch name, or any ref. If omitted, the new branch is forked off the
  // currently checked-out commit.
  from?: string;
  // Pretty label to show in the modal alongside `from` (e.g. short hash or
  // commit subject). Falls back to `from` itself when not provided.
  fromLabel?: string;
}

export function NewBranchModal({ onClose, from, fromLabel }: Props): JSX.Element {
  const createBranch = useApp((s) => s.createBranch);
  const currentBranch = useApp((s) => s.repo?.currentBranchName ?? '');
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    await createBranch(name.trim(), { checkout, from });
    setBusy(false);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create branch</h3>
        <div className="form-row">
          <label>Branch name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="feature/my-new-thing"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="form-row">
          <label>From</label>
          <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)' }}>
            {from ? (
              <>
                Commit:{' '}
                <strong style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-code)' }}>
                  {fromLabel ?? from}
                </strong>
              </>
            ) : (
              <>
                Current branch:{' '}
                <strong style={{ color: 'var(--fg-primary)' }}>{currentBranch || 'HEAD'}</strong>
              </>
            )}
          </div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            color: 'var(--fg-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={checkout}
            onChange={(e) => setCheckout(e.target.checked)}
            style={{ width: 'auto', padding: 0, margin: 0 }}
          />
          Check out the new branch immediately
        </label>
        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
