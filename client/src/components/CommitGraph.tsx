import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { computeGraphLayout, colToX, rowToY, type GraphLayout } from '../graph/graphLayout';
import { ageOpacity, theme } from '../theme';
import type { Commit } from '@shared/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { NewBranchModal } from './NewBranchModal';

const ROW_H = theme.graph.rowHeight;
const COL_W = theme.graph.columnWidth;
const NODE_R = theme.graph.nodeRadius;          // 8 → 16px diameter
const SELECTED_R = theme.graph.selectedRadius;
const NODE_BORDER = theme.graph.nodeBorder;     // 2px white halo
const HEAD_HALO_R = theme.graph.headHaloRadius; // outer dashed ring
const LABEL_OFFSET = theme.graph.labelOffsetX;  // 25px → first label
const META_GUTTER = theme.graph.metaGutter;
const META_WIDTH = theme.graph.metaWidth;

export function CommitGraph(): JSX.Element {
  const commits = useApp((s) => s.commits);
  const totalCount = useApp((s) => s.totalCommitCount);
  const selectedHash = useApp((s) => s.selectedCommitHash);
  const highlighted = useApp((s) => s.highlightedHashes);
  const repoBranch = useApp((s) => s.repo?.currentBranchName ?? '');
  const status = useApp((s) => s.status);
  const selectCommit = useApp((s) => s.selectCommit);
  const checkout = useApp((s) => s.checkout);
  const merge = useApp((s) => s.merge);
  const rebase = useApp((s) => s.rebase);
  const cherryPick = useApp((s) => s.cherryPick);
  const revert = useApp((s) => s.revert);
  const pushTo = useApp((s) => s.pushTo);
  const pushToast = useApp((s) => s.pushToast);
  const loadMore = useApp((s) => s.loadMoreCommits);
  const loadingMore = useApp((s) => s.loadingMore);
  // Subscribe to theme so the draw effect re-runs when light/dark flips.
  // (Renamed to `themeMode` to avoid shadowing the imported design-token
  // object, which is also called `theme`.)
  const themeMode = useApp((s) => s.theme);

  const layout = useMemo<GraphLayout>(() => computeGraphLayout(commits), [commits]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  // Right-click context menu + "create branch from this commit" modal.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [branchFrom, setBranchFrom] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawGraph(ctx, {
      width: size.w,
      height: size.h,
      scrollTop,
      layout,
      commits,
      selectedHash,
      highlighted,
      currentBranch: repoBranch,
    });
  }, [size, scrollTop, layout, commits, selectedHash, highlighted, repoBranch, themeMode]);

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < ROW_H * 50 && !loadingMore && commits.length < totalCount) {
      void loadMore();
    }
  }

  // Translate a (clientX, clientY) into the commit row beneath it (or null
  // if the click was in dead space). Used by both left-click selection and
  // right-click context menu.
  function commitAt(clientX: number, clientY: number): Commit | null {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top + scrollTop;
    const row = Math.round((y - theme.graph.topPadding) / ROW_H);
    if (row < 0 || row >= commits.length) return null;
    const c = commits[row];
    const pos = layout.nodePositions.get(c.hash);
    if (!pos) return null;
    const cx = colToX(pos.column);
    const cy = rowToY(pos.row);
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= (SELECTED_R + 8) ** 2) return c;
    // Clicks anywhere on the row past the graph land on the commit too —
    // that's the most-discoverable hit area for the right-side metadata.
    if (x > theme.graph.leftPadding + layout.columnsUsed * COL_W) return c;
    return null;
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>): void {
    const c = commitAt(e.clientX, e.clientY);
    if (c) void selectCommit(c.hash);
  }

  // Pre-flight gate for mutations that change the working tree (merge,
  // rebase, cherry-pick, revert). Mirrors the branch-list pre-flight in the
  // sidebar so the user gets a consistent warning.
  function preflight(): boolean {
    if (!status) return true;
    if (status.inMerge || status.inRebase) {
      pushToast('warn', 'Finish or abort the in-progress merge/rebase first.');
      return false;
    }
    const dirty = status.unstaged.length + status.staged.length;
    if (dirty > 0) {
      return window.confirm(
        `You have ${dirty} uncommitted change${dirty === 1 ? '' : 's'}. Continue anyway?`,
      );
    }
    return true;
  }

  function copy(text: string, label: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast('success', `${label} copied`))
      .catch(() => pushToast('error', 'Could not copy to clipboard'));
  }

  function onContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    const c = commitAt(e.clientX, e.clientY);
    if (!c) return;
    e.preventDefault();
    void selectCommit(c.hash);

    const isHEAD = c.refs.some((r) => r.type === 'head');
    const current = repoBranch || 'HEAD';
    const items: MenuItem[] = [
      {
        label: 'Checkout this commit (detached)',
        onClick: () => {
          if (!preflight()) return;
          void checkout(c.hash);
        },
      },
      {
        label: 'Create branch from this commit…',
        onClick: () => setBranchFrom(c.hash),
      },
      { separator: true },
      {
        label: `Cherry-pick onto ${current}`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', 'That commit is already HEAD.');
            return;
          }
          if (!preflight()) return;
          void cherryPick(c.hash);
        },
      },
      {
        label: 'Revert this commit',
        onClick: () => {
          if (!preflight()) return;
          void revert(c.hash);
        },
      },
      { separator: true },
      {
        label: `Merge into ${current}`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', "Can't merge HEAD into itself.");
            return;
          }
          if (!preflight()) return;
          void merge(c.hash);
        },
      },
      {
        label: `Rebase ${current} onto this commit`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', 'Already on this commit.');
            return;
          }
          if (!preflight()) return;
          void rebase(c.hash);
        },
      },
    ];

    const pushTargets =
      repoBranch !== ''
        ? Array.from(
            new Set(
              c.refs
                .filter((r) => r.type === 'branch' && r.name && r.name !== repoBranch)
                .map((r) => r.name as string),
            ),
          ).sort((a, b) => a.localeCompare(b))
        : [];
    if (pushTargets.length > 0) {
      items.push({ separator: true });
      for (const tgt of pushTargets) {
        items.push({
          label: `Push ${repoBranch} → ${tgt}`,
          onClick: () => void pushTo(tgt),
        });
      }
    }

    items.push(
      { separator: true },
      {
        label: `Copy hash (${c.shortHash})`,
        onClick: () => copy(c.hash, 'Hash'),
      },
      {
        label: 'Copy short hash',
        onClick: () => copy(c.shortHash, 'Short hash'),
      },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  if (commits.length === 0) {
    return <div className="graph-empty">No commits yet</div>;
  }

  const totalHeight =
    layout.totalRows * ROW_H + theme.graph.topPadding * 2;

  // Lookup the selected commit by hash for the modal label.
  const branchFromCommit = branchFrom ? commits.find((c) => c.hash === branchFrom) : null;

  return (
    <>
      <div
        className="graph-wrap"
        ref={containerRef}
        onScroll={onScroll}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <canvas
            className="graph-canvas"
            ref={canvasRef}
            style={{ position: 'sticky', top: 0, left: 0 }}
          />
        </div>
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}
      {branchFrom ? (
        <NewBranchModal
          from={branchFrom}
          fromLabel={
            branchFromCommit
              ? `${branchFromCommit.shortHash} · ${branchFromCommit.message.split('\n')[0]}`
              : branchFrom.slice(0, 7)
          }
          onClose={() => setBranchFrom(null)}
        />
      ) : null}
    </>
  );
}

