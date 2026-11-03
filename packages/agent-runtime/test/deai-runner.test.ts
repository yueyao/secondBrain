import { describe, expect, it } from 'vitest';
import type { DeAiIssue, DeAiRequest } from '@sb/contracts';
import { BudgetLedger } from '../src/budget';
import { DeAiRunner, type DeAiPromptSpec, type DeAiRunnerOptions } from '../src/deai-runner';
import { AgentProviderError, AgentRuntimeError } from '../src/errors';
import type { CompletionProvider, CompletionRequest, CompletionResponse } from '../src/runner';
import { clock, policies, profiles } from './fixtures';

/** 记录调用、按脚本返回文本（或抛错）的 provider；重试/降级都在 runner 里验证。 */
class FakeTextProvider implements CompletionProvider {
  readonly calls: CompletionRequest[] = [];
  private readonly steps: unknown[];

  constructor(
    steps: readonly unknown[],
    private readonly okText: string,
    private readonly usage = { inputTokens: 900, outputTokens: 300 },
  ) {
    this.steps = [...steps];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);
    const step = this.steps.shift();
    if (step instanceof Error) throw step;
    return { raw: step ?? this.okText, usage: this.usage };
  }
}

const CITE_A = 'raw/knowledge/cubox/a.md';
const CITE_B = 'raw/knowledge/cubox/b.md';
const CITE_C = 'raw/knowledge/cubox/c.md';

const ORIGINAL_TEXT = [
  '值得思考的是，在当今这个充满不确定性的时代，长期主义显得尤为重要。',
  '我们不能仅仅停留在表面的坚持上，而是要深入理解时间带来的复利效应。',
].join('\n');

/** 满足「长度 + 引用」契约的改写结果（144 字，保留两条原引用）。 */
const OK_TEXT = [
  '长期主义不是坚持得久，而是让每一次选择都进入复利轨道。',
  `中断一次不是少赚一点，而是把曲线打回原点（来源：[[${CITE_A}]]）。`,
  `所以真正的难点在于取舍：先保住不下牌桌的资格，再谈机会（来源：[[${CITE_B}]]）。`,
].join('\n');

/** 长度够、原引用都在，但编造了原文没有的 c.md。 */
const FABRICATED_TEXT = `${OK_TEXT}\n另外补一句（来源：[[${CITE_C}]]）。`;

/** 长度够，但丢了必须保留的 b.md。 */
const MISSING_TEXT = OK_TEXT.replace(`（来源：[[${CITE_B}]]）`, '');

const TOO_SHORT_TEXT = '太短了';
const TOO_LONG_TEXT = '长'.repeat(700);

const ISSUES: readonly DeAiIssue[] = [
  { category: 'lexical', label: '空泛套话', count: 2, examples: ['值得思考的是', '在当今这个……时代'] },
  { category: 'structure', label: '三段式排比', count: 1, examples: ['不仅仅……而是……'] },
];

const PROMPT: DeAiPromptSpec = {
  id: 'deai-humanize',
  version: 2,
  sha256: 'sha-deai-test',
  system: '你是中文文字编辑，负责把 AI 味重的文字改写成自然的人话，不得改动事实与引用。',
  render: (request) =>
    [
      `title=${request.title ?? ''}`,
      `style=${request.style}`,
      `instruction=${request.instruction ?? ''}`,
      `keepCitations=${request.keepCitations.join(',')}`,
      `target=${request.target.minChars}-${request.target.maxChars}`,
      `issues=${request.issues.map((issue) => `${issue.category}:${issue.label}×${issue.count}`).join('|')}`,
      '---',
      request.text,
    ].join('\n'),
};

function deaiRequest(overrides: Partial<DeAiRequest> = {}): DeAiRequest {
  return {
    text: ORIGINAL_TEXT,
    title: '测试文章',
    style: 'casual',
    issues: ISSUES,
    keepCitations: [CITE_A, CITE_B],
    target: { minChars: 60, maxChars: 600 },
    instruction: null,
    ...overrides,
  };
}

