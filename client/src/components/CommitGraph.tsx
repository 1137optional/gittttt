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

  // Resolve theme-driven CSS variables exactly once per theme flip and
  // reuse the snapshot for every paint. Without this cache we'd re-run
  // `getComputedStyle(...)` plus a dozen `getPropertyValue(...).trim()`
  // calls on every scroll tick — measurable jank on a busy graph.
  const themeColors = useMemo<ThemeColors>(() => readThemeColors(), [themeMode]);

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
      currentBranch: repoBranch,
      colors: themeColors,
    });
  }, [size, scrollTop, layout, commits, selectedHash, repoBranch, themeColors]);

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
      pushToast('warn', '请先完成或中止正在进行的合并 / 变基');
      return false;
    }
    const dirty = status.unstaged.length + status.staged.length;
    if (dirty > 0) {
      return window.confirm(`有 ${dirty} 个未提交改动，仍要继续？`);
    }
    return true;
  }

  function copy(text: string, label: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast('success', `${label} 已复制`))
      .catch(() => pushToast('error', '复制失败'));
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
        label: '检出此 commit（分离）',
        onClick: () => {
          if (!preflight()) return;
          void checkout(c.hash);
        },
      },
      {
        label: '从此 commit 新建分支…',
        onClick: () => setBranchFrom(c.hash),
      },
      { separator: true },
      {
        label: `Cherry-pick 到 ${current}`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', '已是当前 HEAD');
            return;
          }
          if (!preflight()) return;
          void cherryPick(c.hash);
        },
      },
      {
        label: '撤销此 commit（revert）',
        onClick: () => {
          if (!preflight()) return;
          void revert(c.hash);
        },
      },
      { separator: true },
      {
        label: `合并到 ${current}`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', '不能把 HEAD 合并到自己');
            return;
          }
          if (!preflight()) return;
          void merge(c.hash);
        },
      },
      {
        label: `变基 ${current} 到此 commit`,
        onClick: () => {
          if (isHEAD) {
            pushToast('warn', '已在此 commit 上');
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
          label: `推送 ${repoBranch} → ${tgt}`,
          onClick: () => void pushTo(tgt),
        });
      }
    }

    items.push(
      { separator: true },
      {
        label: `复制 hash (${c.shortHash})`,
        onClick: () => copy(c.hash, 'Hash'),
      },
      {
        label: '复制短 hash',
        onClick: () => copy(c.shortHash, '短 hash'),
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
  currentBranch: string;
  colors: ThemeColors;
}

interface ThemeColors {
  card: string;
  zebra: string;
  rowSelected: string;
  fgMuted: string;
  fgSecondary: string;
  softBg: string;
  softBorder: string;
}

// Read every theme-dependent CSS variable in one shot. The result is
// memoised by the caller (`useMemo([themeMode])`) so we only pay this DOM
// roundtrip on theme flips, not on scroll/resize/paint.
function readThemeColors(): ThemeColors {
  const r = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    r.getPropertyValue(name).trim() || fallback;
  return {
    card: v('--canvas-card', '#ffffff'),
    zebra: v('--canvas-zebra', '#fafbfc'),
    rowSelected: v('--canvas-row-selected', 'rgba(0,122,255,0.07)'),
    fgMuted: v('--fg-muted', '#8e8e93'),
    fgSecondary: v('--fg-secondary', theme.fg.secondary),
    softBg: v('--soft-gray', '#f0f1f4'),
    softBorder: v('--border-strong', '#dadce0'),
  };
}

function drawGraph(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  const { card: themeCard, zebra: themeZebra, rowSelected: themeRowSelected, fgMuted: themeFgMuted } = a.colors;

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
      // Diagonal: arc within ONE row of the source, then run a straight
      // vertical lane on the destination column for the rest.
      //
      // Previously the bezier control points sat at (y1+y2)/2, which only
      // looked right when |dy| ≈ |dx|. For long merge curves (many rows
      // span, one column shift) that midpoint is far away from either lane
      // and the curve drifted off-axis, then snapped back near the
      // endpoint — visually reads as a "broken / disconnected" line,
      // especially under virtualisation where only part of the curve is
      // on-screen. The arc-then-vertical shape is what GitKraken /
      // Sourcetree use and keeps every long line on a clean lane.
      const ROW_H_LOCAL = theme.graph.rowHeight;
      const dy = y2 - y1;
      const dyAbs = Math.abs(dy);
      // Arc spans up to ROW_H, or the whole distance for short hops.
      const arcSpan = Math.min(ROW_H_LOCAL, dyAbs);
      const dir = dy >= 0 ? 1 : -1;
      const arcEndY = y1 + dir * arcSpan;
      const arcMidY = (y1 + arcEndY) / 2;
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, arcMidY, x2, arcMidY, x2, arcEndY);
      if (arcEndY !== y2) {
        // Straight lane down the parent column for the remaining distance.
        // Same path → continuous stroke, no seam.
        ctx.lineTo(x2, y2);
      }
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

    // Selected — saturated ring outside the dashed HEAD halo.
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

    // Branch tags next to the node — first label sits +LABEL_OFFSET right of node centre.
    //
    // Width budget:
    //   refsHardRight = the rightmost x a pill is allowed to touch. Below
    //   this we always reserve `minSubjectGap` pixels for the commit
    //   subject, otherwise the row degenerates into "all pills, no
    //   message". The meta column on the far right is laid out separately
    //   and is fixed-width (META_WIDTH).
    //
    //   maxPillTextWidth caps any single pill — without this, one
    //   pathological ref name (e.g. an `origin/<long Unicode branch>`)
    //   eats the whole row and pushes the hash/author/time out of view.
    //
    // Each pill that doesn't fit naturally is truncated with `…`. If even
    // a truncated pill would overflow the budget we stop and emit a
    // "+N" overflow chip so the user still sees that more refs exist.
    const metaCellLeft = a.width - META_WIDTH - 14;
    const minSubjectGap = 60;
    const refsHardRight = metaCellLeft - minSubjectGap;
    const maxPillTextWidth = 160;
    const refPadX = 7;
    ctx.font = `500 10.5px ${theme.font.code}`;

    let labelX = cx + LABEL_OFFSET;
    let drawnRefIdx = 0;
    let firstSkippedIdx = c.refs.length;
    for (let i = 0; i < c.refs.length; i++) {
      const ref = c.refs[i];
      const remaining = c.refs.length - i;
      // Reserve room for the "+N" overflow chip when there's a chance
      // we'll cut off later refs. ~38px is a generous estimate for "+N".
      const reserveOverflow = remaining > 1 ? 38 : 0;

      const isHeadPill = ref.type === 'head';
      const isCurrent =
        ref.type === 'branch' && ref.name === a.currentBranch;
      const text = isHeadPill ? 'HEAD' : ref.name;

      const naturalW = ctx.measureText(text).width + refPadX * 2;
      const availForThisPill = refsHardRight - labelX - reserveOverflow;
      // Need at least enough room for a single character + padding.
      if (availForThisPill < 32) {
        firstSkippedIdx = i;
        break;
      }

      const cappedW = Math.min(naturalW, maxPillTextWidth, availForThisPill);
      let pillText = text;
      if (cappedW < naturalW) {
        pillText = truncate(ctx, text, cappedW - refPadX * 2);
      }
      const finalW = ctx.measureText(pillText).width + refPadX * 2;

      const pillColor = isHeadPill ? theme.accent.primary : color;
      const bg = isCurrent || isHeadPill ? withAlpha(pillColor, 0.14) : a.colors.softBg;
      const border = isCurrent || isHeadPill ? withAlpha(pillColor, 0.5) : a.colors.softBorder;
      const fg = isCurrent || isHeadPill ? pillColor : a.colors.fgSecondary;

      drawPill(ctx, labelX, cy, finalW, 18, bg, border, fg, pillText);
      labelX += finalW + 6;
      drawnRefIdx = i + 1;
    }
    if (firstSkippedIdx < c.refs.length) {
      const overflowText = `+${c.refs.length - firstSkippedIdx}`;
      const ow = ctx.measureText(overflowText).width + refPadX * 2;
      drawPill(
        ctx,
        labelX,
        cy,
        ow,
        18,
        a.colors.softBg,
        a.colors.softBorder,
        a.colors.fgMuted,
        overflowText,
      );
      labelX += ow + 6;
    }

    const drewAnyChip = drawnRefIdx > 0 || firstSkippedIdx < c.refs.length;
    const subjectStart = drewAnyChip
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
