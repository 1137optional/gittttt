import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { hashIndex, theme } from '../theme';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { LeftDocs } from './LeftDocs';
import { LeftMemory } from './LeftMemory';
import type { Branch } from '@shared/types';
// Note: contributor / commit / branch / tag stats used to live in this
// sidebar but were dropped — they didn't pull their visual weight and
// crowded the actionable branch list. Headline counts already surface
// elsewhere (graph header for total commits, branch list for branch
// count). Re-add only with a clearer use case.

interface CtxState {
  x: number;
  y: number;
  items: MenuItem[];
}

// Color a branch by hashing its name into the brand palette. main / master /
// develop are forced to the primary blue lane so they read as "the trunk".
function branchColor(name: string): string {
  if (/^(main|master|develop|dev|trunk)$/i.test(name)) {
    return theme.branchPalette[0];
  }
  return theme.branchPalette[hashIndex(name, theme.branchPalette.length)];
}

export function Sidebar(): JSX.Element {
  const branches = useApp((s) => s.branches);
  const stashes = useApp((s) => s.stashes);
  const repo = useApp((s) => s.repo);
  const status = useApp((s) => s.status);
  const checkout = useApp((s) => s.checkout);
  const merge = useApp((s) => s.merge);
  const rebase = useApp((s) => s.rebase);
  const deleteBranch = useApp((s) => s.deleteBranch);
  const stash = useApp((s) => s.stash);
  const pushToast = useApp((s) => s.pushToast);
  const leftPage = useApp((s) => s.leftPage);
  const setLeftPage = useApp((s) => s.setLeftPage);

  const [ctx, setCtx] = useState<CtxState | null>(null);

  const local = useMemo(
    () => branches.filter((b) => !b.isRemote).sort((a, b) => a.name.localeCompare(b.name)),
    [branches],
  );
  const remote = useMemo(
    () => branches.filter((b) => b.isRemote).sort((a, b) => a.name.localeCompare(b.name)),
    [branches],
  );

  const currentName = repo?.currentBranchName ?? '';

  function preflight(): boolean {
    if (!status) return true;
    if (status.inMerge || status.inRebase) {
      pushToast('warn', '请先完成或中止正在进行的合并 / 变基');
      return false;
    }
    const dirty = status.unstaged.length + status.staged.length;
    if (dirty > 0) {
      return window.confirm(`有 ${dirty} 个未提交改动，确定切换分支？`);
    }
    return true;
  }

  async function onCheckout(b: Branch): Promise<void> {
    const local = b.isRemote ? b.name.split('/').slice(1).join('/') || b.name : b.name;
    if (local === currentName) return;
    if (!preflight()) return;
    await checkout(local);
  }

  function showBranchMenu(e: React.MouseEvent, b: Branch): void {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = b.isRemote
      ? [
          { label: '检出（跟踪）', onClick: () => void onCheckout(b) },
          { separator: true },
          { label: `合并到 ${currentName}`, onClick: () => void merge(b.name) },
          { label: `变基 ${currentName} 到此`, onClick: () => void rebase(b.name) },
        ]
      : [
          { label: b.name === currentName ? '当前分支' : '检出', onClick: () => void onCheckout(b) },
          { separator: true },
          { label: `合并到 ${currentName}`, onClick: () => void merge(b.name) },
          { label: `变基 ${currentName} 到此`, onClick: () => void rebase(b.name) },
          { separator: true },
          {
            label: '删除分支',
            danger: true,
            onClick: () => {
              if (window.confirm(`删除分支 "${b.name}"？`)) {
                void deleteBranch(b.name);
              }
            },
          },
        ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  }

  return (
    <div className="sidebar">
      <div className="left-nav-tabs">
        <button
          type="button"
          className={`left-nav-tab ${leftPage === 'branches' ? 'active' : ''}`}
          onClick={() => setLeftPage('branches')}
        >
          分支
        </button>
        <button
          type="button"
          className={`left-nav-tab ${leftPage === 'docs' ? 'active' : ''}`}
          onClick={() => setLeftPage('docs')}
        >
          文档
        </button>
        <button
          type="button"
          className={`left-nav-tab ${leftPage === 'memory' ? 'active' : ''}`}
          onClick={() => setLeftPage('memory')}
        >
          记忆
        </button>
      </div>

      <div className="sidebar-body">
        {leftPage === 'docs' ? (
          <LeftDocs />
        ) : leftPage === 'memory' ? (
          <LeftMemory />
        ) : (
          <>
      {/* ---- Branches ---- */}
      <div className="sidebar-section">
        <div className="section-label">本地分支</div>
        <div className="branch-list">
          {local.map((b) => (
            <div
              key={b.fullName}
              className={`branch-item ${b.name === currentName ? 'active' : ''}`}
              onClick={() => void onCheckout(b)}
              onContextMenu={(e) => showBranchMenu(e, b)}
              title={b.fullName}
            >
              <span className="branch-icon" style={{ color: branchColor(b.name) }}>
                <Icon name="branch" size={15} />
              </span>
              <div className="branch-meta">
                <span className="branch-name">{b.name}</span>
                {b.name === currentName && (b.ahead > 0 || b.behind > 0) ? (
                  <span className="branch-status">
                    {b.ahead > 0 ? `↑${b.ahead}` : ''}
                    {b.ahead > 0 && b.behind > 0 ? ' ' : ''}
                    {b.behind > 0 ? `↓${b.behind}` : ''}
                  </span>
                ) : null}
              </div>
              <span
                className="more"
                onClick={(e) => {
                  e.stopPropagation();
                  showBranchMenu(e, b);
                }}
                title="更多操作"
              >
                <Icon name="more" size={14} />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ---- Remotes (compact) ---- */}
      {remote.length > 0 ? (
        <div className="sidebar-section">
          <div className="section-label">远程</div>
          <div className="branch-list">
            {remote.slice(0, 8).map((b) => (
              <div
                key={b.fullName}
                className="branch-item"
                onContextMenu={(e) => showBranchMenu(e, b)}
                title={b.fullName}
                style={{ paddingLeft: 10 }}
              >
                <span className="branch-icon" style={{ color: branchColor(b.name), opacity: 0.7 }}>
                  <Icon name="branch" size={15} />
                </span>
                <div className="branch-meta">
                  <span className="branch-name" style={{ color: 'var(--fg-secondary)' }}>
                    {b.name}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ---- Stash (only when present) ---- */}
      {stashes.length > 0 ? (
        <div className="sidebar-section">
          <div className="section-label">贮藏</div>
          <div className="branch-list">
            {stashes.map((s) => (
              <div
                key={s.index}
                className="branch-item"
                title={s.message}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: '应用', onClick: () => void stash('apply', { index: s.index }) },
                      { label: '弹出（应用并删除）', onClick: () => void stash('pop', { index: s.index }) },
                      { separator: true },
                      {
                        label: '删除',
                        danger: true,
                        onClick: () => {
                          if (window.confirm(`删除 stash@{${s.index}}？`)) {
                            void stash('drop', { index: s.index });
                          }
                        },
                      },
                    ],
                  });
                }}
              >
                <span className="branch-icon" style={{ color: 'var(--fg-muted)' }}>
                  <Icon name="cloud" size={15} />
                </span>
                <div className="branch-meta">
                  <span className="branch-name">stash@{`{${s.index}}`}</span>
                  <span className="branch-status">{s.branchName}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
          </>
        )}
      </div>

      {ctx ? <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} /> : null}
    </div>
  );
}