function makeRunner(provider: CompletionProvider, overrides: Partial<DeAiRunnerOptions> = {}): DeAiRunner {
  return new DeAiRunner({
    provider,
    profiles,
    policies,
    budget: new BudgetLedger({}, clock),
    clock,
    prompt: PROMPT,
    sleep: async () => undefined,
    now: () => 0,
    ...overrides,
  });
}

/** 断言 promise 抛出 AgentRuntimeError，并返回该错误（供进一步断言消息/明细）。 */
async function captureError(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AgentRuntimeError);
  return error as AgentRuntimeError;
}

describe('DeAiRunner：成功路径', () => {
  it('成功直通：text 模式、trim 后返回，provenance 与账本都按 usage 记录', async () => {
    const provider = new FakeTextProvider([], `\n\n${OK_TEXT}\n\n`);
    const budget = new BudgetLedger({}, clock);
    const runner = makeRunner(provider, { budget });

    const result = await runner.humanize(deaiRequest());

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.profile.id).toBe('strong');
    expect(call.responseFormat).toBe('text');
    expect(call.maxOutputTokens).toBe(8000);
    expect(call.system).toBe(PROMPT.system);
    expect(call.input).toContain('style=casual');
    expect(call.input).toContain(`keepCitations=${CITE_A},${CITE_B}`);
    expect(call.input).toContain('target=60-600');
    expect(call.input).toContain('空泛套话');
    expect(call.input).toContain(ORIGINAL_TEXT);

    expect(result.text).toBe(OK_TEXT);
    expect(result.provenance).toEqual({
      profileId: 'strong',
      provider: 'fake',
      model: 'strong-2026-01',
      promptId: 'deai-humanize',
      promptVersion: 2,
      promptSha256: 'sha-deai-test',
      inputTokens: 900,
      outputTokens: 300,
      latencyMs: 0,
      fallbackChain: [],
      cacheHit: false,
    });
    expect(result.cost).toBeCloseTo((900 / 1_000_000) * 10 + (300 / 1_000_000) * 30, 12);
    expect(budget.snapshot().dailyCost).toBeCloseTo(result.cost, 12);
    expect(budget.snapshot().dailyInputTokens).toBe(900);
    expect(budget.snapshot().dailyOutputTokens).toBe(300);
  });

  it('keepCitations 为空时不做引用校验（引用保护只在给定清单时生效）', async () => {
    const provider = new FakeTextProvider([], FABRICATED_TEXT);
    const runner = makeRunner(provider);

    const result = await runner.humanize(deaiRequest({ keepCitations: [] }));

    expect(provider.calls).toHaveLength(1);
    expect(result.text).toBe(FABRICATED_TEXT);
  });
});

describe('DeAiRunner：文本契约（长度 / 引用）', () => {
  it('输出编造了原文没有的引用来源 → 回喂原因重试一次，仍不合规抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider([FABRICATED_TEXT, FABRICATED_TEXT], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('CONTRACT_VIOLATION');
    expect(error.message).toContain('新增了原文没有的引用来源');
    expect(error.message).toContain(CITE_C);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain('上一次改写不合规');
    expect(provider.calls[1]!.input).toContain(CITE_C);
  });

  it('丢失必须保留的引用来源 → 回喂原因重试一次，仍不合规抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider([MISSING_TEXT, MISSING_TEXT], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('CONTRACT_VIOLATION');
    expect(error.message).toContain('丢失了必须保留的引用来源');
    expect(error.message).toContain(CITE_B);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain(CITE_B);
  });

  it('长度过短 → 回喂原因重试一次，仍不合规抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider([TOO_SHORT_TEXT, TOO_SHORT_TEXT], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('CONTRACT_VIOLATION');
    expect(error.message).toContain('不足 60 字');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain('上一次改写不合规');
  });

  it('长度超长 → 回喂原因重试一次，仍不合规抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider([TOO_LONG_TEXT, TOO_LONG_TEXT], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('CONTRACT_VIOLATION');
    expect(error.message).toContain('超过 600 字');
    expect(provider.calls).toHaveLength(2);
  });

  it('契约违规一次后按提示修正成功', async () => {
    const provider = new FakeTextProvider([TOO_SHORT_TEXT, OK_TEXT], OK_TEXT);
    const runner = makeRunner(provider);

    const result = await runner.humanize(deaiRequest());

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain('上一次改写不合规');
    expect(result.text).toBe(OK_TEXT);
    expect(result.provenance.profileId).toBe('strong');
  });

  it('模型成功返回但内容不合规也要记账（两次调用都计入账本）', async () => {
    const provider = new FakeTextProvider([TOO_SHORT_TEXT, TOO_SHORT_TEXT], OK_TEXT);
    const budget = new BudgetLedger({}, clock);
    const runner = makeRunner(provider, { budget });

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('CONTRACT_VIOLATION');
    expect(budget.snapshot().dailyInputTokens).toBe(1800);
    expect(budget.snapshot().dailyOutputTokens).toBe(600);
  });
});

