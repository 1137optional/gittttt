import { useState } from 'react';
import { useApp } from '../store';
import { DiffViewer } from './DiffViewer';
import type { ChangedFile } from '@shared/types';

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: '!',
};

export function CommitDetail(): JSX.Element {
  const detail = useApp((s) => s.commitDetail);
  const selected = useApp((s) => s.selectedCommitHash);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  if (!selected) {
    return (
      <div className="commit-detail">
        <div className="empty">Click a commit node to see details.</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="commit-detail">
        <div className="empty">Loading commit detail…</div>
      </div>
    );
  }

  function toggle(path: string): void {
    setOpenFiles((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="commit-detail">
      <div className="meta">
        <span className="label">Hash</span>
        <span className="hash" title={detail.hash}>
          {detail.shortHash}
        </span>
        <span className="label">Author</span>
        <span>
          {detail.authorName} &lt;{detail.authorEmail}&gt;
        </span>
        <span className="label">Date</span>
        <span>{new Date(detail.timestamp).toLocaleString()}</span>
        {detail.parentHashes.length > 0 ? (
          <>
            <span className="label">Parents</span>
            <span style={{ fontFamily: 'var(--font-code)' }}>
              {detail.parentHashes.map((p) => p.slice(0, 7)).join(', ')}
            </span>
          </>
        ) : null}
      </div>

      <div className="message">{detail.message}</div>

      <h4>Files changed ({detail.changedFiles.length})</h4>
      {detail.changedFiles.map((f) => (
        <div key={f.path}>
          <div
            className="file-row"
            onClick={() => toggle(f.path)}
            title={f.path}
          >
            <div className={`status-badge ${f.status}`}>{STATUS_LABEL[f.status]}</div>
            <div className="path">{f.path}</div>
            <div className="stats">
              <span className="add">+{f.additions}</span>{' '}
              <span className="del">-{f.deletions}</span>
            </div>
            <div style={{ color: 'var(--fg-muted)' }}>
              {openFiles.has(f.path) ? '▾' : '▸'}
            </div>
          </div>
          {openFiles.has(f.path) ? <DiffViewer diff={f.diff} /> : null}
        </div>
      ))}
    </div>
  );
}
