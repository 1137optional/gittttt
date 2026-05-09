import { useState } from 'react';
import { useApp } from '../store';
import type { FileStatus } from '@shared/types';

const STATUS_LABEL: Record<FileStatus['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: '!',
};

export function WorkingTree(): JSX.Element {
  const status = useApp((s) => s.status);
  const stageFiles = useApp((s) => s.stageFiles);
  const unstageFiles = useApp((s) => s.unstageFiles);
  const stageAll = useApp((s) => s.stageAll);
  const unstageAll = useApp((s) => s.unstageAll);
  const discardFiles = useApp((s) => s.discardFiles);
  const commitFn = useApp((s) => s.commit);
  const stash = useApp((s) => s.stash);
  const stashes = useApp((s) => s.stashes);

  const [message, setMessage] = useState('');

  const unstaged = status?.unstaged ?? [];
  const staged = status?.staged ?? [];
  const conflicted = status?.conflicted ?? [];

  async function doCommit(): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (staged.length === 0) return;
    await commitFn(trimmed);
    setMessage('');
  }

  function onCommitKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void doCommit();
    }
  }

  async function discard(file: FileStatus): Promise<void> {
    const ok = window.confirm(`Discard changes to "${file.path}"? This cannot be undone.`);
    if (!ok) return;
    await discardFiles([file.path]);
  }

  return (
    <div className="working-tree">
      {/* ----- Unstaged ----- */}
      <div className="pane">
        <div className="pane-header">
          <span>Unstaged</span>
          <span className="count">({unstaged.length + conflicted.length})</span>
          <span className="actions">
            <button className="btn-text" onClick={() => void stageAll()}>
              Stage all +
            </button>
            <button
              className="btn-text warning"
              onClick={async () => {
                if (window.confirm('Discard ALL unstaged changes? This cannot be undone.')) {
                  await discardFiles(unstaged.map((f) => f.path));
                }
              }}
            >
              Discard all
            </button>
          </span>
        </div>
        <div className="pane-body">
          {conflicted.map((f) => (
            <FileRow
              key={`conflict-${f.path}`}
              file={f}
              actions={
                <button
                  className="icon-btn"
                  onClick={() => void stageFiles([f.path])}
                  title="Mark resolved"
                >
                  ✓
                </button>
              }
            />
          ))}
          {unstaged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              actions={
                <>
                  <button
                    className="icon-btn"
                    onClick={() => void stageFiles([f.path])}
                    title="Stage"
                  >
                    +
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => void discard(f)}
                    title="Discard"
                  >
                    ⌫
                  </button>
                </>
              }
            />
          ))}
          {unstaged.length === 0 && conflicted.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', padding: '8px 12px', fontSize: 12 }}>
              No unstaged changes.
            </div>
          ) : null}
        </div>
      </div>

      {/* ----- Staged ----- */}
      <div className="pane">
        <div className="pane-header">
          <span>Staged</span>
          <span className="count">({staged.length})</span>
          <span className="actions">
            <button className="btn-text" onClick={() => void unstageAll()}>
              Unstage all −
            </button>
          </span>
        </div>
        <div className="pane-body">
          {staged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              actions={
                <button
                  className="icon-btn"
                  onClick={() => void unstageFiles([f.path])}
                  title="Unstage"
                >
                  −
                </button>
              }
            />
          ))}
          {staged.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', padding: '8px 12px', fontSize: 12 }}>
              No staged changes yet.
            </div>
          ) : null}
        </div>
      </div>

      {/* ----- Commit composer ----- */}
      <div className="pane">
        <div className="pane-header">
          <span>Commit</span>
          <span className="actions">
            <button
              className="btn-text"
              onClick={() => void stash('save')}
              title="Stash all uncommitted changes"
            >
              Stash
            </button>
            <button
              className="btn-text"
              disabled={stashes.length === 0}
              onClick={() => void stash('apply', { index: 0 })}
              title="Apply latest stash"
            >
              Apply
            </button>
            <button
              className="btn-text"
              disabled={stashes.length === 0}
              onClick={() => void stash('pop', { index: 0 })}
              title="Pop latest stash"
            >
              Pop
            </button>
          </span>
        </div>
        <div className="commit-section">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onCommitKeyDown}
            placeholder="Commit message…"
          />
          <div className="button-row">
            <button
              className="btn primary"
              disabled={staged.length === 0 || message.trim() === ''}
              onClick={() => void doCommit()}
            >
              Commit
            </button>
          </div>
          <div className="commit-hint">⌘/Ctrl + Enter to commit</div>
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  actions,
}: {
  file: FileStatus;
  actions: React.ReactNode;
}): JSX.Element {
  return (
    <div className="file-row">
      <div className={`status-badge ${file.status}`}>{STATUS_LABEL[file.status]}</div>
      <div className="path" title={file.path}>
        {file.path}
      </div>
      <div className="actions" style={{ display: 'flex', gap: 4 }}>
        {actions}
      </div>
    </div>
  );
}
