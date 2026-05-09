import { useEffect, useRef } from 'react';

export interface MenuItem {
  label?: string;
  danger?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handler(e: MouseEvent): void {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function key(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Clamp to viewport so the menu doesn't escape off-screen.
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - items.length * 32);

  return (
    <div className="ctx-menu" ref={ref} style={{ left, top }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={`sep-${i}`} className="sep" />
        ) : (
          <div
            key={it.label ?? i}
            className={`item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </div>
        ),
      )}
    </div>
  );
}
