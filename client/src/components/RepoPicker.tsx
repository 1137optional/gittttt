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
      <div className="glyph">/// gittttt — git timeline</div>
      <div className="card">
        <h2>open repository</h2>
        <p>
          The browser can't pick local folders, so paste the absolute path of
          the repository you want to inspect. The local server will run every
          Git command there.
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
            {busy ? 'opening…' : 'open'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-code)' }}>
          tip: launch with <code>GITTTTT_REPO=/path</code> to auto-open.
        </p>
      </div>
    </div>
  );
}
