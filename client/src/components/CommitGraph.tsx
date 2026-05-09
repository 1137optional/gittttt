import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { computeGraphLayout, colToX, rowToY, type GraphLayout } from '../graph/graphLayout';
import { ageOpacity, theme } from '../theme';
import type { Commit } from '@shared/types';

const ROW_H = theme.graph.rowHeight;
const COL_W = theme.graph.columnWidth;
const NODE_R = theme.graph.nodeRadius;
const HEAD_R = theme.graph.headRadius;
const SELECTED_R = theme.graph.selectedRadius;
const META_GUTTER = 16;

export function CommitGraph(): JSX.Element {
  const commits = useApp((s) => s.commits);
  const totalCount = useApp((s) => s.totalCommitCount);
  const selectedHash = useApp((s) => s.selectedCommitHash);
  const highlighted = useApp((s) => s.highlightedHashes);
  const repoBranch = useApp((s) => s.repo?.currentBranchName ?? '');
  const selectCommit = useApp((s) => s.selectCommit);
  const loadMore = useApp((s) => s.loadMoreCommits);
  const loadingMore = useApp((s) => s.loadingMore);

  const layout = useMemo<GraphLayout>(() => computeGraphLayout(commits), [commits]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  // Sync canvas size to its panel.
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

  // Render to canvas — every scroll/resize/layout-change.
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
  }, [size, scrollTop, layout, commits, selectedHash, highlighted, repoBranch]);

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < ROW_H * 50 && !loadingMore && commits.length < totalCount) {
      void loadMore();
    }
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>): void {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + scrollTop;
    const row = Math.round((y - theme.graph.topPadding) / ROW_H);
    if (row < 0 || row >= commits.length) return;
    const c = commits[row];
    const pos = layout.nodePositions.get(c.hash);
    if (!pos) return;
    const cx = colToX(pos.column);
    const cy = rowToY(pos.row);
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= (SELECTED_R + 6) ** 2) {
      void selectCommit(c.hash);
      return;
    }
    if (x > theme.graph.leftPadding + layout.columnsUsed * COL_W) {
      void selectCommit(c.hash);
    }
  }

  if (commits.length === 0) {
    return <div className="graph-empty">no commits</div>;
  }

  const totalHeight =
    layout.totalRows * ROW_H + theme.graph.topPadding * 2;

  return (
    <div
      className="graph-wrap"
      ref={containerRef}
      onScroll={onScroll}
      onClick={onClick}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <canvas
          className="graph-canvas"
          ref={canvasRef}
          style={{ position: 'sticky', top: 0, left: 0 }}
        />
      </div>
    </div>
  );
}

// =============================================================================
// Drawing
// =============================================================================

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
  // Clear with the panel base color (transparent so the body radial-gradient
  // shows through in static screenshots).
  ctx.fillStyle = theme.bg.base;
  ctx.fillRect(0, 0, a.width, a.height);

  const firstRow = Math.max(0, Math.floor((a.scrollTop - theme.graph.topPadding) / ROW_H) - 2);
  const lastRow = Math.min(
    a.layout.totalRows - 1,
    Math.ceil((a.scrollTop + a.height - theme.graph.topPadding) / ROW_H) + 2,
  );
  const yOffset = a.scrollTop;

  // -- Lines (drawn first so nodes sit on top). Lines stay fully opaque to
  //    keep the time spine readable; only nodes + text fade with age.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of a.layout.lines) {
    if (line.toRow < firstRow || line.fromRow > lastRow) continue;
    const x1 = colToX(line.fromCol);
    const y1 = rowToY(line.fromRow) - yOffset;
    const x2 = colToX(line.toCol);
    const y2 = rowToY(line.toRow) - yOffset;

    ctx.strokeStyle = line.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = theme.graph.lineWidth;
    ctx.beginPath();
    if (x1 === x2) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    } else {
      const midY = (y1 + y2) / 2;
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // -- Nodes + text per visible row. Each row has its own age-derived alpha.
  ctx.font = `500 12px ${theme.font.ui}`;
  ctx.textBaseline = 'middle';

  const metaXBase = theme.graph.leftPadding + a.layout.columnsUsed * COL_W + META_GUTTER;

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
    const isCurrentBranchTip = c.refs.some(
      (r) => r.type === 'branch' && r.name === a.currentBranch,
    );

    // Selected ring (non-faded — selection always reads strong)
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(cx, cy, SELECTED_R + 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(cx, cy, SELECTED_R + 4, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Search highlight
    if (a.highlighted.has(c.hash)) {
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = theme.accent.warning;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // HEAD glow — pale green halo, slightly larger node.
    if (isHEAD) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, HEAD_R + 8);
      grad.addColorStop(0, 'rgba(74, 222, 128, 0.55)');
      grad.addColorStop(1, 'rgba(74, 222, 128, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - HEAD_R - 10, cy - HEAD_R - 10, (HEAD_R + 10) * 2, (HEAD_R + 10) * 2);
    } else if (isCurrentBranchTip) {
      // Faint cyan halo for current branch tip.
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, NODE_R + 8);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - NODE_R - 10, cy - NODE_R - 10, (NODE_R + 10) * 2, (NODE_R + 10) * 2);
    }

    // Node body — faded by age.
    const r = isHEAD ? HEAD_R : c.isMerge ? NODE_R + 1 : NODE_R;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (c.isMerge) {
      // Hollow ring for merge commits.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (isHEAD) {
      // Inner mark on HEAD node so it pops on its own.
      ctx.beginPath();
      ctx.arc(cx, cy, HEAD_R - 2, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent.success;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Ref pills next to the node.
    let labelX = cx + r + 8;
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

      const pillColor = isHeadPill
        ? theme.accent.success
        : isCurrent
          ? theme.accent.primary
          : ref.type === 'remote'
            ? theme.fg.muted
            : color;
      const fgColor = isHeadPill || isCurrent ? '#06121f' : pillColor;
      const bgColor = isHeadPill || isCurrent ? pillColor : 'transparent';

      ctx.font = `500 10px ${theme.font.code}`;
      const padX = 6;
      const w = ctx.measureText(text).width + padX * 2;
      drawPill(ctx, labelX, cy, w, 16, bgColor, pillColor, fgColor, text);
      labelX += w + 5;
    }

    // Subject + meta text.
    const subjectX = Math.max(metaXBase, labelX + 6);
    const remaining = a.width - subjectX - 12;
    if (remaining > 60) {
      ctx.font = `500 12px ${theme.font.ui}`;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = isSelected ? theme.accent.primarySoft : theme.fg.primary;
      const subject = c.message.split('\n')[0];
      ctx.textAlign = 'left';
      ctx.fillText(truncate(ctx, subject, remaining * 0.62), subjectX, cy);

      ctx.font = `400 11px ${theme.font.code}`;
      ctx.fillStyle = theme.fg.muted;
      const meta = `${c.shortHash}  ·  ${c.authorName.split(' ')[0]}  ·  ${formatRelative(c.timestamp)}`;
      ctx.textAlign = 'right';
      ctx.fillText(truncate(ctx, meta, remaining * 0.38), a.width - 12, cy);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
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
  const r = 3;
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
  if (bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fill();
  }
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 6, cy + 0.5);
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
