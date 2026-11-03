/**
 * 执行层（ADR 0005 §3）：路由 → 预算 → 缓存 → 调用 → 契约校验 → 重试 → 降级。
 * 业务层只看到 AgentPort；这里才是模型世界。
 */
import type { AgentOutcome, AgentPort, AgentProvenance, DigestRequest } from '@sb/contracts';
import type { Clock } from '@sb/contracts';
import { validateDraftProposal } from '@sb/domain';
import { AgentProviderError, AgentRuntimeError } from './errors';
import { costOf, estimateCost, type BudgetLedger } from './budget';
import { proposalCacheKey, sha256, type CompletionCache } from './cache';
import { routeProfiles, type AgentTask, type ModelProfile, type TaskPolicy } from './route';

export interface CompletionRequest {
  readonly profile: ModelProfile;
  readonly system: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  /** 输出格式：默认 json（digest 的结构化草稿）；compose 用 text 拿原始 Markdown。 */
  readonly responseFormat?: 'json' | 'text';
}

export interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResponse {
  readonly raw: unknown;
  readonly usage: CompletionUsage;
}

/** provider 适配器只负责调用与错误分类；重试/降级/预算都在 runner。 */
export interface CompletionProvider {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export interface PromptSpec {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly system: string;
  readonly render: (request: DigestRequest) => string;
}

export interface AgentRunnerOptions {
  readonly provider: CompletionProvider;
  readonly profiles: readonly ModelProfile[];
  readonly policies: Readonly<Record<AgentTask, TaskPolicy>>;
  readonly cache: CompletionCache;
  readonly budget: BudgetLedger;
  readonly clock: Clock;
  readonly prompt: PromptSpec;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly task?: AgentTask;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AgentRunner implements AgentPort {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: AgentRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async draft(request: DigestRequest): Promise<AgentOutcome> {
    const task = this.options.task ?? 'digest';
    const policy = this.options.policies[task];
    const routing = routeProfiles(task, request.sensitivity, this.options.profiles, this.options.policies);
    if (routing.chain.length === 0) {
      throw new AgentRuntimeError('NO_PROFILE', '没有满足条件的模型 profile', { rejected: routing.rejected });
    }

    const primary = routing.chain[0] as ModelProfile;
    const maxOutputTokens = Math.min(policy.maxOutputTokens, request.budget.maxOutputTokens);
    const retrievedChars = request.retrieved.reduce((total, hit) => total + hit.name.length + 40, 0);
    const estimate = estimateCost({
      charCount: [...request.content].length,
      retrievedChars,
      expectedClaims: policy.expectedClaims,
      maxOutputTokens,
      profile: primary,
    });
    this.options.budget.preflight(estimate.cost);

    const contentHash = sha256(request.content);
    const retrievedIds = request.retrieved.map((hit) => String(hit.nodeId));
    const promptInput = this.options.prompt.render(request);
    const fallbackChain: string[] = [];

    for (const profile of routing.chain) {
      const key = proposalCacheKey({
        contentHash,
        promptSha256: this.options.prompt.sha256,
        profileId: profile.id,
        retrievedIds,
      });

      const cached = this.options.cache.get(key);
      if (cached) {
        return {
          proposal: cached.proposal,
          cost: 0,
          provenance: this.provenance(profile, cached.inputTokens, cached.outputTokens, null, fallbackChain, true),
        };
      }

      const outcome = await this.tryProfile(profile, promptInput, maxOutputTokens, key, fallbackChain);
      if (outcome) return outcome;
      fallbackChain.push(profile.id);
    }

    throw new AgentRuntimeError('ALL_PROFILES_FAILED', '所有 profile 均失败', {
      chain: routing.chain.map((profile) => profile.id),
    });
  }

  private async tryProfile(
    profile: ModelProfile,
    baseInput: string,
    maxOutputTokens: number,
    cacheKey: string,
    fallbackChain: readonly string[],
  ): Promise<AgentOutcome | null> {
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
        });
      } catch (error) {
        if (error instanceof AgentProviderError && error.kind === 'refusal') {
          throw new AgentRuntimeError('REFUSAL', '模型拒答', { profileId: profile.id });
        }
        if (
          error instanceof AgentProviderError &&
          (error.kind === 'timeout' || error.kind === 'rate_limit' || error.kind === 'upstream')
        ) {
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
      this.options.budget.record({
        cost,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      const validation = validateDraftProposal(response.raw);
      if (!validation.ok) {
        if (!contractRetried) {
          contractRetried = true;
          suffix = `\n\n【上一次输出不合法，请严格按 schema 重新输出】${validation.error.message}`;
          continue;
        }
        throw new AgentRuntimeError('CONTRACT_VIOLATION', validation.error.message, { profileId: profile.id });
      }

      this.options.cache.set(cacheKey, {
        proposal: validation.value,
        profileId: profile.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        createdAt: this.options.clock.now(),
      });

      return {
        proposal: validation.value,
        cost,
        provenance: this.provenance(
          profile,
          response.usage.inputTokens,
          response.usage.outputTokens,
          latencyMs,
          fallbackChain,
          false,
        ),
      };
    }

    return null;
  }

  private provenance(
    profile: ModelProfile,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number | null,
    fallbackChain: readonly string[],
    cacheHit: boolean,
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
      cacheHit,
    };
  }
}
