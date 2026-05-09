import { useCallback, useEffect, useState } from 'react';
import { TopNav } from '../TopNav';
import { EmbeddedBrowser } from './EmbeddedBrowser';
import { MindMapView } from './MindMapView';
import { AIAgentPanel } from './AIAgentPanel';
import { SkillsPanel } from '../SkillsPanel';
import { Icon } from '../Icon';
import { useSplitter } from '../Splitter';
import { api } from '../../api';
import type { Skill } from '@shared/types';
import { BUILTIN_SKILLS } from '../../skills/registry';

// =============================================================================
// DebugLayout
//
//   ┌───────────────────────────── topnav ─────────────────────────────┐
//   │ tabs … [bug/branch toggle] [theme] [refresh]                    │
//   ├──────────────────────────────────────────────╥──────────────────┤
//   │ [URL ......................] [↗] [⟲]         ║                  │
//   │                                              ║  AI Agent  ⚙     │
//   │            <iframe project preview>          ║                  │
//   │                                              ║  chat:           │
//   │                                              ║   user msg …     │
//   │                                              ║   assistant …    │
//   │                                              ║                  │
//   │                                              ║  [textarea] →    │
//   ╚══════════════════════════════════════════════╩══════════════════╝
//                                                  ↑ draggable splitter
//
// Just two panes with a draggable splitter between them. The browser is for
// previewing the user's project; the AI panel is for chatting with file
// uploads. There is no automatic log capture — to inspect a page's console,
// open it in a real tab and use the browser's DevTools the normal way.
// =============================================================================

const URL_STORAGE = 'gittttt:debug_url';
const VIEW_STORAGE = 'gittttt:debug_left_view';
// One-time cleanup of legacy persisted state from earlier debug-mode iterations.
// Safe to remove a few releases from now once everyone has reloaded once.
const LEGACY_KEYS = ['gittttt:debug_recording'];

type LeftView = 'browser' | 'mindmap';

function readView(): LeftView {
  try {
    const v = localStorage.getItem(VIEW_STORAGE);
    return v === 'mindmap' ? 'mindmap' : 'browser';
  } catch {
    return 'browser';
  }
}

function readUrl(): string {
  try {
    return localStorage.getItem(URL_STORAGE) || 'http://localhost:3000';
  } catch {
    return 'http://localhost:3000';
  }
}

export function DebugLayout(): JSX.Element {
  const [url, setUrl] = useState<string>(() => readUrl());
  const [skills, setSkills] = useState<Skill[]>(BUILTIN_SKILLS);
  const [showSkills, setShowSkills] = useState(false);
  // Left-pane view: embedded browser (default) vs. radial mind-map of the
  // project file tree. We KEEP BOTH MOUNTED and just hide the inactive
  // one — that way the iframe doesn't reload on every toggle and the
  // mind map keeps its zoom/pan/expanded state when the user comes back.
  const [leftView, setLeftView] = useState<LeftView>(() => readView());
  function changeView(v: LeftView): void {
    setLeftView(v);
    try { localStorage.setItem(VIEW_STORAGE, v); } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    } catch { /* ignore */ }
  }, []);

  // Right-pane width is user-resizable. Default ~360px (matches the old
  // hard-coded width); persisted across sessions.
  const { size: rightWidth, Splitter } = useSplitter({
    storageKey: 'gittttt:dbg-right-width',
    defaultSize: 360,
    minSize: 280,
    maxSize: 720,
    direction: 'vertical',
    target: 'b',
  });

  useEffect(() => {
    let cancelled = false;
    void api.getSkills()
      .then((r) => {
        if (!cancelled && Array.isArray(r.skills)) setSkills(r.skills);
      })
      .catch(() => {
        /* keep optimistic builtins */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSkills = useCallback((next: Skill[]) => {
    setSkills(next);
    void api.saveSkills(next)
      .then((r) => {
        if (Array.isArray(r.skills)) setSkills(r.skills);
      })
      .catch(() => {
        /* ignore — UI keeps the user's intent */
      });
  }, []);

  function onUrlChange(next: string): void {
    setUrl(next);
    try {
      localStorage.setItem(URL_STORAGE, next);
    } catch {
      /* ignore */
    }
  }

  // Inline grid template — feeds the user's drag-resized right-column width
  // into the layout each render. The 6px middle column is the splitter cell.
  const mainStyle: React.CSSProperties = {
    gridTemplateColumns: `1fr 6px ${rightWidth}px`,
  };

  return (
    <div className="dbg-app">
      <div className="dbg-topnav">
        <TopNav />
      </div>
      <div className="dbg-main" style={mainStyle}>
        <div className="dbg-left">
          <div className="dbg-left-tabs" role="tablist" aria-label="左侧视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={leftView === 'browser'}
              className={`dbg-left-tab${leftView === 'browser' ? ' active' : ''}`}
              onClick={() => changeView('browser')}
            >
              <Icon name="globe" size={13} /> 浏览器
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leftView === 'mindmap'}
              className={`dbg-left-tab${leftView === 'mindmap' ? ' active' : ''}`}
              onClick={() => changeView('mindmap')}
            >
              <Icon name="branch" size={13} /> 思维导图
            </button>
          </div>
          <div className="dbg-left-body">
            {/* Both panes mounted; CSS hides the inactive one. Keeps
                iframe + mind-map state alive across toggles, and AI
                tool calls (running on the server) are unaffected. */}
            <div className={`dbg-left-pane${leftView === 'browser' ? '' : ' hidden'}`}>
              <EmbeddedBrowser initialUrl={url} onUrlChange={onUrlChange} />
            </div>
            <div className={`dbg-left-pane${leftView === 'mindmap' ? '' : ' hidden'}`}>
              <MindMapView visible={leftView === 'mindmap'} />
            </div>
          </div>
        </div>
        <Splitter />
        <div className="dbg-right">
          <AIAgentPanel
            skills={skills}
            onOpenSkills={() => setShowSkills(true)}
          />
          {showSkills ? (
            <SkillsPanel
              skills={skills}
              onChange={updateSkills}
              onClose={() => setShowSkills(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
