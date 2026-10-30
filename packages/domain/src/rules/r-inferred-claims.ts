import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

export const inferredClaimsRule: Rule<RuleInput> = {
  id: 'r-inferred-claims',
  defaultSeverity: 'warn',
  description: '含推断型 claim 时必须人工核对（对应"事实与推断分离"能力要求）',
  evaluate(input) {
    const inferred = input.claims.filter((claim) => claim.inference);
    if (inferred.length === 0) return null;
    return makeFinding(
      'r-inferred-claims',
      'warn',
      'INFERRED_CLAIMS',
      `${inferred.length} 条 claim 标记为推断，需核对原文`,
      { count: inferred.length, samples: inferred.slice(0, 3).map((claim) => claim.text.slice(0, 40)) },
    );
  },
};
