import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionRequest } from '@sb/agent-runtime';
import { OpenAICompatibleProvider } from '../src/provider';

const profile = {
  id: 'strong',
  provider: 'openai-compatible',
  model: 'test-model-2026-01',
  capabilities: { contextTokens: 128_000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public', 'restricted'] },
  pricing: { inPerMTokens: 0, outPerMTokens: 0 },
  limits: { maxConcurrency: 1, requestsPerMinute: 60 },
  health: { enabled: true, fallbackTo: [] },
} as const;

function request(): CompletionRequest {
  return { profile, system: '系统提示', input: '原文内容', maxOutputTokens: 1000 };
}

interface Captured {
  readonly auth: string | undefined;
  readonly body: Record<string, unknown>;
}

async function startServer(
  handler: (captured: Captured, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const entry: Captured = { auth: req.headers.authorization, body };
      captured.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const okBody = {
  choices: [{ message: { content: JSON.stringify({ tier: 'standard', rationale: 'ok', claims: [], nodes: [] }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1234, completion_tokens: 234 },
};

let server: Awaited<ReturnType<typeof startServer>> | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

describe('OpenAI 兼容 provider', () => {
  it('请求体包含 model / messages / json 输出，并带上鉴权头', async () => {
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(okBody));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'secret-key' });

    const response = await provider.complete(request());
    const captured = server.captured[0]!;

    expect(captured.auth).toBe('Bearer secret-key');
    expect(captured.body.model).toBe('test-model-2026-01');
    expect(captured.body.response_format).toEqual({ type: 'json_object' });
    expect(captured.body.max_tokens).toBe(1000);
    expect(captured.body.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '原文内容' },
    ]);
    expect(response.raw).toMatchObject({ tier: 'standard' });
    expect(response.usage).toEqual({ inputTokens: 1234, outputTokens: 234 });
  });

  it('429 → rate_limit，5xx → upstream（由 runner 决定重试/降级）', async () => {
    server = await startServer((_captured, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate"}');
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });
    await expect(provider.complete(request())).rejects.toMatchObject({ kind: 'rate_limit' });
    await server.close();
    server = null;

    server = await startServer((_captured, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('overloaded');
    });
    const provider2 = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });
    await expect(provider2.complete(request())).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('内容过滤被识别为 refusal（不重试）', async () => {
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });
    await expect(provider.complete(request())).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('超时被识别为 timeout', async () => {
    server = await startServer((_captured, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(okBody));
      }, 300);
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k', timeoutMs: 50 });
    await expect(provider.complete(request())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('providerOptions 原样透传（DeepSeek 的 thinking / reasoning_effort）', async () => {
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(okBody));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });
    await provider.complete({
      ...request(),
      profile: { ...profile, providerOptions: { thinking: { type: 'disabled' }, reasoning_effort: 'high' } },
    });
    expect(server.captured[0]?.body).toMatchObject({
      thinking: { type: 'disabled' },
      reasoning_effort: 'high',
    });
  });

  it('模型返回非 JSON 时原样交给 runner 做契约校验', async () => {
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '这不是 JSON' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });
    const response = await provider.complete(request());
    expect(response.raw).toBe('这不是 JSON');
  });
});

describe('OpenAI 兼容 provider：text 输出模式（compose）', () => {
  it('不请求 json_object，并把模型返回的原始 Markdown 原样交给 runner', async () => {
    const content = '# 标题\n\n正文第一段（来源：[[raw/knowledge/cubox/a.md]]）。';
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });

    const response = await provider.complete({ ...request(), responseFormat: 'text' });

    expect(server.captured[0]?.body.response_format).toBeUndefined();
    expect(response.raw).toBe(content);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('text 模式下内容即使像 JSON 也不解析（Markdown 不能被吞）', async () => {
    const content = '{"tier":"standard"}';
    server = await startServer((_captured, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: 'k' });

    const response = await provider.complete({ ...request(), responseFormat: 'text' });

    expect(response.raw).toBe(content);
  });
});
