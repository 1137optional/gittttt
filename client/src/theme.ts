// Light SaaS design tokens. Mirrors values in global.css; the canvas
// renderer reads these directly because it can't read CSS variables cheaply.

export const theme = {
  bg: {
    page: '#F5F5F7',          // page background
    base: '#FFFFFF',          // surfaces / cards
    panel: '#FFFFFF',
    elevated: '#FFFFFF',
    input: '#FFFFFF',
    hover: 'rgba(55, 138, 221, 0.06)',
    active: 'rgba(55, 138, 221, 0.10)',
    softGray: '#F5F5F5',      // statistics card / inactive chip
    border: '#ECEEF2',        // very light divider
    borderStrong: '#D9DDE3',  // visible card border
  },
  fg: {
    primary: '#1A1A1A',       // headings / strong values
    body: '#333333',          // body text
    secondary: '#666666',     // secondary info
    muted: '#999999',         // metadata
    faint: '#B5B7BD',         // disabled / placeholders
  },
  accent: {
    primary: '#378ADD',       // brand blue
    primarySoft: '#5AA0E5',
    primaryDeep: '#1F6FBF',
    primaryTint: '#E8F1FB',   // subtle brand wash for active branch row
    success: '#1D9E75',       // teal
    warning: '#BA7517',       // amber
    error: '#D85A30',         // coral / danger
  },
  // Branch palette — assigned by column. Column 0 (usually main/HEAD lane)
  // gets the brand blue, then coral / amber / teal, then a few neighbors.
  branchPalette: [
    '#378ADD', // blue   — main / primary lane
    '#D85A30', // coral  — feature
    '#BA7517', // amber  — release / dashboard
    '#1D9E75', // teal   — hotfix / fix
    '#7A5AF8', // violet
    '#0EA5E9', // sky
    '#E11D48', // rose
    '#16A34A', // green
  ],
  graph: {
    // Compact metrics (matches the previous density). The size redesign
    // is in the rendering style — white halos, dashed HEAD ring, line
    // kinds — not in the spacing.
    rowHeight: 38,
    columnWidth: 22,
    leftPadding: 28,
    topPadding: 22,
    nodeRadius: 6,            // 12px diameter
    headRadius: 6,
    selectedRadius: 7,
    nodeBorder: 1.5,          // white halo around every node
    headHaloRadius: 10,       // outer dashed ring radius for HEAD
    labelOffsetX: 12,         // pixels from node centre to first label
    metaWidth: 168,
    metaGutter: 24,
    lineWidth: 1.6,
    lineWidthCurrent: 2,
    fadeMaxDays: 365,
    fadeMinOpacity: 0.7,
  },
  font: {
    ui:
      '"Inter", "Geist", ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
    code:
      '"JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace',
  },
} as const;

export type Theme = typeof theme;

// Compute a soft per-commit alpha based on age. Light-theme uses a much
// gentler curve than the previous CRT theme so most history reads as full-color.
export function ageOpacity(timestampMs: number, now = Date.now()): number {
  const days = Math.max(0, (now - timestampMs) / 86400000);
  const t = Math.min(days / theme.graph.fadeMaxDays, 1);
  const fade = Math.pow(t, 0.6);
  return 1 - fade * (1 - theme.graph.fadeMinOpacity);
}

// Initials from author name, max 2 chars uppercased. "Jane Doe" -> "JD".
// Fallback: first two letters of the email or "?".
export function authorInitials(name: string, email = ''): string {
  const cleaned = (name || '').trim();
  if (cleaned) {
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return '?';
}

// Deterministic palette index from a string — used to pick avatar/branch
// colors that stay stable across renders.
export function hashIndex(s: string, mod: number): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

export function avatarColor(email: string): string {
  return theme.branchPalette[hashIndex(email || 'unknown', theme.branchPalette.length)];
}
