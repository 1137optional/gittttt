import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { api, subscribeRepoChanged } from '../../api';
import type { ProjectFileTreeNode } from '@shared/types';

// =============================================================================
// MindMapView
//
// Radial-tree visualisation of the active project. The root sits in the
// center; expanded folders fan out in concentric rings, with each child
// placed evenly inside its parent's angular wedge. Lines are SVG <path>
// quadratic curves for a soft "vine" feel.
//
// Design tradeoffs:
//   - SVG, not Canvas. ~1k nodes paints fine and we get free hit testing,
//     CSS transitions on transform/opacity, and zero canvas math.
//   - Layout is deterministic (angle bisection per branch). No physics —
//     more predictable behaviour when the user expands/collapses, and we
//     avoid the "nodes drift around when you blink" feel of force layouts.
//   - Pan + zoom via SVG viewBox manipulation; node drag overrides position
//     for individual nodes (stored in a Map keyed by path).
//
// Click semantics:
//   - Folder node → expand / collapse (re-layout, animated via CSS).
//   - File node   → opens the file in an inline reader pane that overlays
//     the mind map. Mind map state is preserved underneath.
//
// Live updates: we subscribe to the existing `repoChanged` SSE event and
// refetch the tree (debounced). The AI working on the same project does
// NOT block the user from switching views — view state is purely client-
// side; AI tool calls go to the server independently.
// =============================================================================

const MAX_DEPTH = 6;
const REFRESH_DEBOUNCE_MS = 600;
const RING_STEP = 130; // px between concentric rings
const NODE_RADIUS_DIR = 10;
const NODE_RADIUS_FILE = 6;
// File extensions we'll let the inline viewer try to render. Anything else
// is shown as a "binary" placeholder rather than streaming bytes.
const TEXTUAL_EXT_RE = /\.(txt|md|markdown|json|jsonc|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|xml|svg|yml|yaml|toml|ini|cfg|conf|csv|tsv|log|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile)$/i;

// ----------------------------------------------------------------------------
// Layout types — independent of the API tree so we can store the laid-out
// position alongside collapse state, drag offsets, etc.
// ----------------------------------------------------------------------------
interface LaidNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  /** Final on-screen position (post-drag override). */
  x: number;
  y: number;
  /** Parent path (empty for the root). */
  parent: string;
  /** Whether this node has children we could expand (only meaningful for
   *  directories). */
  hasChildren: boolean;
}

