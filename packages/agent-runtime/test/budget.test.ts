import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, costOf, estimateCost } from '../src/budget';
import { clock, cheap, resetNow, setNow } from './fixtures';

afterEach(() => resetNow());

describe('预算：调用前估算', () => {
  it('按字数与预期 claims 估算 token 与成本', () => {
    const estimate = estimateCost({
      charCount: 10_000,
      retrievedChars: 1_000,
      expectedClaims: 8,
      maxOutputTokens: 4_000,
      profile: cheap,
    });
    expect(estimate.inputTokens).toBe(Math.ceil(10_000 * 0.7) + Math.ceil(1_000 * 0.7) + 800);
    expect(estimate.outputTokens).toBe(400 + 8 * 120);
    expect(estimate.cost).toBeGreaterThan(0);
  });

  it('实际成本按 usage 计算，与价格表一致', () => {
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, cheap);
    expect(cost).toBeCloseTo(cheap.pricing.inPerMTokens + cheap.pricing.outPerMTokens, 10);
  });
});

describe('预算：三级闸门', () => {
  it('单次超限：preflight 直接拒绝', () => {
    const ledger = new BudgetLedger({ taskCostLimit: 0.01, dailyCostLimit: 100 }, clock);
    expect(() => ledger.preflight(0.02)).toThrowError(/单次任务成本预估超限/);
  });

  it('每日超限：累计后拒绝新任务', () => {
    const ledger = new BudgetLedger({ taskCostLimit: 1, dailyCostLimit: 0.02 }, clock);
    ledger.record({ cost: 0.015, inputTokens: 100, outputTokens: 10 });
    expect(() => ledger.preflight(0.01)).toThrowError(/每日预算不足/);
    expect(ledger.snapshot().dailyCost).toBeCloseTo(0.015, 10);
  });

  it('跨天自动归零', () => {
    const ledger = new BudgetLedger({ taskCostLimit: 1, dailyCostLimit: 1 }, clock);
    ledger.record({ cost: 0.5, inputTokens: 100, outputTokens: 10 });
    expect(ledger.snapshot().dailyCost).toBeCloseTo(0.5, 10);

    setNow('2026-10-31T00:01:00+08:00');
    expect(ledger.snapshot().dailyCost).toBe(0);
    expect(ledger.snapshot().day).toBe('2026-10-31');
  });
});