interface DrawArgs {
  width: number;
  height: number;
  scrollTop: number;
  layout: GraphLayout;
  commits: Commit[];
  selectedHash: string | null;
  highlighted: Set<string>;
  currentBranch: string;
}

function drawGraph(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  // Pull live theme colors from CSS variables on every paint so the graph
  // re-themes for free when the user toggles light/dark.
  const root = getComputedStyle(document.documentElement);
  const themeCard = root.getPropertyValue('--canvas-card').trim() || '#ffffff';
  const themeZebra = root.getPropertyValue('--canvas-zebra').trim() || '#fafbfc';
  const themeRowSelected =
    root.getPropertyValue('--canvas-row-selected').trim() || 'rgba(55,138,221,0.08)';
  const themeFgMuted = root.getPropertyValue('--fg-muted').trim() || '#999999';

  ctx.fillStyle = themeCard;
  ctx.fillRect(0, 0, a.width, a.height);

  // Faint zebra stripes per row to help the eye track horizontally.
  const firstRow = Math.max(0, Math.floor((a.scrollTop - theme.graph.topPadding) / ROW_H) - 2);
  const lastRow = Math.min(
    a.layout.totalRows - 1,
    Math.ceil((a.scrollTop + a.height - theme.graph.topPadding) / ROW_H) + 2,
  );
  const yOffset = a.scrollTop;

  for (let row = firstRow; row <= lastRow; row++) {
    if (row % 2 === 1) continue;
    const y = rowToY(row) - yOffset - ROW_H / 2;
    ctx.fillStyle = themeZebra;
    ctx.fillRect(0, y, a.width, ROW_H);
  }

  // Selected row highlight (full-width pale brand wash).
  for (let row = firstRow; row <= lastRow; row++) {
    const c = a.commits[row];
    if (!c || c.hash !== a.selectedHash) continue;
    const y = rowToY(row) - yOffset - ROW_H / 2;
    ctx.fillStyle = themeRowSelected;
    ctx.fillRect(0, y, a.width, ROW_H);
  }

  // Lines first (so node markers sit on top). We draw in two passes so dashed
  // branch-out lines overlay solid lines deterministically; otherwise a long
  // pending diagonal could print under a passthrough that came after it.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  type LineEntry = (typeof a.layout.lines)[number];
  const solid: LineEntry[] = [];
  const dashed: LineEntry[] = [];
  for (const line of a.layout.lines) {
    if (line.toRow < firstRow || line.fromRow > lastRow) continue;
    if (line.kind === 'branch-out') dashed.push(line);
    else solid.push(line);
  }

  function strokeLine(line: LineEntry): void {
    const x1 = colToX(line.fromCol);
    const y1 = rowToY(line.fromRow) - yOffset;
    const x2 = colToX(line.toCol);
    const y2 = rowToY(line.toRow) - yOffset;
    ctx.strokeStyle = line.color;
    ctx.lineWidth = theme.graph.lineWidth;
    ctx.beginPath();
    if (x1 === x2) {
      // Vertical lane — straight, no curve.
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    } else {
      // Diagonal — smooth bezier S-curve. Control points sit at the
      // mid-row on each end so the line stays vertical at the endpoints
      // and arcs across in the middle. Looks the same in solid or dashed.
      const midY = (y1 + y2) / 2;
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 0.95;
  ctx.setLineDash([]);
  for (const line of solid) strokeLine(line);

  // Dashed pass: 4px on / 4px off as in the spec. We bump alpha down
  // slightly so the dashed branch-out lines read as "secondary" relative
  // to the solid main flow.
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.85;
  for (const line of dashed) strokeLine(line);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.textBaseline = 'middle';

  for (let row = firstRow; row <= lastRow; row++) {
    const c = a.commits[row];
    if (!c) continue;
    const pos = a.layout.nodePositions.get(c.hash);
    if (!pos) continue;
    const cx = colToX(pos.column);
    const cy = rowToY(pos.row) - yOffset;
    const color = a.layout.nodeColors.get(c.hash) ?? theme.accent.primary;

    const alpha = ageOpacity(c.timestamp);
    const isHEAD = c.refs.some((r) => r.type === 'head');
    const isSelected = c.hash === a.selectedHash;

    // Search highlight — outermost ring (well outside the dashed HEAD halo).
    if (a.highlighted.has(c.hash)) {
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_R + 8, 0, Math.PI * 2);
      ctx.strokeStyle = theme.accent.warning;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // Selected — saturated ring just inside the search highlight.
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(cx, cy, SELECTED_R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // HEAD: dashed outer halo at r = NODE_R + 4 (= 12). Dashed style signals
    // "current active commit" without competing with the solid node fill.
    if (isHEAD) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(cx, cy, HEAD_HALO_R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Node body — 16px circle with 2px halo (matching card surface so it
    // reads as a "punched out" disc against zebra stripes / lines).
    ctx.globalAlpha = alpha;
    const r = NODE_R;
    if (c.isMerge) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
      ctx.fillStyle = themeCard;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r + NODE_BORDER, 0, Math.PI * 2);
      ctx.fillStyle = themeCard;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Branch tags next to the node — first label sits +25px right of node centre.
    let labelX = cx + LABEL_OFFSET;
    for (const ref of c.refs) {
      const isHeadPill = ref.type === 'head';
      const isCurrent =
        ref.type === 'branch' && ref.name === a.currentBranch;
      const text =
        ref.type === 'tag'
          ? `▸ ${ref.name}`
          : isHeadPill
            ? 'HEAD'
            : ref.type === 'remote'
              ? `↗ ${ref.name}`
              : ref.name;

      const pillColor = isHeadPill ? theme.accent.primary : color;
      const softBg = root.getPropertyValue('--soft-gray').trim() || '#F5F5F5';
      const softBorder = root.getPropertyValue('--border-strong').trim() || '#E2E4E9';
      const fgSecondary = root.getPropertyValue('--fg-secondary').trim() || theme.fg.secondary;
      const bg = isCurrent || isHeadPill ? withAlpha(pillColor, 0.14) : softBg;
      const border = isCurrent || isHeadPill ? withAlpha(pillColor, 0.5) : softBorder;
      const fg = isCurrent || isHeadPill ? pillColor : fgSecondary;

      ctx.font = `500 10.5px ${theme.font.code}`;
      const padX = 7;
      const w = ctx.measureText(text).width + padX * 2;
      drawPill(ctx, labelX, cy, w, 18, bg, border, fg, text);
      labelX += w + 6;
    }

    const metaCellLeft = a.width - META_WIDTH - 14;
    const subjectStart =
      c.refs.length > 0
        ? labelX + 8
        : Math.max(
            theme.graph.leftPadding + a.layout.columnsUsed * COL_W + META_GUTTER,
            cx + LABEL_OFFSET,
          );
    const subjectMax = metaCellLeft - subjectStart - 8;

    if (subjectMax > 40) {
      ctx.font = `${isSelected ? 600 : 500} 13px ${theme.font.ui}`;
      ctx.globalAlpha = alpha;
      // Per spec: the subject label uses the branch colour. Selected commits
      // bump to the deeper accent so the focused row has extra weight.
      ctx.fillStyle = isSelected ? theme.accent.primaryDeep : color;
      const subject = c.message.split('\n')[0];
      ctx.textAlign = 'left';
      ctx.fillText(truncate(ctx, subject, subjectMax), subjectStart, cy);
      ctx.globalAlpha = 1;
    }

    // Right meta column — author + relative time, kept in muted gray so the
    // colored subject column reads as the primary signal.
    ctx.font = `400 11.5px ${theme.font.code}`;
    ctx.fillStyle = themeFgMuted;
    ctx.globalAlpha = Math.min(1, alpha + 0.05);
    const author = c.authorName.split(' ')[0];
    const meta = `${c.shortHash}  ${author}  ${formatRelative(c.timestamp)}`;
    ctx.textAlign = 'right';
    ctx.fillText(truncate(ctx, meta, META_WIDTH), a.width - 14, cy);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  w: number,
  h: number,
  bg: string,
  border: string,
  fg: string,
  text: string,
): void {
  const r = 4;
  const y = cy - h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 7, cy + 0.5);
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

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
