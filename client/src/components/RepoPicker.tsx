import { useState } from 'react';
import { useApp } from '../store';

export function RepoPicker(): JSX.Element {
  const openRepo = useApp((s) => s.openRepo);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!path.trim()) return;
    setBusy(true);
    await openRepo(path.trim());
    setBusy(false);
  }

  return (
    <div className="repo-picker">
      <div className="glyph">
        <div className="brand-logo">G</div>
        <span>GitFlow</span>
      </div>
      <div className="card">
        <h2>Open a Git repository</h2>
        <p>
          Browsers can't pick local folders directly — paste the absolute path
          to the repository you want to work with. The local server will run
          all Git commands there.
        </p>
        <input
          type="text"
          placeholder="/Users/you/projects/your-repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !path.trim()}
          >
            {busy ? 'Opening…' : 'Open repository'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Tip: launch the server with <code>GITTTTT_REPO=/path/to/repo</code> to
          auto-open on startup.
        </p>
      </div>
    </div>
  );
}
