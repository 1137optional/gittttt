import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { Branch, Stash } from '@shared/types';

type Expanded = { local: boolean; remote: boolean; tags: boolean; stash: boolean };

interface CtxState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function BranchTree(): JSX.Element {
  const branches = useApp((s) => s.branches);
  const tags = useApp((s) => s.tags);
  const stashes = useApp((s) => s.stashes);
  const repo = useApp((s) => s.repo);
  const status = useApp((s) => s.status);
  const checkout = useApp((s) => s.checkout);
  const merge = useApp((s) => s.merge);
  const rebase = useApp((s) => s.rebase);
  const deleteBranch = useApp((s) => s.deleteBranch);
  const stash = useApp((s) => s.stash);
  const pushToast = useApp((s) => s.pushToast);

  const [expanded, setExpanded] = useState<Expanded>({
    local: true,
    remote: true,
    tags: false,
    stash: true,
  });

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

  function toggle(key: keyof Expanded): void {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  // Return true if it's safe to silently switch branches.
  // Otherwise prompt the user with a window.confirm summarizing the impact.
  function preflightCheckout(): boolean {
    if (!status) return true;
    if (status.inMerge || status.inRebase) {
      pushToast('warn', 'Finish or abort the in-progress merge/rebase first.');
      return false;
    }
    const dirty = status.unstaged.length + status.staged.length;
    if (dirty > 0) {
      const ok = window.confirm(
        `You have ${dirty} uncommitted change${dirty === 1 ? '' : 's'}. Switching branches may overwrite them. Continue?`,
      );
      if (!ok) return false;
    }
    return true;
  }

  async function handleCheckout(name: string): Promise<void> {
    if (name === currentName) return;
    if (!preflightCheckout()) return;
    await checkout(name);
  }

  async function handleMerge(source: string): Promise<void> {
    if (source === currentName) return;
    const ok = window.confirm(`Merge "${source}" into "${currentName}"?`);
    if (!ok) return;
    await merge(source);
  }

  async function handleRebase(target: string): Promise<void> {
    if (target === currentName) return;
    const ok = window.confirm(`Rebase "${currentName}" onto "${target}"?`);
    if (!ok) return;
    await rebase(target);
  }

  async function handleDelete(b: Branch): Promise<void> {
    const ok = window.confirm(`Delete branch "${b.name}"? This cannot be undone.`);
    if (!ok) return;
    await deleteBranch(b.name);
  }

  function showBranchMenu(e: React.MouseEvent, b: Branch): void {
    e.preventDefault();
    const items: MenuItem[] = b.isRemote
      ? [
          {
            label: `Checkout (track ${b.name})`,
            onClick: () => void handleCheckout(b.name.split('/').slice(1).join('/') || b.name),
          },
          { separator: true },
          { label: `Merge ${b.name} into ${currentName}`, onClick: () => void handleMerge(b.name) },
          { label: `Rebase ${currentName} onto ${b.name}`, onClick: () => void handleRebase(b.name) },
        ]
      : [
          {
            label: b.name === currentName ? 'Already on this branch' : `Checkout ${b.name}`,
            onClick: () => void handleCheckout(b.name),
          },
          { separator: true },
          { label: `Merge ${b.name} into ${currentName}`, onClick: () => void handleMerge(b.name) },
          { label: `Rebase ${currentName} onto ${b.name}`, onClick: () => void handleRebase(b.name) },
          { separator: true },
          {
            label: 'Delete branch',
            danger: true,
            onClick: () => void handleDelete(b),
          },
        ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  }

  function showStashMenu(e: React.MouseEvent, s: Stash): void {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: 'Apply stash', onClick: () => void stash('apply', { index: s.index }) },
      {
        label: 'Pop stash (apply + drop)',
        onClick: () => void stash('pop', { index: s.index }),
      },
      { separator: true },
      {
        label: 'Drop stash',
        danger: true,
        onClick: () => {
          if (window.confirm(`Drop stash@{${s.index}}? This cannot be undone.`)) {
            void stash('drop', { index: s.index });
          }
        },
      },
    ];
    setCtx({ x: e.clientX, y: e.clientY, items });
  }

  return (
    <div className="branch-tree">
      <SectionHeader
        label={`Local (${local.length})`}
        expanded={expanded.local}
        onToggle={() => toggle('local')}
      />
      {expanded.local &&
        local.map((b) => (
          <div
            key={b.fullName}
            className={`tree-row ${b.name === currentName ? 'active' : ''}`}
            onClick={() => void handleCheckout(b.name)}
            onContextMenu={(e) => showBranchMenu(e, b)}
            title={b.fullName}
          >
            <span className="name">{b.name}</span>
            {b.name === currentName ? <span className="badge head">HEAD</span> : null}
            {b.ahead > 0 ? <span className="badge ahead">↑{b.ahead}</span> : null}
            {b.behind > 0 ? <span className="badge behind">↓{b.behind}</span> : null}
          </div>
        ))}

      <SectionHeader
        label={`Remote (${remote.length})`}
        expanded={expanded.remote}
        onToggle={() => toggle('remote')}
      />
      {expanded.remote &&
        remote.map((b) => (
          <div
            key={b.fullName}
            className="tree-row remote"
            onContextMenu={(e) => showBranchMenu(e, b)}
            title={b.fullName}
          >
            <span className="name">{b.name}</span>
          </div>
        ))}

      <SectionHeader
        label={`Tags (${tags.length})`}
        expanded={expanded.tags}
        onToggle={() => toggle('tags')}
      />
      {expanded.tags &&
        tags.map((t) => (
          <div key={t.name} className="tree-row" title={t.commitHash}>
            <span className="name">{t.name}</span>
            <span className="badge">{t.commitHash.slice(0, 7)}</span>
          </div>
        ))}

      <SectionHeader
        label={`Stash (${stashes.length})`}
        expanded={expanded.stash}
        onToggle={() => toggle('stash')}
      />
      {expanded.stash &&
        stashes.map((s) => (
          <div
            key={s.index}
            className="tree-row"
            onContextMenu={(e) => showStashMenu(e, s)}
            title={s.message}
          >
            <span className="name">stash@{`{${s.index}}`}</span>
            <span className="badge">{s.branchName || '—'}</span>
          </div>
        ))}

      {ctx ? (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />
      ) : null}
    </div>
  );
}

function SectionHeader({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="tree-section-header" onClick={onToggle}>
      <span className="chev">{expanded ? '▾' : '▸'}</span>
      <span>{label}</span>
    </div>
  );
}
