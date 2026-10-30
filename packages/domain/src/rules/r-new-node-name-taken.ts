import { makeFinding, type Rule } from '../model/finding';
import type { ExistingNode, RuleInput } from '../model/rule-input';
import type { NodeChange } from '../model/draft';
import { normalizeText } from '../text';

function findByExactName(name: string, existing: readonly ExistingNode[]): ExistingNode | null {
  const normalized = normalizeText(name);
  return (
    existing.find(
      (node) =>
        normalizeText(node.name) === normalized ||
        node.aliases.some((alias) => normalizeText(alias) === normalized),
    ) ?? null
  );
}

export const newNodeNameTakenRule: Rule<RuleInput> = {
  id: 'r-new-node-name-taken',
  defaultSeverity: 'block',
  description: '新建节点与现有节点同名/同别名时禁止入库（否则制造重复节点）',
  evaluate(input) {
    const taken: Array<{ proposed: string; existing: ExistingNode }> = [];
    for (const node of input.nodes as readonly NodeChange[]) {
      if (node.action !== 'new') continue;
      const existing = findByExactName(node.name, input.existingNodes);
      if (existing) taken.push({ proposed: node.name, existing });
    }
    if (taken.length === 0) return null;
    return makeFinding(
      'r-new-node-name-taken',
      'block',
      'NEW_NODE_NAME_TAKEN',
      `新建节点与现有节点同名：${taken.map((t) => `「${t.proposed}」→ ${t.existing.file}`).join('；')}`,
      { taken: taken.map((t) => ({ proposed: t.proposed, existing: t.existing.file, existingName: t.existing.name })) },
    );
  },
};
