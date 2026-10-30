import { makeFinding, type Rule } from '../model/finding';
import type { ExistingNode, RuleInput } from '../model/rule-input';
import type { NodeChange } from '../model/draft';
import { diceSimilarity, normalizeText } from '../text';

export const NEAR_DUPLICATE_THRESHOLD = 0.5;

export const nearDuplicateNodeRule: Rule<RuleInput> = {
  id: 'r-near-duplicate-node',
  defaultSeverity: 'warn',
  description: '新建节点与现有节点高度相似时，提示可能应该并入而不是新建',
  evaluate(input) {
    const pairs: Array<{ proposed: string; existing: ExistingNode; similarity: number }> = [];
    for (const node of input.nodes as readonly NodeChange[]) {
      if (node.action !== 'new') continue;
      let best: { existing: ExistingNode; similarity: number } | null = null;
      for (const existing of input.existingNodes) {
        if (normalizeText(existing.name) === normalizeText(node.name)) continue; // 同名由 block 规则处理
        const similarity = diceSimilarity(node.name, existing.name);
        if (similarity >= NEAR_DUPLICATE_THRESHOLD && (best === null || similarity > best.similarity)) {
          best = { existing, similarity };
        }
      }
      if (best) pairs.push({ proposed: node.name, existing: best.existing, similarity: best.similarity });
    }
    if (pairs.length === 0) return null;
    return makeFinding(
      'r-near-duplicate-node',
      'warn',
      'NEW_NODE_NEAR_DUPLICATE',
      `新建节点疑似近义：${pairs
        .map((p) => `「${p.proposed}」≈「${p.existing.name}」(${p.similarity.toFixed(2)})`)
        .join('；')}`,
      { pairs: pairs.map((p) => ({ proposed: p.proposed, existing: p.existing.name, similarity: Number(p.similarity.toFixed(3)) })) },
    );
  },
};
