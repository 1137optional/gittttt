import type { Commit } from '@shared/types';
import { theme } from '../theme';

// =============================================================================
// Commit graph layout
//
// Inputs:
//   commits: list ordered newest-first (row 0 is the newest commit). Parents
//   appear later in the list (or not at all when paginated).
//
// Outputs:
//   - nodePositions: per-hash {row, column}
//   - lines: every line segment to draw, with explicit start/end coordinates
//     in the same (row, column) coordinate space, plus a color
//   - columnsUsed: total number of columns the layout consumed (graph width)
//
// Algorithm (column-reuse):
//   For each commit (top to bottom):
//     1. Find all columns currently "waiting" for this commit hash.
//        These are columns where some descendant declared this commit as a
//        parent. The leftmost of these becomes the current commit's column;
//        the rest are "merge-in" lanes which we record line segments for and
//        then free.
//     2. If no column is waiting, allocate a free column (or grow the pool).
//     3. Free the columns that were resolved by this commit.
//     4. Emit lines for the commit's parents:
//        - The first parent stays in the same column → straight vertical.
//        - Additional parents grab a free/new column → diagonal at the merge.
// =============================================================================

export interface NodePosition {
  row: number;
  column: number;
}

// Discriminator the renderer uses to pick line-style.
//   'vertical'   — straight passthrough on a single lane (main flow)
//   'merge'      — diagonal joining a merge commit to a non-first parent;
//                  drawn as a solid bezier (visualises "merging back")
//   'branch-out' — diagonal first-parent line that ends up on a different lane
//                  because column reuse pushed the parent leftward;
//                  drawn as a dashed bezier (visualises "branched off main")
export type LineKind = 'vertical' | 'merge' | 'branch-out';

export interface GraphLine {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  color: string;
  kind: LineKind;
}

export interface GraphLayout {
  nodePositions: Map<string, NodePosition>;
  lines: GraphLine[];
  columnsUsed: number;
  totalRows: number;
  /** Hash → color of the lane the commit sits on. Used by the renderer. */
  nodeColors: Map<string, string>;
}

