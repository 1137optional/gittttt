import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright';
import type {
  BrowserConsoleEntry,
  BrowserContentResult,
  BrowserScreenshotResult,
  BrowserState,
} from '../shared/types.js';

// =============================================================================
// Headless Chromium driver for the AI agent.
//
// SHAPE: one browser process + one context + one page, shared across all
// tool calls. This means cookies / localStorage / sessionStorage survive
// between calls — the AI can log in once and then click around. If you want
// a clean slate, call `close()`.
//
// LIFECYCLE:
//   - Lazy-launched on first call (so a `npm start` with no browser usage
//     never spawns chromium).
//   - 5-minute idle timer; once it fires we close the browser to free RAM.
//     Each new call resets the timer.
//   - On launch failure (chromium not installed via `npx playwright install
//     chromium`) we throw a friendly error pointing at the install command.
//
// CONSOLE / NETWORK CAPTURE:
//   - We hook `page.on('console')` and 'pageerror' to a per-session ring
//     buffer (CONSOLE_BUFFER_LIMIT entries). The AI calls `getConsole()`
//     to read it.
//   - Network capture (request / response status, sizes) is skipped in v1
//     to keep this file small. Add it later by hooking 'request' / 'response'.
//
// We deliberately do NOT do anything fancy with Playwright contexts — one
// page is the ergonomic unit the AI reasons about ("the browser" is one
// browser). Tabs / multi-page can land later if a workflow demands it.
// =============================================================================

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const CONSOLE_BUFFER_LIMIT = 500;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const SCREENSHOT_DIR_REL = ['.gittttt', 'screenshots'];
// Sanity cap on how much rendered text we send back per `getContent`. The AI
// rarely needs the full rendered body of a SaaS dashboard; truncating keeps
// our chat context bounded.
const BROWSER_MAX_TEXT = 80_000;

export class BrowserError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let consoleBuf: BrowserConsoleEntry[] = [];
let lastLoadAt: number = 0;
let idleTimer: NodeJS.Timeout | null = null;
let projectRoot: string | null = null;

function bumpIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log('[gittttt] browser idle 5m, closing chromium');
    closeBrowser().catch(() => { /* swallow */ });
  }, IDLE_CLOSE_MS);
}

function pushConsole(entry: BrowserConsoleEntry): void {
  consoleBuf.push(entry);
  if (consoleBuf.length > CONSOLE_BUFFER_LIMIT) {
    consoleBuf.splice(0, consoleBuf.length - CONSOLE_BUFFER_LIMIT);
  }
}

async function ensureBrowser(): Promise<{ browser: Browser; ctx: BrowserContext; pg: Page }> {
  if (browser && context && page && !page.isClosed()) {
    bumpIdleTimer();
    return { browser, ctx: context, pg: page };
  }

  // Lazy-import — keeps `playwright` out of the require graph for users
  // who never enable the browser skill (a 3MB+ module otherwise).
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new BrowserError(
      500,
      'playwright is not installed. Run: npm install playwright && npx playwright install chromium',
    );
  }

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      // Useful flags for running inside a constrained dev box. They're
      // harmless on macOS too.
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Executable doesn't exist/i.test(msg) || /browserType.launch/i.test(msg)) {
      throw new BrowserError(
        500,
        `chromium binary missing. Run: npx playwright install chromium\n(detail: ${msg})`,
      );
    }
    throw new BrowserError(500, `chromium launch failed: ${msg}`);
  }

  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // Pretend to be a normal Chrome on macOS so most sites don't ban us.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  });
  page = await context.newPage();
  consoleBuf = [];
  page.on('console', (m: ConsoleMessage) => {
    pushConsole({
      level: m.type(),
      text: m.text(),
      time: new Date().toISOString(),
      source: (() => {
        const loc = m.location();
        if (!loc?.url) return undefined;
        return `${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}`;
      })(),
    });
  });
  page.on('pageerror', (err) => {
    pushConsole({
      level: 'error',
      text: `[pageerror] ${err.message}`,
      time: new Date().toISOString(),
    });
  });
  bumpIdleTimer();
  return { browser, ctx: context, pg: page };
}

