import { sortFindings, type Finding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

import { sourceDisabledRule } from './r-source-disabled';
import { sourceAlreadyDigestedRule } from './r-source-already-digested';
import { eventAlreadyDigestedRule } from './r-event-already-digested';
import { eventInQueueRule } from './r-event-in-queue';
import { newNodeNameTakenRule } from './r-new-node-name-taken';
import { nearDuplicateNodeRule } from './r-near-duplicate-node';
import { patchTargetMissingRule } from './r-patch-target-missing';
import { sourceExistsRule } from './r-source-exists';
import { claimCountRule } from './r-claim-count';
import { inferredClaimsRule } from './r-inferred-claims';

/** 规则注册表：顺序即"explain"输出顺序（最终仍按严重度排序）。 */
export const RULES: readonly Rule<RuleInput>[] = [
  sourceDisabledRule,
  sourceAlreadyDigestedRule,
  eventAlreadyDigestedRule,
  eventInQueueRule,
  newNodeNameTakenRule,
  nearDuplicateNodeRule,
  patchTargetMissingRule,
  sourceExistsRule,
  claimCountRule,
  inferredClaimsRule,
];

export function findRule(id: string): Rule<RuleInput> | undefined {
  return RULES.find((rule) => rule.id === id);
}

/** 对所有规则求值，输出按 block → warn → ok 排序。 */
export function evaluateAll(input: RuleInput): readonly Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const finding = rule.evaluate(input);
    if (finding) findings.push(finding);
  }
  return sortFindings(findings);
}
