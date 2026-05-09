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

export interface GraphLine {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  color: string;
  branchTip?: boolean; // line emerging from a "merge-in" column above
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
  // Each pending line records (fromHash, fromCol, toHash, color); we resolve
  // toRow once the parent is processed.
  interface PendingLine {
    fromHash: string;
    fromRow: number;
    fromCol: number;
    toHash: string;
    color: string;
    branchTip?: boolean;
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
    if (waitingCols.length > 0) {
      myCol = waitingCols[0];
    } else {
      myCol = allocColumn();
    }
    allocColor(myCol);

    // 2. Free the columns that were merging in (we'll draw a line from each
    //    of them down into myCol at this row).
    for (const wc of waitingCols) {
      if (wc !== myCol) {
        // Line: descendant lane (col=wc) down into our column at this row.
        // We don't know the descendant's exact row, but the descendant already
        // emitted a passthrough line ending at row-1, so this segment just
        // covers the join from (wc, row-1) to (myCol, row).
        lines.push({
          fromRow: row - 1,
          fromCol: wc,
          toRow: row,
          toCol: myCol,
          color: columnColor[wc] ?? columnColor[myCol],
          branchTip: true,
        });
        columnPool[wc] = null;
      }
    }
    columnPool[myCol] = null;

    nodePositions.set(c.hash, { row, column: myCol });
    nodeColors.set(c.hash, columnColor[myCol]);

    // 3. Reserve columns for parents.
    if (c.parentHashes.length > 0) {
      // First parent — keep on same lane.
      const firstParent = c.parentHashes[0];
      columnPool[myCol] = firstParent;
      pending.push({
        fromHash: c.hash,
        fromRow: row,
        fromCol: myCol,
        toHash: firstParent,
        color: columnColor[myCol],
      });
      // Additional parents — branch off into new/free lanes.
      for (let i = 1; i < c.parentHashes.length; i++) {
        const p = c.parentHashes[i];
        // If a column is already waiting for this parent we can reuse it
        // (e.g. an existing lane converges into the same parent).
        let pCol = columnPool.findIndex((x) => x === p);
        if (pCol === -1) {
          pCol = allocColumn();
          columnPool[pCol] = p;
        }
        const color = allocColor(pCol);
        pending.push({
          fromHash: c.hash,
          fromRow: row,
          fromCol: myCol,
          toHash: p,
          color,
          branchTip: true,
        });
      }
    }

    // 4. Vertical passthrough lines for any column still waiting.
    //    A passthrough line goes from the previous row to this row at column c
    //    if that column is occupied AND its hash is not the current commit
    //    (because we just freed those above).
    for (let col = 0; col < columnPool.length; col++) {
      if (columnPool[col] === null) continue;
      // skip the lane we just emitted parent line for; it'll be added by
      // the pending-line resolution.
      if (col === myCol) continue;
      lines.push({
        fromRow: row - 1,
        fromCol: col,
        toRow: row,
        toCol: col,
        color: columnColor[col] ?? palette[0],
      });
    }
  }

  // Resolve pending parent lines now that we have all nodePositions.
  // Parents that are off the loaded window (paginated) are drawn going to
  // (row=commits.length, col=fromCol) — i.e. straight off the bottom.
  for (const pl of pending) {
    const target = nodePositions.get(pl.toHash);
    const toRow = target ? target.row : commits.length;
    const toCol = target ? target.column : pl.fromCol;
    lines.push({
      fromRow: pl.fromRow,
      fromCol: pl.fromCol,
      toRow,
      toCol,
      color: pl.color,
      branchTip: pl.branchTip,
    });
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
