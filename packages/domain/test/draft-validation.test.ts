import { describe, expect, it } from 'vitest';
import { validateDraftProposal } from '../src/draft-validation';

const claims = [
  { text: '这是一条足够长的判断句。', inference: false, source: 'raw/knowledge/cubox/a.md' },
  { text: '这是第二条足够长的判断句。', inference: true, source: 'raw/knowledge/cubox/a.md' },
];

function proposal(claimIndexes: unknown): unknown {
  return {
    tier: 'standard',
    rationale: '测试',
    claims,
    nodes: [{ name: '幂律分布', nodeType: 'concept', action: 'new', definition: '定义', claimIndexes }],
  };
}

describe('草稿校验：节点 ↔ claims 映射（P6.1）', () => {
  it('接受合法下标', () => {
    const result = validateDraftProposal(proposal([1]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodes[0]?.claimIndexes).toEqual([1]);
  });

  it('未提供 claimIndexes 时回退为空数组（渲染时用全部 claims）', () => {
    const raw = proposal(undefined) as { nodes: Array<Record<string, unknown>> };
    const result = validateDraftProposal(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodes[0]?.claimIndexes).toEqual([]);
  });

  it('下标越界被拒绝', () => {
    const result = validateDraftProposal(proposal([2]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('非法下标');
  });

  it('重复下标被拒绝', () => {
    const result = validateDraftProposal(proposal([1, 1]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('重复');
  });

  it('空数组被拒绝', () => {
    const result = validateDraftProposal(proposal([]));
    expect(result.ok).toBe(false);
  });
});
