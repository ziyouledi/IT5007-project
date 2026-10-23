/** One chat message sent to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options for one completion call. */
export interface CompleteOptions {
  /** Ask the model for a single JSON object. */
  json?: boolean;
  signal?: AbortSignal;
}

/** The shared LLM client every module uses; the fake one stands in for it in tests. */
export interface LlmClient {
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
}

/** An LLM call that failed: HTTP error, timeout, or an unusable reply. */
export class LlmError extends Error {}

/** Settings for an OpenAI-compatible chat completions endpoint (such as the school gateway). */
export interface OpenAiLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Pull choices[0].message.content out of a chat completions reply.
function contentOf(body: unknown): string | undefined {
  if (!isObject(body) || !Array.isArray(body.choices)) return undefined;
  const [first] = body.choices as unknown[];
  if (!isObject(first) || !isObject(first.message)) return undefined;
  return typeof first.message.content === 'string' ? first.message.content : undefined;
}

/** Create a client for an OpenAI-compatible `/chat/completions` endpoint. */
export function createOpenAiLlm({
  baseUrl,
  apiKey,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: OpenAiLlmOptions): LlmClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async complete(messages, options = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            ...(options.json === true ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal,
        });
      } catch (error) {
        const reason = timeout.aborted ? `timed out after ${timeoutMs} ms` : String(error);
        throw new LlmError(`LLM request failed: ${reason}`, { cause: error });
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new LlmError(`LLM request failed with HTTP ${response.status}: ${detail}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new LlmError('LLM reply is not valid JSON', { cause: error });
      }
      const content = contentOf(body);
      if (content === undefined) throw new LlmError('LLM reply has no message content');
      return content;
    },
  };
}

/** A scripted LLM for tests: records every call and answers with `respond`. */
export interface FakeLlm extends LlmClient {
  calls: ChatMessage[][];
}

/** Create a fake LLM; `respond` may return text or throw to simulate an outage. */
export function createFakeLlm(
  respond: (messages: ChatMessage[], call: number) => string | Promise<string>,
): FakeLlm {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      calls.push(messages);
      return respond(messages, calls.length - 1);
    },
  };
}

/**
 * Build the client from KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL.
 * Returns undefined when any is missing, so callers can run without an LLM.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | undefined {
  const baseUrl = env.KAKI_LLM_BASE_URL;
  const apiKey = env.KAKI_LLM_API_KEY;
  const model = env.KAKI_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;

  const rawTimeout = env.KAKI_LLM_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`Invalid KAKI_LLM_TIMEOUT_MS: ${rawTimeout}`);
  }
  return createOpenAiLlm({ baseUrl, apiKey, model, timeoutMs });
}
