import { describe, expect, it } from 'vitest';
import type { ComposeNodeMaterial, ComposeRequest } from '@sb/contracts';
import { BudgetLedger } from '../src/budget';
import { ComposeRunner, type ComposePromptSpec, type ComposeRunnerOptions } from '../src/compose-runner';
import { AgentProviderError } from '../src/errors';
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

const NODES: readonly ComposeNodeMaterial[] = [
  {
    name: '反脆弱',
    nodeType: 'concept',
    claims: [{ text: '反脆弱不是坚强，而是从波动中获益。', source: 'raw/knowledge/cubox/a.md' }],
  },
  {
    name: '长期主义',
    nodeType: 'concept',
    claims: [{ text: '长期主义不是坚持得久，而是让选择进入复利轨道。', source: 'raw/knowledge/cubox/b.md' }],
  },
];

const OUTLINE_OK = [
  '# 测试文章',
  '',
  '## 一、反脆弱',
  '- 反脆弱不是坚强，而是从波动中获益',
  '## 二、长期主义',
  '- 长期主义不是坚持得久，而是让选择进入复利轨道',
  '## 三、边界与例外',
  '- 区分适用边界，避免把结论当成口号',
  '## 四、行动建议',
  '- 把判断落到可执行的取舍上',
].join('\n');

const LONG_SENTENCE = '反脆弱不是坚强，而是从波动中获益；冗余必须分层，第一层保命，第二层保机会。';

const BODY_OK = [
  '# 测试文章',
  '',
  '## 一、反脆弱',
  `${LONG_SENTENCE.repeat(3)}（来源：[[raw/knowledge/cubox/a.md]]）`,
  '',
  '## 二、长期主义',
  `${'长期主义不是坚持得久，而是让选择进入复利轨道；中断一次不是少赚，而是把曲线打回原点。'.repeat(3)}（来源：[[raw/knowledge/cubox/b.md]]）`,
].join('\n');

/** 长度够但只有一个去重来源：正文引用校验应判不合规。 */
const BODY_ONE_SOURCE = [
  '# 测试文章',
  '',
  '## 一、反脆弱',
  `${LONG_SENTENCE.repeat(5)}（来源：[[raw/knowledge/cubox/a.md]]）`,
  '',
  `${LONG_SENTENCE.repeat(2)}再次引用同一来源（来源：[[raw/knowledge/cubox/a.md]]）。`,
].join('\n');

function promptFor(kind: 'outline' | 'body'): ComposePromptSpec {
  return {
    id: `compose-${kind}`,
    version: 1,
    sha256: 'sha-test',
    system: `你是${kind === 'outline' ? '大纲' : '正文'}编辑`,
    render: (request) =>
      [
        `kind=${request.kind}`,
        `title=${request.title}`,
        `theme=${request.theme}`,
        `outline=${request.outline ?? ''}`,
        ...request.nodes.map((node) => `${node.name}:${node.claims.map((claim) => claim.text).join('|')}`),
      ].join('\n'),
  };
}

const PROMPTS = { outline: promptFor('outline'), body: promptFor('body') };

function composeRequest(overrides: Partial<ComposeRequest> = {}): ComposeRequest {
  return { kind: 'outline', title: '测试文章', theme: '长期主义', outline: null, nodes: NODES, instruction: null, ...overrides };
}

function makeComposer(provider: CompletionProvider, overrides: Partial<ComposeRunnerOptions> = {}): ComposeRunner {
  return new ComposeRunner({
    provider,
    profiles,
    policies,
    budget: new BudgetLedger({}, clock),
    clock,
    prompts: PROMPTS,
    sleep: async () => undefined,
    now: () => 0,
    ...overrides,
  });
}

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('ComposeRunner：成功路径', () => {
  it('大纲走 text 模式，返回文本、空引用与 provenance，并按 usage 记账', async () => {
    const provider = new FakeTextProvider([], OUTLINE_OK);
    const budget = new BudgetLedger({}, clock);
    const composer = makeComposer(provider, { budget });

    const result = await composer.write(composeRequest());

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.responseFormat).toBe('text');
    expect(provider.calls[0]?.maxOutputTokens).toBe(8000);
    expect(provider.calls[0]?.system).toBe('你是大纲编辑');
    expect(provider.calls[0]?.input).toContain('title=测试文章');
    expect(result.text).toBe(OUTLINE_OK);
    expect(result.citations).toEqual([]);
    expect(result.provenance).toEqual({
      profileId: 'strong',
      provider: 'fake',
      model: 'strong-2026-01',
      promptId: 'compose-outline',
      promptVersion: 1,
      promptSha256: 'sha-test',
      inputTokens: 900,
      outputTokens: 300,
      latencyMs: 0,
      fallbackChain: [],
      cacheHit: false,
    });
    expect(result.cost).toBeCloseTo((900 / 1_000_000) * 10 + (300 / 1_000_000) * 30, 10);
    expect(budget.snapshot().dailyCost).toBeCloseTo(result.cost, 10);
  });

  it('正文返回按来源去重的 citations（source 为 raw 路径，text 留空）', async () => {
    const provider = new FakeTextProvider([], BODY_OK);
    const composer = makeComposer(provider);

    const result = await composer.write(composeRequest({ kind: 'body', outline: OUTLINE_OK }));

    expect(provider.calls[0]?.responseFormat).toBe('text');
    expect(result.text).toBe(BODY_OK);
    expect(result.citations).toEqual([
      { source: 'raw/knowledge/cubox/a.md', text: '' },
      { source: 'raw/knowledge/cubox/b.md', text: '' },
    ]);
    expect(result.provenance.promptId).toBe('compose-body');
  });
});