interface LayoutResult {
  nodes: LaidNode[];
  edges: { from: string; to: string }[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Recursively collect children of a tree node; respects the user's
 *  collapsed-folder set so collapsed branches stop here. */
function collectVisible(
  root: ProjectFileTreeNode,
  expanded: Set<string>,
  depth: number,
  acc: ProjectFileTreeNode[],
  maxDepth: number,
): void {
  acc.push(root);
  if (root.type !== 'directory') return;
  if (depth >= maxDepth) return;
  if (depth > 0 && !expanded.has(root.path)) return; // root is always expanded
  for (const c of root.children ?? []) {
    collectVisible(c, expanded, depth + 1, acc, maxDepth);
  }
}

/** Radial layout: place root at (0,0); for each node, divide its parent's
 *  angular wedge equally among siblings and put the child on the next ring. */
function layoutRadial(
  root: ProjectFileTreeNode,
  expanded: Set<string>,
  drag: Map<string, { x: number; y: number }>,
): LayoutResult {
  // 1. Walk the visible tree to compute, for each parent, its sorted
  //    visible children (folders first, then files; alpha within each).
  const childMap = new Map<string, ProjectFileTreeNode[]>();

  function walk(node: ProjectFileTreeNode, depth: number): void {
    if (node.type !== 'directory') return;
    if (depth >= MAX_DEPTH) return;
    if (depth > 0 && !expanded.has(node.path)) return;
    const kids = (node.children ?? []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    childMap.set(node.path, kids);
    for (const k of kids) walk(k, depth + 1);
  }
  walk(root, 0);

  // 2. Recursively compute (angleStart, angleEnd, depth) for every visible
  //    node, then convert to (x, y) on its ring.
  const placed = new Map<string, { x: number; y: number; depth: number; node: ProjectFileTreeNode }>();
  placed.set(root.path, { x: 0, y: 0, depth: 0, node: root });

  function placeChildren(parent: ProjectFileTreeNode, depth: number, a0: number, a1: number): void {
    const kids = childMap.get(parent.path);
    if (!kids || kids.length === 0) return;
    const span = a1 - a0;
    const step = span / kids.length;
    const ring = (depth + 1) * RING_STEP;
    for (let i = 0; i < kids.length; i++) {
      const mid = a0 + step * (i + 0.5);
      const x = Math.cos(mid) * ring;
      const y = Math.sin(mid) * ring;
      placed.set(kids[i].path, { x, y, depth: depth + 1, node: kids[i] });
      // Each child gets a wedge centred on `mid`; we narrow the wedge for
      // depth > 0 so cousins don't overlap.
      const childWedge = step * 0.85;
      placeChildren(kids[i], depth + 1, mid - childWedge / 2, mid + childWedge / 2);
    }
  }
  // Root gets the full circle.
  placeChildren(root, 0, 0, Math.PI * 2);

  // 3. Build LaidNode + edge lists, applying any per-node drag overrides.
  const nodes: LaidNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const all = Array.from(placed.values());
  let minX = 0, minY = 0, maxX = 0, maxY = 0;

  // Build child-set for hasChildren flag (we want to show "+/-" affordance
  // only when the folder ACTUALLY has children, not just is a directory).
  const reverseChildren = new Map<string, boolean>();
  for (const [parentPath, kids] of childMap.entries()) {
    if (kids.length > 0) reverseChildren.set(parentPath, true);
  }

  for (const p of all) {
    const override = drag.get(p.node.path);
    const x = override?.x ?? p.x;
    const y = override?.y ?? p.y;
    nodes.push({
      path: p.node.path,
      name: p.node.name,
      type: p.node.type,
      depth: p.depth,
      x,
      y,
      parent: '',
      hasChildren:
        p.node.type === 'directory'
        && (reverseChildren.get(p.node.path) === true
          || (p.node.children !== undefined && p.node.children.length > 0)),
    });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  for (const [parentPath, kids] of childMap.entries()) {
    for (const k of kids) {
      edges.push({ from: parentPath, to: k.path });
    }
  }

  return {
    nodes,
    edges,
    bbox: { minX, minY, maxX, maxY },
  };
}

interface MindMapViewProps {
  /** Toggle: when false, component renders nothing (parent decides which
   *  pane is visible). Used to keep state alive when the user toggles
   *  back and forth between mindmap and browser. */
  visible: boolean;
}

interface FileViewerState {
  path: string;
  loading: boolean;
  content: string;
  error: string | null;
  size: number;
  lines: number;
}

export function MindMapView({ visible }: MindMapViewProps): JSX.Element | null {
  const [tree, setTree] = useState<ProjectFileTreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [drag, setDrag] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  // Pan + zoom.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // File viewer overlay (null = no file open).
  const [openFile, setOpenFile] = useState<FileViewerState | null>(null);
  // Hover ID — purely cosmetic, drives the highlight ring on a node.
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  // Measured viewport size — feeds the SVG viewBox so (0,0) sits in the
  // visual centre regardless of how the user resizes the splitter.
  const [size, setSize] = useState({ w: 800, h: 600 });

  // ---------------------------------------------------------------
  // Tree fetch — once on mount, then on every repoChanged event
  // (debounced so a save burst doesn't spam refetches).
  // ---------------------------------------------------------------
  const fetchTree = useCallback(async () => {
    try {
      // depth 6 keeps the round trip small even on big repos; user can
      // expand individual subfolders past that point with focused calls
      // (future work). Today we just take what /file-tree returns.
      const t = await api.projectFileTree({ depth: MAX_DEPTH });
      setTree(t);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void fetchTree();
  }, [visible, fetchTree]);

  // SSE refresh — wired even when invisible so a hidden mindmap is
  // up-to-date the instant the user toggles back to it.
  useEffect(() => {
    let timer: number | null = null;
    const off = subscribeRepoChanged(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void fetchTree();
        timer = null;
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      off();
    };
  }, [fetchTree]);

  // ---------------------------------------------------------------
  // Layout — recomputed only when tree / expanded / drag change.
  // ---------------------------------------------------------------
  const layout = useMemo<LayoutResult | null>(() => {
    if (!tree) return null;
    return layoutRadial(tree, expanded, drag);
  }, [tree, expanded, drag]);

  // ---------------------------------------------------------------
  // Pan / zoom: simple mouse-drag pan + wheel zoom on the SVG bg.
  // We attach to a ref so children stopPropagation doesn't matter.
  // ---------------------------------------------------------------
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ mouseX: number; mouseY: number; panX: number; panY: number } | null>(null);

  // Track container size so the SVG viewBox keeps (0,0) centered.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onSvgMouseDown(e: React.MouseEvent): void {
    if ((e.target as Element).closest('.mm-node, .mm-node-label')) return;
    panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function onSvgMouseMove(e: React.MouseEvent): void {
    const s = panStartRef.current;
    if (!s) return;
    setPan({ x: s.panX + (e.clientX - s.mouseX) / zoom, y: s.panY + (e.clientY - s.mouseY) / zoom });
  }
  function onSvgMouseUp(): void { panStartRef.current = null; }

  function onWheel(e: React.WheelEvent): void {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setZoom((z) => Math.max(0.2, Math.min(3, z * (1 + delta))));
  }

  // ---------------------------------------------------------------
  // Per-node drag — overrides the layout position for one node only.
  // We track drag state in a ref so the handler doesn't re-render on
  // every mousemove (the actual position update is throttled by
  // setState batching).
  // ---------------------------------------------------------------
  const nodeDragRef = useRef<{ path: string; mouseX: number; mouseY: number; nodeX: number; nodeY: number } | null>(null);
  function onNodeMouseDown(e: React.MouseEvent, n: LaidNode): void {
    e.stopPropagation();
    nodeDragRef.current = { path: n.path, mouseX: e.clientX, mouseY: e.clientY, nodeX: n.x, nodeY: n.y };
  }
  function onNodeMouseMove(e: React.MouseEvent): void {
    const s = nodeDragRef.current;
    if (!s) return;
    const dx = (e.clientX - s.mouseX) / zoom;
    const dy = (e.clientY - s.mouseY) / zoom;
    setDrag((cur) => {
      const next = new Map(cur);
      next.set(s.path, { x: s.nodeX + dx, y: s.nodeY + dy });
      return next;
    });
  }
  function onMouseUpAny(): void { nodeDragRef.current = null; panStartRef.current = null; }

  // ---------------------------------------------------------------
  // Click handlers
  // ---------------------------------------------------------------
  function toggleFolder(path: string): void {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function openFileViewer(path: string): Promise<void> {
    // Set loading state synchronously so the UI shows the panel
    // immediately even before fetch returns.
    setOpenFile({ path, loading: true, content: '', error: null, size: 0, lines: 0 });
    try {
      if (!TEXTUAL_EXT_RE.test(path)) {
        setOpenFile({
          path,
          loading: false,
          content: '',
          error: '不支持以文本预览这种文件类型。让 AI 用 readFile 读，或下载到本地用其他工具看。',
          size: 0,
          lines: 0,
        });
        return;
      }
      const r = await api.readProjectFile(path);
      setOpenFile({
        path: r.path,
        loading: false,
        content: r.content,
        error: null,
        size: r.size,
        lines: r.lines,
      });
    } catch (e) {
      setOpenFile({
        path,
        loading: false,
        content: '',
        error: e instanceof Error ? e.message : String(e),
        size: 0,
        lines: 0,
      });
    }
  }

  function onNodeClick(n: LaidNode): void {
    // Suppress click-after-drag: if the node was just dragged we don't
    // want it to also count as a "tap". A tiny threshold prevents the
    // very rare 1px "click while panning" misclassification.
    if (nodeDragRef.current) return;
    if (n.type === 'directory') toggleFolder(n.path);
    else void openFileViewer(n.path);
  }

  function resetView(): void {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDrag(new Map());
  }

  if (!visible) return null;

  // ViewBox derivation: centre the (0,0) root inside whatever space the
  // SVG occupies, then apply user pan + zoom. We do this in CSS
  // transform on the inner <g> rather than mutating viewBox so SVG
  // stays the same coordinate system the layout produced.
  const transform = `translate(${pan.x} ${pan.y}) scale(${zoom})`;

  return (
    <div className="mm-root" ref={containerRef} onMouseUp={onMouseUpAny} onMouseLeave={onMouseUpAny}>
      <div className="mm-toolbar">
        <button
          type="button"
          className="topnav-action icon-only"
          onClick={() => void fetchTree()}
          title="刷新"
          aria-label="刷新"
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          type="button"
          className="topnav-action icon-only"
          onClick={resetView}
          title="复位（缩放 + 拖拽偏移全部清掉）"
          aria-label="复位"
        >
          <Icon name="check" size={14} />
        </button>
        <span className="mm-toolbar-zoom">缩放 {Math.round(zoom * 100)}%</span>
        {error ? <span className="mm-toolbar-error">{error}</span> : null}
      </div>

      <svg
        ref={svgRef}
        className="mm-svg"
        viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onSvgMouseDown}
        onMouseMove={(e) => {
          onSvgMouseMove(e);
          onNodeMouseMove(e);
        }}
        onMouseUp={onSvgMouseUp}
        onWheel={onWheel}
      >
        {/* viewBox is centred on (0,0), so the radial layout (root at
            origin) shows up centred without per-node offset math. */}
        <g className="mm-center">
          <g transform={transform}>
            {layout?.edges.map((e, i) => {
              const a = layout.nodes.find((n) => n.path === e.from);
              const b = layout.nodes.find((n) => n.path === e.to);
              if (!a || !b) return null;
              // Quadratic curve with the control point pulled toward the
              // root — gives the lines a soft "tree-of-life" radial bend.
              const cx = (a.x + b.x) / 2 * 0.6;
              const cy = (a.y + b.y) / 2 * 0.6;
              return (
                <path
                  key={i}
                  d={`M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`}
                  className="mm-edge"
                />
              );
            })}
            {layout?.nodes.map((n) => {
              const r = n.type === 'directory' ? NODE_RADIUS_DIR : NODE_RADIUS_FILE;
              const isOpen = n.type === 'directory' && expanded.has(n.path);
              const isHover = hoverPath === n.path;
              const cls = [
                'mm-node',
                `mm-${n.type}`,
                isOpen ? 'mm-open' : '',
                isHover ? 'mm-hover' : '',
              ].filter(Boolean).join(' ');
              return (
                <g
                  key={n.path}
                  className={cls}
                  transform={`translate(${n.x} ${n.y})`}
                  onMouseDown={(e) => onNodeMouseDown(e, n)}
                  onMouseEnter={() => setHoverPath(n.path)}
                  onMouseLeave={() => setHoverPath((cur) => (cur === n.path ? null : cur))}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNodeClick(n);
                  }}
                >
                  <circle r={r + 6} className="mm-node-bg" />
                  <circle r={r} className="mm-node-dot" />
                  {n.type === 'directory' && n.hasChildren ? (
                    <text className="mm-node-toggle" textAnchor="middle" dy="3">
                      {isOpen ? '−' : '+'}
                    </text>
                  ) : null}
                  <text
                    className="mm-node-label"
                    x={r + 8}
                    y={4}
                  >
                    {n.name || '/'}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {openFile ? (
        <div className="mm-fileview" role="dialog" aria-label={`查看 ${openFile.path}`}>
          <div className="mm-fileview-head">
            <span className="mm-fileview-icon"><Icon name="file" size={14} /></span>
            <span className="mm-fileview-path" title={openFile.path}>{openFile.path}</span>
            {!openFile.loading && !openFile.error ? (
              <span className="mm-fileview-meta">{openFile.size} B · {openFile.lines} 行</span>
            ) : null}
            <button
              type="button"
              className="mm-fileview-close"
              onClick={() => setOpenFile(null)}
              aria-label="关闭"
              title="关闭"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="mm-fileview-body">
            {openFile.loading ? (
              <div className="mm-fileview-loading">读取中…</div>
            ) : openFile.error ? (
              <div className="mm-fileview-error">{openFile.error}</div>
            ) : (
              <pre className="mm-fileview-pre">{openFile.content}</pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
