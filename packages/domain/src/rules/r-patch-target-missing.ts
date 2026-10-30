import { makeFinding, type Rule } from '../model/finding';
import type { RuleInput } from '../model/rule-input';
import type { NodeChange } from '../model/draft';
import { normalizeText } from '../text';

export const patchTargetMissingRule: Rule<RuleInput> = {
  id: 'r-patch-target-missing',
  defaultSeverity: 'block',
  description: '打算并入的节点不存在时禁止入库（否则会静默变成新建）',
  evaluate(input) {
    const existingNames = new Set(input.existingNodes.map((node) => normalizeText(node.name)));
    const missing = (input.nodes as readonly NodeChange[])
      .filter((node) => node.action === 'patch' && !existingNames.has(normalizeText(node.name)))
      .map((node) => node.name);
    if (missing.length === 0) return null;
    return makeFinding(
      'r-patch-target-missing',
      'block',
      'PATCH_TARGET_MISSING',
      `打算并入但节点不存在：${missing.map((name) => `「${name}」`).join('、')}`,
      { missing },
    );
  },
};
