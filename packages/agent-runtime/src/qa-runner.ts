/**
 * 问答链执行层（P1）：路由 → 预算 → 文本生成 → 结构契约校验 → 重试 → 降级 → 记账 → provenance。
 *
 * 业务层只看到 QaPort；模型负责"提问与收口"，本地契约负责"数量 + 四段结构"兜底。
 */
import type { AgentProvenance, Clock, QaPort, QaRequest, QaResult } from '@sb/contracts';
import { costOf, estimateCost, type BudgetLedger } from './budget';
import { AgentProviderError, AgentRuntimeError, isRetryable } from './errors';
import type { CompletionProvider } from './runner';
import { routeProfiles, type AgentTask, type ModelProfile, type TaskPolicy } from './route';

export interface QaPromptSpec {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly system: string;
  readonly render: (request: QaRequest) => string;
}

export interface QaRunnerOptions {
  readonly provider: CompletionProvider;
  readonly profiles: readonly ModelProfile[];
  readonly policies: Readonly<Record<AgentTask, TaskPolicy>>;
  readonly budget: BudgetLedger;
  readonly clock: Clock;
  readonly prompt: QaPromptSpec;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

const CONTRACT_HINT = '【上一次输出不符合格式，请严格按"### Qn. + 四段"重写】';
const REQUIRED_FIELDS = ['结论', '形式化', '论证步', '边界'] as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function charCount(text: string): number {
  return [...text].length;
}

type QaContract = { readonly ok: true; readonly text: string; readonly questionCount: number } | { readonly ok: false; readonly reason: string };

/** 拆出每个 `### Qn.` 块（按标题切分）。 */
function splitQuestions(text: string): string[] {
  const headings = [...text.matchAll(/^###\s*Q\d+[.、:：]?\s*/gmu)];
  if (headings.length === 0) return [];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1]?.index ?? text.length) : text.length;
    return text.slice(start, end).trim();
  });
}

function validateQa(request: QaRequest, raw: unknown): QaContract {
  if (typeof raw !== 'string') return { ok: false, reason: 'provider 在 text 模式下必须返回字符串' };
  const text = raw.trim();
  if (charCount(text) < 120) return { ok: false, reason: '输出过短，无法构成问答链' };
  const blocks = splitQuestions(text);
  const count = blocks.length;
  if (count < request.questionCount.min) {
    return { ok: false, reason: `问题数不足 ${request.questionCount.min}（当前 ${count}）` };
  }
  if (count > request.questionCount.max) {
    return { ok: false, reason: `问题数超过 ${request.questionCount.max}（当前 ${count}）` };
  }
  for (const [index, block] of blocks.entries()) {
    const missing = REQUIRED_FIELDS.filter((field) => !new RegExp(`(?:\\*\\*)?${field}(?:\\*\\*)?\\s*[：:]`, 'u').test(block));
    if (missing.length > 0) {
      return { ok: false, reason: `第 ${index + 1} 个回答缺少字段：${missing.join('、')}` };
    }
  }
  return { ok: true, text, questionCount: count };
}

export class QaRunner implements QaPort {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly options: QaRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async generate(request: QaRequest): Promise<QaResult> {
    const policy = this.options.policies.qa;
    const routing = routeProfiles('qa', 'public', this.options.profiles, this.options.policies);
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
    request: QaRequest,
    baseInput: string,
    maxOutputTokens: number,
    fallbackChain: readonly string[],
  ): Promise<QaResult | null> {
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
          return null;
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

      const contract = validateQa(request, response.raw);
      if (!contract.ok) {
        if (!contractRetried) {
          contractRetried = true;
          suffix = `\n\n${CONTRACT_HINT}${contract.reason}`;
          continue;
        }
        throw new AgentRuntimeError('CONTRACT_VIOLATION', contract.reason, { profileId: profile.id });
      }

      return {
        markdown: contract.text,
        questionCount: contract.questionCount,
        cost,
        provenance: this.provenance(profile, response.usage.inputTokens, response.usage.outputTokens, latencyMs, fallbackChain),
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
