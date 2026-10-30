import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

export const sourceAlreadyDigestedRule: Rule<RuleInput> = {
  id: 'r-source-already-digested',
  defaultSeverity: 'block',
  description: '同一份 raw 已入库时，不允许再次入库',
  evaluate(input) {
    const same = input.items.find(
      (item) => item.rawPath === input.rawPath && item.stateKind === 'committed',
    );
    if (!same) return null;
    return makeFinding('r-source-already-digested', 'block', 'SOURCE_ALREADY_DIGESTED', '同一份原文已入库', {
      rawPath: same.rawPath,
    });
  },
};
