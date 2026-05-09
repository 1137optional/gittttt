import { useMemo } from 'react';

interface ParsedLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

// Parse a single-file unified diff (from `git show ... -- path`) into rows
// suitable for direct DOM rendering.
function parseUnified(diff: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo, text: raw.slice(1) });
      newNo++;
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', oldNo, newNo: null, text: raw.slice(1) });
      oldNo++;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" - render as context but with both numbers null
      out.push({ kind: 'context', oldNo: null, newNo: null, text: raw });
    } else {
      out.push({ kind: 'context', oldNo, newNo, text: raw.replace(/^ /, '') });
      oldNo++;
      newNo++;
    }
  }
  return out;
}

export function DiffViewer({ diff }: { diff: string }): JSX.Element {
  const lines = useMemo(() => parseUnified(diff), [diff]);
  if (lines.length === 0) {
    return (
      <div className="diff-viewer">
        <div className="diff-line context">
          <div className="gutter" />
          <div className="gutter" />
          <div className="text">(binary or empty diff)</div>
        </div>
      </div>
    );
  }
  return (
    <div className="diff-viewer">
      {lines.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>
          <div className="gutter">{l.oldNo ?? ''}</div>
          <div className="gutter">{l.newNo ?? ''}</div>
          <div className="text">{l.text || ' '}</div>
        </div>
      ))}
    </div>
  );
}
