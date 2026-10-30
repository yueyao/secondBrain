import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';

export const sourceExistsRule: Rule<RuleInput> = {
  id: 'r-source-exists',
  defaultSeverity: 'block',
  description: '每条 claim 的来源必须指向真实存在的 raw 文件（领域层只接受已解析的路径集合）',
  evaluate(input) {
    const missing = [...new Set(input.claims.map((claim) => claim.source))].filter(
      (source) => !input.knownRawPaths.has(source),
    );
    if (missing.length === 0) return null;
    return makeFinding(
      'r-source-exists',
      'block',
      'SOURCE_MISSING',
      `claims 的来源不存在：${missing.join('、')}`,
      { missing },
    );
  },
};
