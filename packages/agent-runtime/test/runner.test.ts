import { describe, expect, it } from 'vitest';
import { AgentRuntimeError } from '../src/errors';
import { BudgetLedger } from '../src/budget';
import { MemoryCompletionCache } from '../src/cache';
import { FakeProvider } from './fake-provider';
import { clock, digestRequest, makeRunner, profiles, policies } from './fixtures';

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('AgentRunner：成功路径', () => {
  it('调用一次 provider，返回带 provenance 的草稿并记账', async () => {
    const provider = new FakeProvider([]);
    const budget = new BudgetLedger({ taskCostLimit: 1, dailyCostLimit: 100 }, clock);
    const runner = makeRunner(provider, { budget });

    const outcome = await runner.draft(digestRequest());

    expect(provider.calls).toHaveLength(1);
    expect(outcome.proposal.tier).toBe('standard');
    expect(outcome.provenance.profileId).toBe('strong');
    expect(outcome.provenance.provider).toBe('fake');
    expect(outcome.provenance.cacheHit).toBe(false);
    expect(outcome.provenance.inputTokens).toBe(1000);
    expect(outcome.cost).toBeGreaterThan(0);
    expect(budget.snapshot().dailyCost).toBeCloseTo(outcome.cost, 10);
  });

  it('系统提示与输入按 prompt 渲染传入 provider', async () => {
    const provider = new FakeProvider([]);
    const runner = makeRunner(provider);
    await runner.draft(digestRequest({ content: '特定内容' }));
    expect(provider.calls[0]?.system).toBe('你是知识助产士');
    expect(provider.calls[0]?.input).toContain('特定内容');
  });
});

describe('AgentRunner：缓存', () => {
  it('相同输入第二次命中缓存，不再调用 provider、不计费', async () => {
    const provider = new FakeProvider([]);
    const cache = new MemoryCompletionCache();
    const runner = makeRunner(provider, { cache });

    const first = await runner.draft(digestRequest());
    const second = await runner.draft(digestRequest());

    expect(provider.calls).toHaveLength(1);
    expect(first.provenance.cacheHit).toBe(false);
    expect(second.provenance.cacheHit).toBe(true);
    expect(second.cost).toBe(0);
  });

  it('内容不同则缓存不命中', async () => {
    const provider = new FakeProvider([]);
    const runner = makeRunner(provider);
    await runner.draft(digestRequest({ content: '内容 A' }));
    await runner.draft(digestRequest({ content: '内容 B' }));
    expect(provider.calls).toHaveLength(2);
  });
});

describe('AgentRunner：重试与降级', () => {
  it('超时后重试成功，不发生降级', async () => {
    const provider = new FakeProvider(['timeout', 'ok']);
    const runner = makeRunner(provider);

    const outcome = await runner.draft(digestRequest());
    expect(provider.calls).toHaveLength(2);
    expect(outcome.provenance.profileId).toBe('strong');
    expect(outcome.provenance.fallbackChain).toEqual([]);
  });

  it('超时重试用尽后降级到下一个 profile，并记录降级链', async () => {
    const provider = new FakeProvider(['timeout', 'timeout', 'ok']);
    const runner = makeRunner(provider, { maxAttempts: 1 });

    const outcome = await runner.draft(digestRequest());
    expect(provider.calls).toHaveLength(3);
    expect(outcome.provenance.profileId).toBe('mid');
    expect(outcome.provenance.fallbackChain).toEqual(['strong']);
  });

  it('契约违反只重试一次，第二次仍失败则抛 CONTRACT_VIOLATION（不降级）', async () => {
    const provider = new FakeProvider(['invalid', 'invalid']);
    const runner = makeRunner(provider);

    await expectCode(runner.draft(digestRequest()), 'CONTRACT_VIOLATION');
    expect(provider.calls).toHaveLength(2);
  });

  it('契约违反一次后修正成功', async () => {
    const provider = new FakeProvider(['invalid', 'ok']);
    const runner = makeRunner(provider);

    const outcome = await runner.draft(digestRequest());
    expect(provider.calls).toHaveLength(2);
    expect(outcome.proposal.tier).toBe('standard');
  });

  it('拒答不重试、不降级', async () => {
    const provider = new FakeProvider(['refusal']);
    const runner = makeRunner(provider);

    await expectCode(runner.draft(digestRequest()), 'REFUSAL');
    expect(provider.calls).toHaveLength(1);
  });

  it('所有 profile 都失败时抛 ALL_PROFILES_FAILED', async () => {
    const provider = new FakeProvider(['timeout', 'timeout', 'timeout', 'timeout']);
    const runner = makeRunner(provider, { maxAttempts: 1 });

    await expectCode(runner.draft(digestRequest()), 'ALL_PROFILES_FAILED');
  });
});

describe('AgentRunner：预算与路由闸门', () => {
  it('预算超限时在调用 provider 之前就拒绝', async () => {
    const provider = new FakeProvider([]);
    const runner = makeRunner(provider, {
      budget: new BudgetLedger({ taskCostLimit: 0.0000001, dailyCostLimit: 1 }, clock),
    });

    await expectCode(runner.draft(digestRequest()), 'BUDGET_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
  });

  it('没有满足能力的 profile 时抛 NO_PROFILE', async () => {
    const provider = new FakeProvider([]);
    const runner = makeRunner(provider, {
      profiles: [profiles[0]!], // 只有 cheap：缺少 toolCalls
      policies,
    });

    await expectCode(runner.draft(digestRequest()), 'NO_PROFILE');
    expect(provider.calls).toHaveLength(0);
  });

  it('restricted 原文只能走允许 restricted 的 profile', async () => {
    const provider = new FakeProvider([]);
    const runner = makeRunner(provider);
    const outcome = await runner.draft(digestRequest({ sensitivity: 'restricted' }));
    expect(outcome.provenance.profileId).toBe('strong');
  });

  it('错误类型带 code 便于上层分类处理', async () => {
    const provider = new FakeProvider(['refusal']);
    const runner = makeRunner(provider);
    try {
      await runner.draft(digestRequest());
      throw new Error('不应到这里');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      expect((error as AgentRuntimeError).code).toBe('REFUSAL');
    }
  });
});
