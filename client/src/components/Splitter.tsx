import { useCallback, useEffect, useRef, useState } from 'react';

// =============================================================================
// Splitter — a draggable resizer between two panes.
//
// We deliberately don't ship a SplitPane wrapper; the parent already has its
// own grid / flex layout and we just need to:
//   (a) hold the current pane size in state (persisted to localStorage),
//   (b) render a thin strip the user can grab to drag.
//
// The hook returns the live size + a <Splitter /> element. Rendering order
// in the parent decides which side the strip belongs to (typically: render
// it between the two panes in document order). The parent then plugs the
// size into its grid-template-* / flex-basis / width.
//
// Direction:
//   - 'vertical'   = vertical strip, drag horizontally (resize column widths)
//   - 'horizontal' = horizontal strip, drag vertically (resize row heights)
//
// `target = 'a' | 'b'` controls which pane is the "sized" one (whose pixels
// the hook reports). The other pane is the elastic 1fr.
//
// During a drag we also lock body cursor + disable user-select so dragging
// across the iframe doesn't pop weird text-selection states.
// =============================================================================

export type SplitDirection = 'vertical' | 'horizontal';
export type SplitTarget = 'a' | 'b';

export interface UseSplitterOptions {
  /** localStorage key for size persistence. Omit to skip persistence. */
  storageKey?: string;
  /** Initial size in pixels of the targeted pane. */
  defaultSize: number;
  /** Min size in pixels of the targeted pane. */
  minSize: number;
  /** Max size in pixels of the targeted pane. */
  maxSize: number;
  direction: SplitDirection;
  /** Which side the size refers to. Defaults to 'b' (right / bottom). */
  target?: SplitTarget;
}

export interface SplitterProps {
  /** Extra class merged onto the strip — handy for grid-area placement. */
  className?: string;
}

export interface UseSplitterResult {
  size: number;
  Splitter: (props?: SplitterProps) => JSX.Element;
  setSize: (next: number) => void;
}

function readPersistedSize(storageKey: string | undefined, fallback: number): number {
  if (!storageKey) return fallback;
  try {
    const v = localStorage.getItem(storageKey);
    if (!v) return fallback;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through */
  }
  return fallback;
}

function writePersistedSize(storageKey: string | undefined, size: number): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, String(size));
  } catch {
    /* ignore — quota / privacy mode */
  }
}

export function useSplitter(opts: UseSplitterOptions): UseSplitterResult {
  const { storageKey, defaultSize, minSize, maxSize, direction, target = 'b' } = opts;
  const [size, setSizeState] = useState<number>(() =>
    readPersistedSize(storageKey, defaultSize),
  );

  // Drag state held in refs so the mousemove handler stays a stable ref and
  // doesn't re-bind every render.
  const dragStartCoord = useRef(0);
  const dragStartSize = useRef(0);

  const clamp = useCallback(
    (n: number): number => Math.max(minSize, Math.min(maxSize, n)),
    [minSize, maxSize],
  );

  const setSize = useCallback(
    (next: number) => {
      const c = clamp(next);
      setSizeState(c);
      writePersistedSize(storageKey, c);
    },
    [clamp, storageKey],
  );

  // Re-clamp if min/max constraints change while the user is sitting at an
  // out-of-range value (e.g. window resized smaller than maxSize allowed).
  useEffect(() => {
    const c = clamp(size);
    if (c !== size) setSize(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minSize, maxSize]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragStartCoord.current = direction === 'vertical' ? e.clientX : e.clientY;
      dragStartSize.current = size;

      const cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
      // Lock cursor + selection globally so we don't lose the drag mid-stroke
      // when the cursor passes over the iframe (which eats events otherwise).
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = 'none';

      // Cover the page (incl. iframes) with a transparent shield so iframe
      // mousemove doesn't steal the drag. Pointer-events:auto + cursor on
      // the shield gives the user a continuous resize cursor too.
      const shield = document.createElement('div');
      shield.setAttribute('data-gittttt-resize-shield', '1');
      Object.assign(shield.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '9999',
        cursor,
        background: 'transparent',
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(shield);

      const onMove = (ev: MouseEvent): void => {
        const cur = direction === 'vertical' ? ev.clientX : ev.clientY;
        const delta = cur - dragStartCoord.current;
        // For target = 'b' the right/bottom pane shrinks when the user drags
        // toward the right/bottom -> negative delta increases the pane size.
        const next = target === 'b' ? dragStartSize.current - delta : dragStartSize.current + delta;
        setSize(next);
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        if (shield.parentNode) shield.parentNode.removeChild(shield);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [direction, target, size, setSize],
  );

  const Splitter = useCallback(
    function Splitter(props?: SplitterProps): JSX.Element {
      const cls = `splitter splitter-${direction}${props?.className ? ` ${props.className}` : ''}`;
      return (
        <div
          className={cls}
          onMouseDown={onMouseDown}
          // Double-click to reset to default — handy to recover from a bad drag.
          onDoubleClick={() => setSize(defaultSize)}
          role="separator"
          aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
          aria-label="拖拽调整大小"
          title="拖拽调整大小，双击恢复默认"
        >
          <span className="splitter-handle" aria-hidden="true" />
        </div>
      );
    },
    [direction, onMouseDown, setSize, defaultSize],
  );

  return { size, Splitter, setSize };
}
