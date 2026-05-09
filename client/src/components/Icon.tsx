// Tiny inline-SVG icon set. Inline because the icon set is small and we want
// `currentColor` to inherit from the surrounding button — no extra HTTP fetch,
// no icon font, no peer dependency.
//
// Add new icons by appending to PATHS. Every path is normalised to a 24×24
// viewBox so a single `size` prop scales everything proportionally.

export type IconName =
  | 'refresh'
  | 'sun'
  | 'moon'
  | 'branch'
  | 'cloud'
  | 'plus'
  | 'minus'
  | 'check'
  | 'trash'
  | 'more'
  | 'github'
  | 'search'
  | 'external'
  | 'lock'
  | 'globe';

interface PathSpec {
  d: string;
  /** Render as fill instead of stroke (rare; default is stroke). */
  fill?: boolean;
}

// All 24×24, stroke 1.75 unless overridden. Geometric Heroicons-style.
const PATHS: Record<IconName, PathSpec | PathSpec[]> = {
  refresh: { d: 'M4 4v6h6 M20 20v-6h-6 M4 14a8 8 0 0 0 14 5l2-2 M20 10A8 8 0 0 0 6 5L4 7' },
  sun: [
    { d: 'M12 4v2 M12 18v2 M4 12h2 M18 12h2 M5.6 5.6l1.4 1.4 M17 17l1.4 1.4 M5.6 18.4l1.4-1.4 M17 7l1.4-1.4' },
    { d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  ],
  moon: { d: 'M21 13.5A9 9 0 0 1 10.5 3a8 8 0 1 0 10.5 10.5z' },
  branch: { d: 'M6 4v16 M6 14a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V8 M16 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M6 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M6 20a2 2 0 1 1 0 4 2 2 0 0 1 0-4z' },
  cloud: { d: 'M7 18a4 4 0 1 1 0-8 5 5 0 0 1 9.6-1A4 4 0 0 1 18 18z' },
  plus: { d: 'M12 5v14 M5 12h14' },
  minus: { d: 'M5 12h14' },
  check: { d: 'M5 12.5l4.5 4.5L19 7' },
  trash: { d: 'M4 7h16 M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12 M10 11v6 M14 11v6' },
  more: { d: 'M5 12h.01 M12 12h.01 M19 12h.01' },
  github: {
    fill: true,
    d: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z',
  },
  search: { d: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z M20 20l-3.5-3.5' },
  external: { d: 'M14 4h6v6 M20 4l-9 9 M5 8v11h11' },
  lock: { d: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4' },
  globe: { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18' },
};

interface Props {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
  title,
  style,
}: Props): JSX.Element {
  const spec = PATHS[name];
  const list = Array.isArray(spec) ? spec : [spec];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      {list.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ? 'currentColor' : 'none'}
          stroke={p.fill ? 'none' : 'currentColor'}
        />
      ))}
    </svg>
  );
}
