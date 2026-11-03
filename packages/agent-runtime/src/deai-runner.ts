/**
 * 去 AI 味执行层（独立能力，与 ComposeRunner 同一套语义）：
 * 路由 → 预算 → 调用（text 模式）→ 文本契约校验 → 重试 → 降级 → 记账 → provenance。
 *
 * 业务层只看到 DeAiPort；模型只做表达改写，"事实、引用、长度"由本地文本契约兜底：
 * 不合规先回喂原因重试一次，仍不合规则拒绝，绝不返回半成品。
 */
import type { AgentProvenance, Clock, DeAiPort, DeAiRequest, DeAiResult } from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { costOf, estimateCost, type BudgetLedger } from './budget';
import { AgentProviderError, AgentRuntimeError, isRetryable } from './errors';
import type { CompletionProvider } from './runner';
import { routeProfiles, type AgentTask, type ModelProfile, type TaskPolicy } from './route';

/** 去 AI 味提示词；sha256 用于 provenance 归因。 */
export interface DeAiPromptSpec {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly system: string;
  readonly render: (request: DeAiRequest) => string;
}

export interface DeAiRunnerOptions {
  readonly provider: CompletionProvider;
  readonly profiles: readonly ModelProfile[];
  readonly policies: Readonly<Record<AgentTask, TaskPolicy>>;
  readonly budget: BudgetLedger;
  readonly clock: Clock;
  readonly prompt: DeAiPromptSpec;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

const CONTRACT_HINT = '【上一次改写不合规，请严格按要求重新改写】';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function charCount(text: string): number {
  return [...text].length;
}

type TextContract = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/**
 * 去 AI 味文本契约（应用层还会再做事实/引用校验，这里只拦最硬的三条）：
 * 1) provider 在 text 模式下必须返回字符串；
 * 2) 去空白后的长度必须落在应用层给定的目标区间（防止越改越短/越改越长）；
 * 3) 引用只减不增：输出里的来源必须全部来自 keepCitations（不得编造），
 *    且 keepCitations 里的每个来源都必须原样出现；keepCitations 为空时不做引用校验。
 */
function validateText(request: DeAiRequest, raw: unknown): TextContract {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'text 模式下 provider 必须返回字符串' };
  }
  const text = raw.trim();
  const length = charCount(text);
  if (length < request.target.minChars) {
    return { ok: false, reason: `改写后不足 ${request.target.minChars} 字（当前 ${length} 字）` };
  }
  if (length > request.target.maxChars) {
    return { ok: false, reason: `改写后超过 ${request.target.maxChars} 字（当前 ${length} 字）` };
  }
  if (request.keepCitations.length === 0) return { ok: true, text };

  const sources = extractCitationSources(text);
  const kept = new Set(request.keepCitations);
  const added = sources.filter((source) => !kept.has(source));
  if (added.length > 0) {
    return { ok: false, reason: `输出新增了原文没有的引用来源：${added.join('、')}` };
  }
  const present = new Set(sources);
  const missing = request.keepCitations.filter((source) => !present.has(source));
  if (missing.length > 0) {
    return { ok: false, reason: `丢失了必须保留的引用来源：${missing.join('、')}` };
  }
  return { ok: true, text };
}

export class DeAiRunner implements DeAiPort {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: DeAiRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async humanize(request: DeAiRequest): Promise<DeAiResult> {
    const policy = this.options.policies.deai;
    const routing = routeProfiles('deai', 'public', this.options.profiles, this.options.policies);
    if (routing.chain.length === 0) {
      throw new AgentRuntimeError('NO_PROFILE', '没有满足条件的模型 profile', { rejected: routing.rejected });
    }

    const input = this.options.prompt.render(request);
    const primary = routing.chain[0] as ModelProfile;
    const estimate = estimateCost({
      charCount: charCount(input),
      retrievedChars: 0,
      expectedClaims: policy.expectedClaims,
      maxOutputTokens: policy.maxOutputTokens,
      profile: primary,
    });
    this.options.budget.preflight(estimate.cost);

    const fallbackChain: string[] = [];
    for (const profile of routing.chain) {
      const result = await this.tryProfile(profile, request, input, policy.maxOutputTokens, fallbackChain);
      if (result) return result;
      fallbackChain.push(profile.id);
    }

    throw new AgentRuntimeError('ALL_PROFILES_FAILED', '所有 profile 均失败', {
      chain: routing.chain.map((profile) => profile.id),
    });
  }

  private async tryProfile(
    profile: ModelProfile,
    request: DeAiRequest,
    baseInput: string,
    maxOutputTokens: number,
    fallbackChain: readonly string[],
  ): Promise<DeAiResult | null> {
    let suffix = '';
    let contractRetried = false;

    for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
      const startedAt = this.now();
      let response;
      try {
        response = await this.options.provider.complete({
          profile,
          system: this.options.prompt.system,
          input: `${baseInput}${suffix}`,
          maxOutputTokens,
          responseFormat: 'text',
        });
      } catch (error) {
        if (error instanceof AgentProviderError && error.kind === 'refusal') {
          throw new AgentRuntimeError('REFUSAL', '模型拒答', { profileId: profile.id });
        }
        if (isRetryable(error)) {
          if (attempt < this.maxAttempts) {
            await this.sleep(1_000 * 2 ** attempt);
            continue;
          }
          return null; // 重试用尽 → 降级到下一个 profile
        }
        throw new AgentRuntimeError('PROVIDER_ERROR', `provider 调用失败：${String((error as Error).message)}`, {
          profileId: profile.id,
        });
      }

      const latencyMs = this.now() - startedAt;
      const cost = costOf(response.usage, profile);
      // 只要模型成功返回就计费，不管内容是否通过契约（与 AgentRunner/ComposeRunner 一致）
      this.options.budget.record({
        cost,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      const contract = validateText(request, response.raw);
      if (!contract.ok) {
        if (!contractRetried) {
          contractRetried = true;
          suffix = `\n\n${CONTRACT_HINT}${contract.reason}`;
          continue;
        }
        throw new AgentRuntimeError('CONTRACT_VIOLATION', contract.reason, { profileId: profile.id });
      }

      return {
        text: contract.text,
        cost,
        provenance: this.provenance(
          profile,
          response.usage.inputTokens,
          response.usage.outputTokens,
          latencyMs,
          fallbackChain,
        ),
      };
    }

    return null;
  }

  private provenance(
    profile: ModelProfile,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    fallbackChain: readonly string[],
  ): AgentProvenance {
    return {
      profileId: profile.id,
      provider: profile.provider,
      model: profile.model,
      promptId: this.options.prompt.id,
      promptVersion: this.options.prompt.version,
      promptSha256: this.options.prompt.sha256,
      inputTokens,
      outputTokens,
      latencyMs,
      fallbackChain: [...fallbackChain],
      cacheHit: false,
    };
  }
}
