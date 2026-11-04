import { describe, expect, it } from 'vitest';
import { effectiveBlockingFindings, effectiveFindings } from '../src/review-policy';

describe('审核策略：旧配额 finding', () => {
  it('standard 16 条 claims 的旧 block 降级为 warn，不再阻断', () => {
    const draft = {
      findings: [{
        ruleId: 'r-claim-count', severity: 'block' as const, code: 'CLAIMS_ABOVE_MAX',
        message: 'standard 档位最多 15 条 claims，实际 16 条',
        detail: { tier: 'standard', max: 15, actual: 16 },
      }],
      proposal: { tier: 'standard' as const, claims: new Array(16).fill({}) },
    };
    expect(effectiveBlockingFindings(draft)).toHaveLength(0);
    expect(effectiveFindings(draft)[0]?.severity).toBe('warn');
  });
});