async function snapshotState(pg: Page): Promise<BrowserState> {
  return {
    url: pg.url(),
    title: await pg.title().catch(() => ''),
    loadedMs: lastLoadAt > 0 ? Date.now() - lastLoadAt : 0,
    alive: !!browser && !pg.isClosed(),
  };
}

export function setProjectRoot(root: string | null): void {
  projectRoot = root;
}

function ensureScreenshotDir(): string {
  if (!projectRoot) {
    throw new BrowserError(409, 'no active project root — open a repo first');
  }
  const dir = join(projectRoot, ...SCREENSHOT_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// -----------------------------------------------------------------------------
// Public actions
// -----------------------------------------------------------------------------

export async function navigate(args: { url?: unknown; waitUntil?: unknown; timeoutMs?: unknown }): Promise<BrowserState> {
  if (typeof args.url !== 'string' || args.url.trim() === '') {
    throw new BrowserError(400, 'navigate requires { url }');
  }
  const url = args.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new BrowserError(400, `navigate only supports http/https URLs (got: ${url})`);
  }
  const timeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? Math.min(60_000, args.timeoutMs)
    : DEFAULT_NAV_TIMEOUT_MS;
  // Default to 'load' which waits for the load event. 'networkidle' is more
  // thorough but hangs forever on long-polling SPAs.
  const waitUntil = (typeof args.waitUntil === 'string'
    && (['load', 'domcontentloaded', 'networkidle', 'commit'] as const)
      .includes(args.waitUntil as 'load')
  ) ? (args.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | 'commit')
    : 'load';

  const { pg } = await ensureBrowser();
  // Reset the per-page console buffer so the AI's `getConsole` after a
  // navigation doesn't return logs from the previous page.
  consoleBuf = [];
  try {
    await pg.goto(url, { waitUntil, timeout });
    lastLoadAt = Date.now();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(502, `navigation failed: ${msg}`);
  }
  return snapshotState(pg);
}

export async function click(args: { selector?: unknown; timeoutMs?: unknown }): Promise<BrowserState> {
  if (typeof args.selector !== 'string' || args.selector.trim() === '') {
    throw new BrowserError(400, 'click requires { selector }');
  }
  const timeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? Math.min(30_000, args.timeoutMs)
    : 10_000;
  const { pg } = await ensureBrowser();
  try {
    await pg.click(args.selector, { timeout });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(404, `click failed for selector "${args.selector}": ${msg}`);
  }
  return snapshotState(pg);
}

export async function type(args: { selector?: unknown; text?: unknown; clear?: unknown; timeoutMs?: unknown }): Promise<BrowserState> {
  if (typeof args.selector !== 'string' || args.selector.trim() === '') {
    throw new BrowserError(400, 'type requires { selector }');
  }
  if (typeof args.text !== 'string') {
    throw new BrowserError(400, 'type requires { text: string }');
  }
  const timeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? Math.min(30_000, args.timeoutMs)
    : 10_000;
  const { pg } = await ensureBrowser();
  try {
    if (args.clear === true) {
      await pg.fill(args.selector, args.text, { timeout });
    } else {
      await pg.type(args.selector, args.text, { timeout });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(404, `type failed for selector "${args.selector}": ${msg}`);
  }
  return snapshotState(pg);
}

export async function screenshot(args: { fullPage?: unknown; selector?: unknown }): Promise<BrowserScreenshotResult> {
  const { pg } = await ensureBrowser();
  const dir = ensureScreenshotDir();
  const name = `shot-${Date.now()}.png`;
  const abs = join(dir, name);
  try {
    if (typeof args.selector === 'string' && args.selector.trim() !== '') {
      const el = pg.locator(args.selector).first();
      await el.screenshot({ path: abs, timeout: 10_000 });
    } else {
      await pg.screenshot({
        path: abs,
        fullPage: args.fullPage === true,
        timeout: 10_000,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(500, `screenshot failed: ${msg}`);
  }
  const bytes = statSync(abs).size;
  // Build a short DOM outline so DeepSeek (text-only) has SOMETHING to
  // reason about even though it can't see the image.
  const domOutline = await buildDomOutline(pg);
  const state = await snapshotState(pg);
  return {
    ...state,
    path: `.gittttt/screenshots/${name}`,
    bytes,
    domOutline,
  };
}

// Pass the outline script as a string literal rather than a real function.
// Why: tsx / esbuild rewrites named arrow / helper functions to inject a
// `__name` runtime helper for stack-trace labels. When Playwright stringifies
// our function body and runs it in the browser, those `__name(…)` calls
// reference an identifier the browser doesn't have, blowing up evaluate.
// String-form evaluate is opaque to the compiler — it's shipped verbatim.
const DOM_OUTLINE_SCRIPT = `(() => {
  const out = [];
  const push = (s) => { if (s && s.trim()) out.push(s.trim()); };
  const isVisible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  push('# ' + (document.title || '(untitled)'));
  push('URL: ' + location.href);
  push('');
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).filter(isVisible).slice(0, 20);
  if (headings.length) {
    push('## Headings');
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      push('- ' + h.tagName.toLowerCase() + ': ' + ((h.textContent || '').slice(0, 200).trim()));
    }
    push('');
  }
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(isVisible).slice(0, 30);
  if (buttons.length) {
    push('## Clickable');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const text = (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (!text) continue;
      const aria = b.getAttribute('aria-label') || '';
      const tag = b.tagName.toLowerCase();
      const href = b.getAttribute('href') || '';
      push('- <' + tag + (href ? ' href="' + href.slice(0, 80) + '"' : '') + '> "' + text + '"' + (aria ? ' aria="' + aria + '"' : ''));
    }
    push('');
  }
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(isVisible).slice(0, 20);
  if (inputs.length) {
    push('## Inputs');
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const name = el.getAttribute('name') || '';
      const id = el.id || '';
      const placeholder = el.getAttribute('placeholder') || '';
      push('- <' + tag + ' type="' + type + '" name="' + name + '" id="' + id + '" placeholder="' + placeholder + '">');
    }
    push('');
  }
  const paragraphs = Array.from(document.querySelectorAll('main p, article p, body > p')).filter(isVisible).slice(0, 5);
  if (paragraphs.length) {
    push('## First paragraphs');
    for (let i = 0; i < paragraphs.length; i++) {
      push((paragraphs[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300));
    }
  }
  return out.join('\\n');
})()`;

async function buildDomOutline(pg: Page): Promise<string> {
  try {
    const outline = (await pg.evaluate(DOM_OUTLINE_SCRIPT)) as string;
    return outline.length > 3000 ? `${outline.slice(0, 3000)}\n…[outline truncated]` : outline;
  } catch (e) {
    return `(could not build DOM outline: ${e instanceof Error ? e.message : 'error'})`;
  }
}

export async function getConsole(_args: Record<string, unknown>): Promise<{ entries: BrowserConsoleEntry[]; total: number }> {
  await ensureBrowser();
  // Return a copy so the caller can't mutate our buffer.
  return { entries: [...consoleBuf], total: consoleBuf.length };
}

export async function getContent(args: { selector?: unknown }): Promise<BrowserContentResult> {
  const { pg } = await ensureBrowser();
  let text = '';
  try {
    if (typeof args.selector === 'string' && args.selector.trim() !== '') {
      text = await pg.locator(args.selector).first().innerText({ timeout: 10_000 });
    } else {
      text = await pg.locator('body').innerText({ timeout: 10_000 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(404, `getContent failed: ${msg}`);
  }
  const truncated = text.length > BROWSER_MAX_TEXT;
  if (truncated) text = `${text.slice(0, BROWSER_MAX_TEXT)}\n…[truncated]`;
  const state = await snapshotState(pg);
  return { ...state, text, truncated: truncated || undefined };
}

export async function closeBrowser(): Promise<BrowserState> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const lastUrl = page && !page.isClosed() ? page.url() : '';
  try {
    if (page && !page.isClosed()) await page.close();
  } catch { /* swallow */ }
  try {
    if (context) await context.close();
  } catch { /* swallow */ }
  try {
    if (browser) await browser.close();
  } catch { /* swallow */ }
  page = null;
  context = null;
  browser = null;
  consoleBuf = [];
  lastLoadAt = 0;
  return { url: lastUrl, title: '', loadedMs: 0, alive: false };
}

export function isAlive(): boolean {
  return !!browser && !!page && !page.isClosed();
}
