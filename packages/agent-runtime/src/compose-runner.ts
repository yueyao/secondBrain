/**
 * Compose 执行层（主编台 C2 / ADR 0005 修订）：
 * 路由 → 预算 → 调用（text 模式）→ 文本契约校验 → 重试 → 降级 → 记账 → provenance。
 *
 * 业务层只看到 ComposePort；模型只产 Markdown，"每句话能回溯原文"靠正文里的
 * `（来源：[[raw/...]]）` 标记，而不是让模型自报结构。
 */
import type {
  AgentProvenance,
  Clock,
  ComposeKind,
  ComposePort,
  ComposeRequest,
  ComposeResult,
} from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { costOf, estimateCost, type BudgetLedger } from './budget';
import { AgentProviderError, AgentRuntimeError, isRetryable } from './errors';
import type { CompletionProvider } from './runner';
import { routeProfiles, type AgentTask, type ModelProfile, type TaskPolicy } from './route';

/** 某一类生成（大纲 / 正文）的提示词；sha256 用于 provenance 归因。 */
export interface ComposePromptSpec {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly system: string;
  readonly render: (request: ComposeRequest) => string;
}

export interface ComposeRunnerOptions {
  readonly provider: CompletionProvider;
  readonly profiles: readonly ModelProfile[];
  readonly policies: Readonly<Record<AgentTask, TaskPolicy>>;
  readonly budget: BudgetLedger;
  readonly clock: Clock;
  /** outline 与 body 各自的提示词（调用方按业务文案提供） */
  readonly prompts: Readonly<Record<ComposeKind, ComposePromptSpec>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

/** 文本契约门槛与应用层兜底校验保持一致（60 / 300）。 */
const MIN_OUTLINE_CHARS = 60;
const MIN_BODY_CHARS = 300;
const MIN_BODY_CITATIONS = 2;
const CONTRACT_HINT = '【上一次输出不合规，请严格按要求重新输出】';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function charCount(text: string): number {
  return [...text].length;
}

type TextContract = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** 文本输出契约：类型 + 长度（+ 正文引用数）。不合法时把原因回喂模型重试一次。 */
function validateText(kind: ComposeKind, raw: unknown): TextContract {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'text 模式下 provider 必须返回字符串原始 Markdown' };
  }
  const text = raw.trim();
  if (kind === 'outline') {
    if (charCount(text) < MIN_OUTLINE_CHARS) {
      return { ok: false, reason: `大纲去空白后不足 ${MIN_OUTLINE_CHARS} 字` };
    }
    return { ok: true };
  }
  if (charCount(text) < MIN_BODY_CHARS) {
    return { ok: false, reason: `正文去空白后不足 ${MIN_BODY_CHARS} 字` };
  }
  const sources = extractCitationSources(raw);
  if (sources.length < MIN_BODY_CITATIONS) {
    return { ok: false, reason: `正文引用不足（去重后 ${sources.length} 个，至少 ${MIN_BODY_CITATIONS} 个）` };
  }
  return { ok: true };
}

export class ComposeRunner implements ComposePort {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ComposeRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async write(request: ComposeRequest): Promise<ComposeResult> {
    const policy = this.options.policies.compose;
    const prompt = this.options.prompts[request.kind];
    const routing = routeProfiles('compose', 'public', this.options.profiles, this.options.policies);
    if (routing.chain.length === 0) {
      throw new AgentRuntimeError('NO_PROFILE', '没有满足条件的模型 profile', { rejected: routing.rejected });
    }

    const input = prompt.render(request);
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
      const result = await this.tryProfile(profile, prompt, request, input, policy.maxOutputTokens, fallbackChain);
      if (result) return result;
      fallbackChain.push(profile.id);
    }

    throw new AgentRuntimeError('ALL_PROFILES_FAILED', '所有 profile 均失败', {
      chain: routing.chain.map((profile) => profile.id),
    });
  }

  private async tryProfile(
    profile: ModelProfile,
    prompt: ComposePromptSpec,
    request: ComposeRequest,
    baseInput: string,
    maxOutputTokens: number,
    fallbackChain: readonly string[],
  ): Promise<ComposeResult | null> {
    let suffix = '';
    let contractRetried = false;

    for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
      const startedAt = this.now();
      let response;
      try {
        response = await this.options.provider.complete({
          profile,
          system: prompt.system,
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
      this.options.budget.record({
        cost,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      const contract = validateText(request.kind, response.raw);
      if (!contract.ok) {
        if (!contractRetried) {
          contractRetried = true;
          suffix = `\n\n${CONTRACT_HINT}${contract.reason}`;
          continue;
        }
        throw new AgentRuntimeError('CONTRACT_VIOLATION', contract.reason, { profileId: profile.id });
      }

      const text = response.raw as string;
      return {
        text,
        citations:
          request.kind === 'body'
            ? extractCitationSources(text).map((source) => ({ source, text: '' }))
            : [],
        cost,
        provenance: this.provenance(
          profile,
          prompt,
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
    prompt: ComposePromptSpec,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    fallbackChain: readonly string[],
  ): AgentProvenance {
    return {
      profileId: profile.id,
      provider: profile.provider,
      model: profile.model,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptSha256: prompt.sha256,
      inputTokens,
      outputTokens,
      latencyMs,
      fallbackChain: [...fallbackChain],
      cacheHit: false,
    };
  }
}