describe('ComposeRunner：重试与降级', () => {
  it('超时后按 1000ms 退避重试成功，不发生降级', async () => {
    const sleeps: number[] = [];
    const provider = new FakeTextProvider([new AgentProviderError('timeout', '模拟超时')], OUTLINE_OK);
    const composer = makeComposer(provider, { sleep: async (ms) => {
      sleeps.push(ms);
    } });

    const result = await composer.write(composeRequest());

    expect(provider.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(result.provenance.profileId).toBe('strong');
    expect(result.provenance.fallbackChain).toEqual([]);
  });

  it('重试用尽后降级到下一个 profile，并记录降级链', async () => {
    const sleeps: number[] = [];
    const provider = new FakeTextProvider(
      [new AgentProviderError('timeout', '模拟超时'), new AgentProviderError('rate_limit', '模拟限流')],
      OUTLINE_OK,
    );
    const composer = makeComposer(provider, { maxAttempts: 1, sleep: async (ms) => {
      sleeps.push(ms);
    } });

    const result = await composer.write(composeRequest());

    expect(provider.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000]);
    expect(result.provenance.profileId).toBe('mid');
    expect(result.provenance.fallbackChain).toEqual(['strong']);
  });

  it('所有 profile 都失败时抛 ALL_PROFILES_FAILED', async () => {
    const provider = new FakeTextProvider(
      [new AgentProviderError('timeout', '模拟超时'), new AgentProviderError('upstream', '模拟 5xx')],
      OUTLINE_OK,
    );
    const composer = makeComposer(provider, { maxAttempts: 0 });

    await expectCode(composer.write(composeRequest()), 'ALL_PROFILES_FAILED');
    expect(provider.calls).toHaveLength(2);
  });

  it('拒答不重试、不降级，直接抛 REFUSAL', async () => {
    const provider = new FakeTextProvider([new AgentProviderError('refusal', '模拟拒答')], OUTLINE_OK);
    const composer = makeComposer(provider);

    await expectCode(composer.write(composeRequest()), 'REFUSAL');
    expect(provider.calls).toHaveLength(1);
  });

  it('未分类错误转成 PROVIDER_ERROR', async () => {
    const provider = new FakeTextProvider([new TypeError('网络层异常')], OUTLINE_OK);
    const composer = makeComposer(provider);

    await expectCode(composer.write(composeRequest()), 'PROVIDER_ERROR');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('ComposeRunner：文本契约与预算', () => {
  it('契约违规带提示重试一次，再违规抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider(['太短', '还是太短'], OUTLINE_OK);
    const budget = new BudgetLedger({}, clock);
    const composer = makeComposer(provider, { budget });

    await expectCode(composer.write(composeRequest()), 'CONTRACT_VIOLATION');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.input).toContain('上一次输出不合规');
    // 两次调用都成功返回（只是内容不合规），都要记账
    expect(budget.snapshot().dailyInputTokens).toBe(1800);
  });

  it('契约违规一次后修正成功', async () => {
    const provider = new FakeTextProvider(['太短', OUTLINE_OK], OUTLINE_OK);
    const composer = makeComposer(provider);

    const result = await composer.write(composeRequest());
    expect(provider.calls).toHaveLength(2);
    expect(result.text).toBe(OUTLINE_OK);
  });

  it('正文引用不足（去重后 <2）触发重试，补齐后成功', async () => {
    const provider = new FakeTextProvider([BODY_ONE_SOURCE, BODY_OK], OUTLINE_OK);
    const composer = makeComposer(provider);

    const result = await composer.write(composeRequest({ kind: 'body', outline: OUTLINE_OK }));
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.input).toContain('上一次输出不合规');
    expect(result.citations).toHaveLength(2);
  });

  it('正文引用始终不足时抛 CONTRACT_VIOLATION', async () => {
    const provider = new FakeTextProvider([BODY_ONE_SOURCE, BODY_ONE_SOURCE], OUTLINE_OK);
    const composer = makeComposer(provider);

    await expectCode(composer.write(composeRequest({ kind: 'body', outline: OUTLINE_OK })), 'CONTRACT_VIOLATION');
    expect(provider.calls).toHaveLength(2);
  });

  it('预算 preflight 超限时在调用 provider 之前拒绝', async () => {
    const provider = new FakeTextProvider([], OUTLINE_OK);
    const composer = makeComposer(provider, {
      budget: new BudgetLedger({ taskCostLimit: 0.0000001, dailyCostLimit: 1 }, clock),
    });

    await expectCode(composer.write(composeRequest()), 'BUDGET_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
  });

  it('没有满足能力的 profile 时抛 NO_PROFILE', async () => {
    const provider = new FakeTextProvider([], OUTLINE_OK);
    const composer = makeComposer(provider, { profiles: [profiles[0]!] }); // cheap 上下文不足

    await expectCode(composer.write(composeRequest()), 'NO_PROFILE');
    expect(provider.calls).toHaveLength(0);
  });
});
