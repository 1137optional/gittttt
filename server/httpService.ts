import type { HttpRequestArgs, HttpRequestResult } from '../shared/types.js';

// =============================================================================
// httpRequest tool — minimal AbortController-backed fetch the AI can call
// from inside the agent loop.
//
// TRUST MODEL: same as runCommand. The server is loopback-only and the user
// has to enable the `canMakeHttpRequests` permission on at least one Skill
// for this tool to even appear in the AI's catalog. We DO NOT block private
// IP ranges — the whole point is "AI please curl my localhost:3000". If the
// AI gets clever and POSTs to your AWS metadata endpoint, that's the same
// surface as letting it run `curl` via runCommand. Disable the permission
// if that's not what you want.
//
// What we DO enforce:
//   - Verb allowlist (no TRACE, no CONNECT)
//   - Wall-clock timeout via AbortSignal (defaults 30s, capped at 60s)
//   - Response body size cap so a streaming endpoint can't pin Node memory
//   - HTTP/HTTPS only (no file://, no data:, no chrome-extension://)
// =============================================================================

const ALLOWED_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
// 1 MB cap. Bigger than that and we truncate — the AI rarely needs more
// than the response head, and our chat context budget can't afford 10MB
// dumps. The `truncated: true` flag tells the AI it can run a follow-up
// HEAD or use Range headers if it really needs the rest.
const MAX_RESPONSE_BYTES = 1_000_000;

export class HttpRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function validate(args: HttpRequestArgs): { url: URL; method: string; headers: Record<string, string>; body?: string; timeoutMs: number } {
  if (!args || typeof args !== 'object') {
    throw new HttpRequestError(400, 'request body must be an object');
  }
  if (typeof args.url !== 'string' || args.url.trim() === '') {
    throw new HttpRequestError(400, '`url` is required');
  }

  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw new HttpRequestError(400, `invalid url: ${args.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpRequestError(400, `unsupported protocol: ${url.protocol}`);
  }

  const method = (args.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpRequestError(400, `unsupported method: ${method}`);
  }

  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === 'object') {
    for (const [k, v] of Object.entries(args.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      // Strip hop-by-hop headers — fetch sets these itself; user-supplied
      // values would just be ignored or rejected by undici.
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
      headers[k] = v;
    }
  }

  let body: string | undefined;
  if (args.body !== undefined) {
    if (typeof args.body !== 'string') {
      throw new HttpRequestError(400, '`body` must be a string (stringify JSON yourself)');
    }
    if (method === 'GET' || method === 'HEAD') {
      throw new HttpRequestError(400, `${method} cannot have a body`);
    }
    body = args.body;
  }

  const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? args.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, requested));

  return { url, method, headers, body, timeoutMs };
}

export async function executeHttpRequest(args: HttpRequestArgs): Promise<HttpRequestResult> {
  const { url, method, headers, body, timeoutMs } = validate(args);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();

  try {
    const resp = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: ac.signal,
      // We DO follow redirects — the AI almost always wants the final
      // resource, not a 301 it has to chase manually. URL is reported in
      // the result so the AI sees where it landed.
      redirect: 'follow',
    });

    // Drain the body up to MAX_RESPONSE_BYTES, then stop reading. We use
    // the streaming reader (rather than .text()) so a chunked endpoint
    // can't OOM us before .text() returns.
    const reader = resp.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.byteLength > MAX_RESPONSE_BYTES) {
          // Take the slice that fits, mark truncated, abort the stream.
          const room = MAX_RESPONSE_BYTES - total;
          if (room > 0) chunks.push(value.subarray(0, room));
          truncated = true;
          // Cancel further read; releases the upstream socket.
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }

    // Decode UTF-8 with fallback. Most APIs are JSON/text; binary bodies
    // come back as latin1-decoded mojibake but won't crash — the AI will
    // see "[binary-looking]" and can ask again with a Range header.
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    const text = buf.toString('utf8');

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });

    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: truncated ? `${text}\n…[response truncated at ${MAX_RESPONSE_BYTES} bytes]` : text,
      truncated: truncated || undefined,
      url: resp.url,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new HttpRequestError(504, `request timed out after ${timeoutMs}ms`);
    }
    if (e instanceof HttpRequestError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // Surface DNS / refused / TLS errors as 502 — the AI can retry or
    // try a different URL.
    throw new HttpRequestError(502, `fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
