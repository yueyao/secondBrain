import { describe, expect, it } from 'vitest';
import { checkClaimCount, TIER_CLAIM_LIMITS } from '../src/policies/tier-policy';

describe('tier-policy v1：claims 配额', () => {
  it('上限：等于上限通过，超过阻断', () => {
    for (const [tier, limits] of Object.entries(TIER_CLAIM_LIMITS)) {
      const atLimit = checkClaimCount(tier as keyof typeof TIER_CLAIM_LIMITS, limits.max);
      expect(atLimit.kind, `${tier} 上限`) .toBe('ok');

      const overLimit = checkClaimCount(tier as keyof typeof TIER_CLAIM_LIMITS, limits.max + 1);
      expect(overLimit.kind).toBe('above_max');
      if (overLimit.kind === 'above_max') {
        expect(overLimit.max).toBe(limits.max);
        expect(overLimit.actual).toBe(limits.max + 1);
      }
    }
  });

  it('下限：0 条触发 below_min', () => {
    const verdict = checkClaimCount('standard', 0);
    expect(verdict.kind).toBe('below_min');
    if (verdict.kind === 'below_min') {
      expect(verdict.min).toBe(1);
      expect(verdict.actual).toBe(0);
    }
  });

  it('档位区间与生产逻辑一致（patch 25 / standard 25 / accelerated 12 / full 60）', () => {
    expect(TIER_CLAIM_LIMITS.patch).toEqual({ min: 1, max: 25 });
    expect(TIER_CLAIM_LIMITS.standard).toEqual({ min: 1, max: 25 });
    expect(TIER_CLAIM_LIMITS.accelerated).toEqual({ min: 1, max: 12 });
    expect(TIER_CLAIM_LIMITS.full).toEqual({ min: 1, max: 60 });
  });
});
