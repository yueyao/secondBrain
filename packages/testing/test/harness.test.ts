import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, parseRawPath } from '@sb/domain';
import { createHarness } from '../src/harness';
import { MOCK_RAW } from '../src/fixtures';

const rawPath = (value: string) => {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe('测试环境 createHarness', () => {
  it('建出真实 git 仓库、种子提交、索引可用', async () => {
    const harness = await createHarness();
    try {
      const raws = await harness.vault.listRaw();
      expect(raws).toHaveLength(MOCK_RAW.length + 1);
      expect(harness.seedCommit).toBeTruthy();
      const hits = await harness.search.query('反脆弱');
      expect(hits[0]?.matchType).toBe('name_exact');
      expect(harness.store).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it('cleanup 会删除临时目录', async () => {
    const harness = await createHarness();
    const root = harness.root;
    await harness.cleanup();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('MockAgent 对带 node_hint 的原文产出 patch', async () => {
    const harness = await createHarness();
    try {
      const target = MOCK_RAW[0]!;
      const content = await harness.vault.readRaw(rawPath(target.path));
      const { body } = parseFrontmatter(content);
      const hits = await harness.search.query('反脆弱');
      const proposal = await harness.agent.draft({
        rawPath: rawPath(target.path),
        content,
        retrieved: hits,
        tools: ['search_wiki', 'read_node', 'read_raw'],
        budget: { maxInputTokens: 40_000, maxOutputTokens: 4_000, maxToolCalls: 6 },
      });
      expect(proposal.tier).toBe('patch');
      expect(proposal.nodes[0]?.name).toBe('反脆弱');
      expect(proposal.claims.length).toBeGreaterThan(0);
      expect(proposal.claims.length).toBeLessThanOrEqual(5);
      expect(body.length).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});
