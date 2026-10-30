import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';
import { checkClaimCount, TIER_CLAIM_LIMITS } from '../policies/tier-policy';

export const claimCountRule: Rule<RuleInput> = {
  id: 'r-claim-count',
  defaultSeverity: 'block',
  description: 'claims 数量必须落在档位区间：超出为阻断，不足为提醒',
  evaluate(input) {
    const verdict = checkClaimCount(input.tier, input.claims.length);
    const limits = TIER_CLAIM_LIMITS[input.tier];
    if (verdict.kind === 'above_max') {
      return makeFinding(
        'r-claim-count',
        'block',
        'CLAIMS_ABOVE_MAX',
        `${input.tier} 档位最多 ${limits.max} 条 claims，实际 ${verdict.actual} 条`,
        { tier: input.tier, max: limits.max, actual: verdict.actual },
      );
    }
    if (verdict.kind === 'below_min') {
      return makeFinding(
        'r-claim-count',
        'warn',
        'CLAIMS_BELOW_MIN',
        `${input.tier} 档位至少 ${limits.min} 条 claims，实际 ${verdict.actual} 条（可考虑改档或补充）`,
        { tier: input.tier, min: limits.min, actual: verdict.actual },
      );
    }
    return null;
  },
};
