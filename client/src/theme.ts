// Design tokens for the "cold industrial / low-fi terminal" aesthetic.
// CSS variables in global.css mirror these values so DOM and canvas agree.

export const theme = {
  bg: {
    base: '#0B1020',     // deepest navy (CRT off-state)
    panel: '#0F172A',    // sidebar / pane fill
    elevated: '#111827', // floating menus / modals
    input: '#0E1A2F',
    hover: 'rgba(56,189,248,0.06)',
    active: 'rgba(56,189,248,0.12)',
    border: 'rgba(148,163,184,0.10)',
    borderStrong: 'rgba(148,163,184,0.18)',
    rail: '#38BDF8',     // 2px cyan rail used for "active" indicators
  },
  fg: {
    primary: '#E2E8F0',
    secondary: '#94A3B8',
    muted: '#64748B',
    dim: '#475569',
  },
  accent: {
    primary: '#38BDF8',  // cold cyan / sky-400
    primarySoft: '#67E8F9',
    primaryDeep: '#22D3EE',
    success: '#4ADE80',  // pale green / green-400 — HEAD, success, active
    warning: '#F59E0B',  // amber-500
    error: '#EF4444',    // red-500
  },
  // Restrained branch palette — cyan, sky, green, amber family. No rainbow.
  branchPalette: [
    '#67E8F9', // cyan-300
    '#38BDF8', // sky-400
    '#4ADE80', // green-400
    '#F59E0B', // amber-500
    '#22D3EE', // teal/cyan-500
    '#60A5FA', // blue-400
    '#A3E635', // lime-400
    '#FB923C', // orange-400
  ],
  graph: {
    rowHeight: 28,
    columnWidth: 18,
    leftPadding: 22,
    topPadding: 16,
    nodeRadius: 4,
    headRadius: 6,
    selectedRadius: 6,
    lineWidth: 1.5,
    lineWidthCurrent: 2,
    glowBlur: 10,
    fadeMaxDays: 180,    // older commits fade toward `fadeMinOpacity` over this window
    fadeMinOpacity: 0.42,
  },
  font: {
    ui:
      '"Inter", "Geist", ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
    code:
      '"JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace',
  },
} as const;

export type Theme = typeof theme;

// Compute an opacity multiplier for a commit based on its age. Newer commits
// stay vivid; older ones fade toward the floor. The curve is sub-linear so the
// recent past stays readable.
export function ageOpacity(timestampMs: number, now = Date.now()): number {
  const days = Math.max(0, (now - timestampMs) / 86400000);
  const t = Math.min(days / theme.graph.fadeMaxDays, 1);
  // Ease-out: opacity = 1 - t^0.7 * (1 - floor)
  const fade = Math.pow(t, 0.7);
  return 1 - fade * (1 - theme.graph.fadeMinOpacity);
}
