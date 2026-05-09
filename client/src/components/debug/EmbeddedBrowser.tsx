import { useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';

// =============================================================================
// detectSelfLoop — refuses to render the iframe when its URL points at the
// gittttt app itself (or its sibling backend), to avoid the recursive
// self-embedding the user hits when they accidentally leave the URL set to
// `http://localhost:5173/` (Vite dev) or `http://localhost:3001/` (server).
//
// Match logic:
//   - Same origin as `window.location` -> definitely a loop.
//   - Same hostname + port equal to our origin's port -> covers the case
//     where the user typed `127.0.0.1` while the page is on `localhost`
//     (the browser treats those as different origins, but it's still us).
//   - Special-case our known sibling backend port via the "loopback host"
//     test, so localhost:3001 / 127.0.0.1:3001 are flagged too.
// =============================================================================
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
function detectSelfLoop(rawUrl: string): { loop: boolean; reason: string } {
  if (!rawUrl) return { loop: false, reason: '' };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { loop: false, reason: '' };
  }
  if (typeof window === 'undefined') return { loop: false, reason: '' };
  const here = window.location;
  if (parsed.origin === here.origin) {
    return { loop: true, reason: '当前 URL 指向 gittttt 自己（同源），加载它会无限递归。' };
  }
  if (
    LOOPBACK_HOSTS.has(parsed.hostname)
    && LOOPBACK_HOSTS.has(here.hostname)
    && parsed.port === here.port
  ) {
    return { loop: true, reason: '当前 URL 指向 gittttt 自己（仅主机名拼写不同），加载它会无限递归。' };
  }
  if (LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port === '3001') {
    return { loop: true, reason: '这是 gittttt 的后端 API 端口（3001），不是要调试的页面。' };
  }
  return { loop: false, reason: '' };
}

// =============================================================================
// EmbeddedBrowser
//
// Drops an iframe of the user's project into the debug surface, plus a tiny
// chrome-style URL bar so they can navigate without leaving gittttt. That's
// it — no log capture, no extension wiring. If the user wants to inspect
// console output for a page, they open DevTools (F12) on it normally.
// =============================================================================

interface Props {
  initialUrl: string;
  onUrlChange?(url: string): void;
}

export function EmbeddedBrowser({ initialUrl, onUrlChange }: Props): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [urlBar, setUrlBar] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState(initialUrl);

  // If the user points the iframe at gittttt's own origin we end up
  // rendering the entire app inside itself, which (a) looks like garbage
  // because everything's at iframe-pixel-width, (b) eats memory by
  // recursing every render, and (c) is never what the user actually
  // wants — they're trying to load *their* dev server. Show a friendly
  // empty state instead of letting the iframe load.
  const loopState = useMemo(() => detectSelfLoop(activeUrl), [activeUrl]);

  function commitUrl(): void {
    let next = urlBar.trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) next = `http://${next}`;
    setActiveUrl(next);
    setUrlBar(next);
    onUrlChange?.(next);
  }

  return (
    <div className="dbg-browser">
      <div className="dbg-browser-bar">
        <input
          className="dbg-browser-url"
          value={urlBar}
          onChange={(e) => setUrlBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitUrl();
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
        />
        <button
          type="button"
          className="dbg-icon-btn"
          title="在新窗口打开"
          aria-label="在新窗口打开"
          onClick={() => window.open(activeUrl, '_blank', 'noopener')}
        >
          <Icon name="external" size={14} />
        </button>
        <button
          type="button"
          className="dbg-icon-btn"
          title="刷新"
          aria-label="刷新"
          onClick={() => {
            const f = iframeRef.current;
            if (!f) return;
            // eslint-disable-next-line no-self-assign
            f.src = f.src;
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {loopState.loop ? (
        <div className="dbg-browser-empty">
          <div className="dbg-browser-empty-icon">
            <Icon name="globe" size={28} />
          </div>
          <div className="dbg-browser-empty-title">填一个你想调试的网址</div>
          <div className="dbg-browser-empty-msg">{loopState.reason}</div>
          <div className="dbg-browser-empty-hint">
            在上方地址栏输入 <strong>你的项目</strong> URL（比如
            <code> http://localhost:3000</code>、
            <code> http://localhost:8080</code> 或任意线上地址），按回车加载。
          </div>
          <div className="dbg-browser-empty-shortcuts">
            <button
              type="button"
              className="dbg-text-btn"
              onClick={() => {
                setUrlBar('http://localhost:3000');
                setActiveUrl('http://localhost:3000');
                onUrlChange?.('http://localhost:3000');
              }}
            >
              试试 localhost:3000
            </button>
            <button
              type="button"
              className="dbg-text-btn"
              onClick={() => {
                setUrlBar('http://localhost:8080');
                setActiveUrl('http://localhost:8080');
                onUrlChange?.('http://localhost:8080');
              }}
            >
              localhost:8080
            </button>
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          className="dbg-browser-frame"
          src={activeUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </div>
  );
}
