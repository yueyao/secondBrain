import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

export const sourceDisabledRule: Rule<RuleInput> = {
  id: 'r-source-disabled',
  defaultSeverity: 'block',
  description: '来源未在 source-scope 中启用时，不允许入库',
  evaluate(input) {
    if (input.enabledSources.includes(input.sourceKey)) return null;
    return makeFinding(
      'r-source-disabled',
      'block',
      'SOURCE_DISABLED',
      `来源「${input.sourceKey}」已被禁用，先改 source-scope 配置`,
      { sourceKey: input.sourceKey, enabledSources: [...input.enabledSources] },
    );
  },
};
