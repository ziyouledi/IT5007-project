import { describe, expect, it } from 'vitest';
import { createFakeLlm, createOpenAiLlm, LlmError, llmFromEnv } from '../src/llm';

function replyWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('OpenAI-compatible LLM client', () => {
  it('posts the messages to /chat/completions and returns the reply text', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example/v1/',
      apiKey: 'secret',
      model: 'deepseek-chat',
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });

    const text = await llm.complete([{ role: 'user', content: 'hi' }], { json: true });

    expect(text).toBe('{"ok":true}');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://gateway.example/v1/chat/completions');
    expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
  });

  it('fails loudly on an HTTP error, a malformed reply, or a timeout', async () => {
    const options = { baseUrl: 'https://gateway.example', apiKey: 'k', model: 'm' };

    await expect(
      createOpenAiLlm({ ...options, fetchImpl: replyWith({ error: 'nope' }, 502) }).complete([]),
    ).rejects.toThrow(/HTTP 502/);
    await expect(createOpenAiLlm({ ...options, fetchImpl: replyWith({ choices: [] }) }).complete([])).rejects.toThrow(
      LlmError,
    );

    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expect(createOpenAiLlm({ ...options, timeoutMs: 20, fetchImpl: hanging }).complete([])).rejects.toThrow(
      /timed out after 20 ms/,
    );
  });

  it('drops response_format, once and for good, when the model refuses it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const llm = createOpenAiLlm({
      baseUrl: 'https://gateway.example',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if ('response_format' in body) {
          return new Response('{"error":"response_format is not supported by this model"}', { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      },
    });

    expect(await llm.complete([], { json: true })).toBe('{}');
    expect(await llm.complete([], { json: true })).toBe('{}');
    expect(bodies.map((body) => 'response_format' in body)).toEqual([true, false, false]);
  });

  it('is configured from the environment only when every setting is present', () => {
    expect(llmFromEnv({})).toBeUndefined();
    expect(llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k' })).toBeUndefined();
    expect(llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'm' })).toBeDefined();
    expect(() =>
      llmFromEnv({ KAKI_LLM_BASE_URL: 'https://x', KAKI_LLM_API_KEY: 'k', KAKI_LLM_MODEL: 'm', KAKI_LLM_TIMEOUT_MS: 'soon' }),
    ).toThrow(/KAKI_LLM_TIMEOUT_MS/);
  });
});

describe('fake LLM', () => {
  it('records calls and answers from the script', async () => {
    const llm = createFakeLlm((_messages, call) => `reply ${call}`);

    expect(await llm.complete([{ role: 'user', content: 'a' }])).toBe('reply 0');
    expect(await llm.complete([{ role: 'user', content: 'b' }])).toBe('reply 1');
    expect(llm.calls.map((messages) => messages[0]!.content)).toEqual(['a', 'b']);
  });
});