describe('DeAiRunner：错误分类、重试与降级', () => {
  it('超时后按 1000ms 退避重试成功，不降级', async () => {
    const sleeps: number[] = [];
    const provider = new FakeTextProvider([new AgentProviderError('timeout', '模拟超时')], OK_TEXT);
    const runner = makeRunner(provider, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await runner.humanize(deaiRequest());

    expect(provider.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(result.provenance.profileId).toBe('strong');
    expect(result.provenance.fallbackChain).toEqual([]);
  });

  it('重试用尽后降级到下一个 profile，并记录降级链', async () => {
    const sleeps: number[] = [];
    const provider = new FakeTextProvider(
      [new AgentProviderError('timeout', '模拟超时'), new AgentProviderError('rate_limit', '模拟限流')],
      OK_TEXT,
    );
    const runner = makeRunner(provider, {
      maxAttempts: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await runner.humanize(deaiRequest());

    expect(provider.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000]);
    expect(result.provenance.profileId).toBe('mid');
    expect(result.provenance.fallbackChain).toEqual(['strong']);
  });

  it('所有 profile 都失败时抛 ALL_PROFILES_FAILED', async () => {
    const provider = new FakeTextProvider(
      [new AgentProviderError('timeout', '模拟超时'), new AgentProviderError('upstream', '模拟 5xx')],
      OK_TEXT,
    );
    const runner = makeRunner(provider, { maxAttempts: 0 });

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('ALL_PROFILES_FAILED');
    expect(provider.calls).toHaveLength(2);
  });

  it('拒答不重试、不降级，直接抛 REFUSAL', async () => {
    const provider = new FakeTextProvider([new AgentProviderError('refusal', '模拟拒答')], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('REFUSAL');
    expect(provider.calls).toHaveLength(1);
  });

  it('未分类错误转成 PROVIDER_ERROR，不重试', async () => {
    const provider = new FakeTextProvider([new TypeError('网络层异常')], OK_TEXT);
    const runner = makeRunner(provider);

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('DeAiRunner：预算与路由', () => {
  it('预算 preflight 超限时在调用 provider 之前拒绝', async () => {
    const provider = new FakeTextProvider([], OK_TEXT);
    const runner = makeRunner(provider, {
      budget: new BudgetLedger({ taskCostLimit: 0.0000001, dailyCostLimit: 1 }, clock),
    });

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
  });

  it('没有满足能力的 profile 时抛 NO_PROFILE', async () => {
    const provider = new FakeTextProvider([], OK_TEXT);
    // cheap 的上下文只有 32k，达不到 deai 策略要求的 60k
    const runner = makeRunner(provider, { profiles: [profiles[0]!] });

    const error = await captureError(runner.humanize(deaiRequest()));

    expect(error.code).toBe('NO_PROFILE');
    expect(provider.calls).toHaveLength(0);
  });
});
