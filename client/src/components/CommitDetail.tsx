import { useState } from 'react';
import { useApp } from '../store';
import { DiffViewer } from './DiffViewer';
import { authorInitials, avatarColor, hashIndex, theme } from '../theme';
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

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(mo / 12);
  return `${y}y ago`;
}

function branchColorByName(name: string): string {
  if (/^(main|master|develop|dev|trunk)$/i.test(name)) return theme.branchPalette[0];
  return theme.branchPalette[hashIndex(name, theme.branchPalette.length)];
}

export function CommitDetail(): JSX.Element {
  const detail = useApp((s) => s.commitDetail);
  const selected = useApp((s) => s.selectedCommitHash);
  const branches = useApp((s) => s.branches);
  const pushToast = useApp((s) => s.pushToast);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  if (!selected) {
    return <div className="empty-state">Click a commit in the graph to see its details here.</div>;
  }
  if (!detail) {
    return <div className="empty-state">Loading commit…</div>;
  }

  // Find branches that contain (i.e. tip is) this commit, prefer the local one.
  const referencingBranches = branches.filter((b) => b.lastCommitHash === detail.hash);
  const primaryBranch =
    referencingBranches.find((b) => !b.isRemote)?.name ??
    referencingBranches[0]?.name ??
    '—';

  const additions = detail.changedFiles.reduce((a, f) => a + f.additions, 0);
  const deletions = detail.changedFiles.reduce((a, f) => a + f.deletions, 0);

  const subject = detail.message.split('\n')[0];
  const body = detail.message.slice(subject.length).trim();

  function copyHash(): void {
    navigator.clipboard
      .writeText(detail!.hash)
      .then(() => pushToast('success', 'Hash copied to clipboard'))
      .catch(() => pushToast('error', 'Could not copy hash'));
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
    <div>
      <div className="detail-card">
        <div
          className="avatar"
          style={{ background: avatarColor(detail.authorEmail) }}
          title={`${detail.authorName} <${detail.authorEmail}>`}
        >
          {authorInitials(detail.authorName, detail.authorEmail)}
        </div>
        <div className="detail-text">
          <p className="subject">{subject}</p>
          <div className="meta">
            {detail.authorName} · {formatRelative(detail.timestamp)}
            <span style={{ color: 'var(--fg-faint)' }}>  ·  </span>
            {new Date(detail.timestamp).toLocaleString()}
          </div>
          {body ? <div className="body">{body}</div> : null}
        </div>
        <div className="detail-actions">
          <button className="icon-btn-light" onClick={copyHash} title="Copy full hash">
            ⧉
          </button>
        </div>
      </div>

      <div className="detail-grid">
        <div className="cell">
          <span className="label">Hash</span>
          <span className="value">{detail.shortHash}</span>
        </div>
        <div className="cell">
          <span className="label">Branch</span>
          <span className="value" style={{ color: branchColorByName(primaryBranch) }}>
            {primaryBranch}
          </span>
        </div>
        <div className="cell">
          <span className="label">Files changed</span>
          <span className="value add">+{additions}</span>
        </div>
        <div className="cell">
          <span className="label">Deletions</span>
          <span className="value del">-{deletions}</span>
        </div>
      </div>

      <div className="changed-files">
        <h4>
          Changed files <span className="count">{detail.changedFiles.length}</span>
        </h4>
        {detail.changedFiles.length === 0 ? (
          <div className="empty-line">No files changed.</div>
        ) : (
          detail.changedFiles.map((f) => (
            <div key={f.path}>
              <div className="file-row" onClick={() => toggle(f.path)} title={f.path}>
                <div className={`status-badge ${f.status}`}>{STATUS_LABEL[f.status]}</div>
                <div className="path">{f.path}</div>
                <div className="stats">
                  <span className="add">+{f.additions}</span>{' '}
                  <span className="del">-{f.deletions}</span>
                </div>
                <div className="chev">{openFiles.has(f.path) ? '▾' : '▸'}</div>
              </div>
              {openFiles.has(f.path) ? <DiffViewer diff={f.diff} /> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
