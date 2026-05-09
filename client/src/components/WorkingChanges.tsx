import { useState } from 'react';
import { useApp } from '../store';
import { Icon } from './Icon';
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

// Working-tree pane — the only page rendered in the right sidebar.
// Stacked vertically: Unstaged list, Staged list, Commit composer (with
// Stash/Pop). When Docs land in the right sidebar later, a small page nav
// will sit at the top to switch between them.
export function WorkingChanges(): JSX.Element {
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
    if (!trimmed || staged.length === 0) return;
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
    <div className="changes-pane">
      <div className="changes-col">
        <div className="changes-head">
          <span>Unstaged</span>
          <span className="count">({unstaged.length + conflicted.length})</span>
          <span className="actions">
            <button className="text-btn" onClick={() => void stageAll()}>
              Stage all
            </button>
            <button
              className="text-btn warning"
              onClick={async () => {
                if (window.confirm('Discard ALL unstaged changes?')) {
                  await discardFiles(unstaged.map((f) => f.path));
                }
              }}
            >
              Discard
            </button>
          </span>
        </div>
        <div className="changes-body">
          {conflicted.map((f) => (
            <FileRow
              key={`conflict-${f.path}`}
              file={f}
              actions={
                <button
                  className="row-icon-btn"
                  onClick={() => void stageFiles([f.path])}
                  title="Mark resolved"
                  aria-label="Mark resolved"
                >
                  <Icon name="check" size={14} />
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
                    className="row-icon-btn"
                    onClick={() => void stageFiles([f.path])}
                    title="Stage"
                    aria-label="Stage"
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  <button
                    className="row-icon-btn danger"
                    onClick={() => void discard(f)}
                    title="Discard"
                    aria-label="Discard"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </>
              }
            />
          ))}
          {unstaged.length === 0 && conflicted.length === 0 ? (
            <div className="empty-line">No unstaged changes</div>
          ) : null}
        </div>
      </div>

      <div className="changes-col">
        <div className="changes-head">
          <span>Staged</span>
          <span className="count">({staged.length})</span>
          <span className="actions">
            <button className="text-btn" onClick={() => void unstageAll()}>
              Unstage all
            </button>
          </span>
        </div>
        <div className="changes-body">
          {staged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              actions={
                <button
                  className="row-icon-btn"
                  onClick={() => void unstageFiles([f.path])}
                  title="Unstage"
                  aria-label="Unstage"
                >
                  <Icon name="minus" size={14} />
                </button>
              }
            />
          ))}
          {staged.length === 0 ? (
            <div className="empty-line">Nothing staged yet</div>
          ) : null}
        </div>
      </div>

      <div className="changes-col">
        <div className="changes-head">
          <span>Commit</span>
          <span className="actions">
            <button
              className="text-btn"
              onClick={() => void stash('save')}
              title="Stash all uncommitted changes"
            >
              Stash
            </button>
            <button
              className="text-btn"
              disabled={stashes.length === 0}
              onClick={() => void stash('pop', { index: 0 })}
              title="Pop latest stash"
            >
              Pop
            </button>
          </span>
        </div>
        <div className="commit-composer" style={{ flex: 1, borderTop: 'none', background: 'transparent' }}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onCommitKeyDown}
            placeholder="Describe your changes…"
            rows={3}
          />
          <div className="row">
            <span className="hint">⌘/Ctrl + Enter</span>
            <div className="button-group">
              <button
                className="btn primary"
                disabled={staged.length === 0 || message.trim() === ''}
                onClick={() => void doCommit()}
              >
                Commit
              </button>
            </div>
          </div>
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
      <div className="row-actions">{actions}</div>
    </div>
  );
}
