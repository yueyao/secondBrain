/**
 * OpenAI 兼容 provider：只负责 HTTP 调用与错误分类。
 * 重试 / 降级 / 预算 / 契约校验全部在 @sb/agent-runtime 的 runner 里。
 */
import { AgentProviderError } from '@sb/agent-runtime';
import type { CompletionProvider, CompletionRequest, CompletionResponse } from '@sb/agent-runtime';

export interface OpenAICompatibleOptions {
  /** 例如 https://api.openai.com/v1 或自建网关地址 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: string;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export class OpenAICompatibleProvider implements CompletionProvider {
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.temperature = options.temperature ?? 0.2;
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: request.profile.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.input },
      ],
      temperature: this.temperature,
      max_tokens: request.maxOutputTokens,
      response_format: { type: 'json_object' },
    };

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AgentProviderError('timeout', `请求超时（${this.timeoutMs}ms）`);
      }
      throw new AgentProviderError('upstream', `网络错误：${String((error as Error).message)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) throw new AgentProviderError('rate_limit', '被限流', { status: 429 });
      if (response.status >= 500) throw new AgentProviderError('upstream', `服务端错误 ${response.status}`, { status: response.status });
      if (response.status === 400 && /content[_ ]?filter|safety/i.test(text)) {
        throw new AgentProviderError('refusal', '内容被安全策略拒绝', { status: 400 });
      }
      throw new AgentProviderError('upstream', `请求失败 ${response.status}：${text.slice(0, 200)}`, { status: response.status });
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      throw new AgentProviderError('refusal', '模型触发内容过滤');
    }

    const content = choice?.message?.content;
    let raw: unknown = content;
    if (typeof content === 'string') {
      try {
        raw = JSON.parse(content);
      } catch {
        // 非 JSON 原文交给 runner 的契约校验处理（会重试一次再失败）
        raw = content;
      }
    }

    return {
      raw,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}