export function computeGraphLayout(commits: Commit[]): GraphLayout {
  const palette = theme.branchPalette;
  // columnPool[col] = hash of the commit this column is currently waiting for,
  // or null if the column is free and reusable.
  const columnPool: (string | null)[] = [];
  // For each waiting column, track whether the descendant that registered the
  // wait did so as a first-parent (the lane is the descendant's main flow) or
  // as a merge-side parent. The renderer uses this to draw branch-creation
  // diagonals dashed and merge-back diagonals as solid curves.
  const columnWasFirstParent: boolean[] = [];
  // Stable color per column index. Once a column is assigned a color it keeps
  // that color for the lifetime of this layout.
  const columnColor: string[] = [];
  let nextColorIdx = 0;
  const allocColor = (col: number): string => {
    if (columnColor[col]) return columnColor[col];
    const c = palette[nextColorIdx++ % palette.length];
    columnColor[col] = c;
    return c;
  };

  // Allocate (or reuse) a free column. Returns its index. The caller should
  // immediately assign a waiting hash to the slot.
  const allocColumn = (): number => {
    for (let i = 0; i < columnPool.length; i++) {
      if (columnPool[i] === null) return i;
    }
    columnPool.push(null);
    return columnPool.length - 1;
  };

  const nodePositions = new Map<string, NodePosition>();
  const nodeColors = new Map<string, string>();
  const lines: GraphLine[] = [];

  // We accumulate parent->row lookups so we can finalize line segments after
  // the loop (some parents are referenced before we know which row hosts them).
  // Each pending line records the source plus a flag describing how it was
  // produced — first parent vs. merge-side parent — so resolution time can
  // decide whether to emit a long bezier (merge-side) or skip in favour of
  // the natural passthrough+join shape (first-parent in-window).
  interface PendingLine {
    fromHash: string;
    fromRow: number;
    fromCol: number;
    toHash: string;
    color: string;
    isFirstParent: boolean;
  }
  const pending: PendingLine[] = [];

  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];

    // 1. Columns waiting for this commit (leftmost → mainCol).
    const waitingCols: number[] = [];
    for (let i = 0; i < columnPool.length; i++) {
      if (columnPool[i] === c.hash) waitingCols.push(i);
    }

    let myCol: number;
    const reusedCol = waitingCols.length > 0;
    if (reusedCol) {
      myCol = waitingCols[0];
    } else {
      myCol = allocColumn();
    }
    allocColor(myCol);
    // Snapshot the lane's pre-row provenance: if the column was waiting as
    // a merge-side parent then the merge bezier handles the visual flow
    // INTO this commit, so we'd want to suppress the otherwise-natural
    // vertical passthrough above the node.
    const priorWasFirstParent = reusedCol ? (columnWasFirstParent[myCol] ?? true) : true;

    // 2. Connect the active lane into the commit. If the column was reused
    //    from a previous first-parent waiting hash, draw the vertical
    //    segment from the previous row down into this commit's centre.
    //    Skip when the lane was in merge-transit (priorWasFirstParent is
    //    false): the merge bezier already terminates at this commit, so
    //    a vertical above the node would create a Y-shape junction.
    if (reusedCol && row > 0 && priorWasFirstParent) {
      lines.push({
        fromRow: row - 1,
        fromCol: myCol,
        toRow: row,
        toCol: myCol,
        color: columnColor[myCol] ?? palette[0],
        kind: 'vertical',
      });
    }

    // Free the columns that were merging in (small diagonal join from each
    // of them down into myCol at this row). The kind of that join depends
    // on why the lane was reserved: first-parent lanes visualise a
    // "branch-out" terminating into main (dashed); merge-side lanes
    // visualise a "merge-back" join (solid bezier).
    for (const wc of waitingCols) {
      if (wc !== myCol) {
        const wasFP = columnWasFirstParent[wc] ?? true;
        lines.push({
          fromRow: row - 1,
          fromCol: wc,
          toRow: row,
          toCol: myCol,
          color: columnColor[wc] ?? columnColor[myCol],
          kind: wasFP ? 'branch-out' : 'merge',
        });
        columnPool[wc] = null;
        columnWasFirstParent[wc] = false;
      }
    }
    columnPool[myCol] = null;
    columnWasFirstParent[myCol] = false;

    nodePositions.set(c.hash, { row, column: myCol });
    nodeColors.set(c.hash, columnColor[myCol]);

    // 3. Reserve columns for parents. Track which columns were freshly
    //    allocated this row so step 4 doesn't emit a bogus stub above them.
    const justAllocated = new Set<number>();
    if (c.parentHashes.length > 0) {
      // First parent — keep on same lane.
      const firstParent = c.parentHashes[0];
      columnPool[myCol] = firstParent;
      columnWasFirstParent[myCol] = true;
      pending.push({
        fromHash: c.hash,
        fromRow: row,
        fromCol: myCol,
        toHash: firstParent,
        color: columnColor[myCol],
        isFirstParent: true,
      });
      // Additional parents — branch off into new/free lanes.
      for (let i = 1; i < c.parentHashes.length; i++) {
        const p = c.parentHashes[i];
        let pCol = columnPool.findIndex((x) => x === p);
        if (pCol === -1) {
          pCol = allocColumn();
          columnPool[pCol] = p;
          justAllocated.add(pCol);
        }
        columnWasFirstParent[pCol] = false;
        const color = allocColor(pCol);
        pending.push({
          fromHash: c.hash,
          fromRow: row,
          fromCol: myCol,
          toHash: p,
          color,
          isFirstParent: false,
        });
      }
    }

    // 4. Vertical passthrough lines for OTHER waiting columns.
    //    - col === myCol is already handled in step 2 above.
    //    - justAllocated columns: introduced THIS row by step 3b for a
    //      merge-side parent; emitting a passthrough would draw a stub
    //      above the row where the column was first introduced.
    //    - merge-transit columns (waiting for a non-first-parent of an
    //      earlier merge): the long bezier already paints the lane, so a
    //      vertical passthrough would conflict with the curve. Once the
    //      target commit is processed, its first-parent assignment flips
    //      `columnWasFirstParent[col]` back to true and passthroughs
    //      resume normally for further descendants of that lane.
    for (let col = 0; col < columnPool.length; col++) {
      if (columnPool[col] === null) continue;
      if (col === myCol) continue;
      if (justAllocated.has(col)) continue;
      if (columnWasFirstParent[col] === false) continue;
      lines.push({
        fromRow: row - 1,
        fromCol: col,
        toRow: row,
        toCol: col,
        color: columnColor[col] ?? palette[0],
        kind: 'vertical',
      });
    }
  }

  // Resolve pending parent lines now that we have all nodePositions.
  //
  // First-parent lines are usually redundant with the natural lane shape
  // (vertical passthroughs + step-1 join), so we DROP them when the parent
  // is in-window. We keep them for off-window parents to draw a fading trail
  // off the bottom of the canvas.
  //
  // Merge-side (non-first-parent) lines are kept — they draw the long curve
  // from the merge commit down into its other parent's lane.
  for (const pl of pending) {
    const target = nodePositions.get(pl.toHash);
    if (target) {
      if (pl.isFirstParent) {
        // Lane shape already covered by passthroughs + step-1 join.
        continue;
      }
      lines.push({
        fromRow: pl.fromRow,
        fromCol: pl.fromCol,
        toRow: target.row,
        toCol: target.column,
        color: pl.color,
        kind: 'merge',
      });
    } else {
      lines.push({
        fromRow: pl.fromRow,
        fromCol: pl.fromCol,
        toRow: commits.length,
        toCol: pl.fromCol,
        color: pl.color,
        kind: 'vertical',
      });
    }
  }

  return {
    nodePositions,
    nodeColors,
    lines,
    columnsUsed: columnPool.length,
    totalRows: commits.length,
  };
}

// Pixel coordinate helpers shared by renderer and click detection.
export function rowToY(row: number): number {
  return theme.graph.topPadding + row * theme.graph.rowHeight;
}
export function colToX(col: number): number {
  return theme.graph.leftPadding + col * theme.graph.columnWidth;
}
