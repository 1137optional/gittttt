import type {
  AIChatMessage,
  AIChatRequest,
  AIChatResponse,
} from '../shared/types.js';

// =============================================================================
// AI chat proxy.
//
// Why proxy instead of calling DeepSeek straight from the browser:
//   - CORS: api.deepseek.com does not advertise broad CORS access. Going
//     through the local server sidesteps that entirely.
//   - Key hygiene: the embedded preview iframe runs untrusted user code; if
//     the chat HTTP call were a `fetch` from the same window, a buggy/evil
//     piece of user code could read the request and exfiltrate the API key.
//     Proxying through `127.0.0.1:3001/api/ai/chat` keeps the key strictly
//     outside the iframe's reach (the iframe has no way to read parent
//     fetches that target a different origin).
//   - Centralised error normalisation.
//
// We never persist the API key here — the client sends it every call from
// its own localStorage and the server forwards it 1:1.
// =============================================================================

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

const SYSTEM_PROMPT =
  '你是 gittttt 调试助手。用户会粘贴运行时日志、堆栈或代码片段。请：\n' +
  '1) 用一两句话定位最可能的根因；\n' +
  '2) 给出最小可执行的修复方案（必要时给修改后的代码片段）；\n' +
  '3) 如果信息不足，明确指出还需要哪些额外日志或上下文。\n' +
  '回答简洁、有判断，避免泛泛而谈。';

interface DeepSeekChoice {
  message?: { content?: string };
}
interface DeepSeekResponse {
  choices?: DeepSeekChoice[];
  error?: { message?: string };
}

export async function aiChat(req: AIChatRequest): Promise<AIChatResponse> {
  if (!req.apiKey || typeof req.apiKey !== 'string') {
    throw new Error('Missing apiKey');
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  if (req.provider !== 'deepseek') {
    throw new Error(`Unsupported provider: ${req.provider}`);
  }

  // Prepend our system prompt unless the caller already supplied one. This
  // way the user can override behaviour by sending a leading {role:'system'}
  // entry (e.g. for a different language or persona).
  const hasSystem = req.messages[0]?.role === 'system';
  const messages: AIChatMessage[] = hasSystem
    ? req.messages
    : [{ role: 'system', content: SYSTEM_PROMPT }, ...req.messages];

  let resp: Response;
  try {
    resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model || DEFAULT_DEEPSEEK_MODEL,
        messages,
        stream: false,
      }),
    });
  } catch (e) {
    throw new Error(`AI network error: ${(e as Error).message}`);
  }

  let text = '';
  try {
    text = await resp.text();
  } catch {
    /* fall through to status-code error below */
  }

  if (!resp.ok) {
    // DeepSeek mirrors the OpenAI error envelope `{error:{message}}`. Surface
    // that message verbatim so 401 / 402 / 429 land in front of the user with
    // actionable text instead of a generic "AI failed".
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const j = JSON.parse(text) as DeepSeekResponse;
      if (j.error?.message) detail = j.error.message;
    } catch {
      if (text) detail = `${detail} ${text.slice(0, 200)}`;
    }
    throw new Error(`AI provider error: ${detail}`);
  }

  let parsed: DeepSeekResponse;
  try {
    parsed = JSON.parse(text) as DeepSeekResponse;
  } catch {
    throw new Error('AI provider returned non-JSON response.');
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI provider returned an empty message.');
  return { content };
}
