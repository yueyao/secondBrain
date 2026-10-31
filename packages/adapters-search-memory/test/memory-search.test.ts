import { describe, expect, it } from 'vitest';
import type { VaultReader } from '@sb/contracts';
import { MemorySearch } from '../src/memory-search';

const FILES: Record<string, string> = {
  'wiki/concepts/反脆弱.md': String.raw`---
type: "node"
node_type: "concept"
name: "反脆弱"
aliases: ["antifragile"]
---
# 反脆弱

反脆弱不是坚强，而是从波动中获益。
`,
  'wiki/concepts/长期主义.md': String.raw`---
type: "node"
node_type: "concept"
name: "长期主义"
aliases: []
---
# 长期主义

长期主义让选择进入复利轨道。
`,
  'wiki/concepts/安全边际.md': String.raw`---
type: "node"
node_type: "concept"
name: "安全边际"
aliases: []
---
# 安全边际

安全边际用价格保护判断错误。
`,
};

const vault: VaultReader = {
  listRaw: async () => [],
  readRaw: async () => '',
  listNodes: async () => Object.keys(FILES),
  readNode: async (file) => FILES[file] ?? '',
  head: async () => null,
  lastCommitMessage: async () => null,
  isClean: async () => true,
};

describe('MemorySearch', () => {
  it('refresh 从 vault 建索引，节点数与文件数一致', async () => {
    const search = new MemorySearch(vault);
    expect(await search.refresh()).toBe(3);
    expect(search.allDocs()).toHaveLength(3);
  });

  it('名称精确命中 100 分', async () => {
    const search = new MemorySearch(vault);
    await search.refresh();
    const hits = await search.query('反脆弱');
    expect(hits[0]).toMatchObject({ name: '反脆弱', score: 100, matchType: 'name_exact' });
  });

  it('别名命中 92 分', async () => {
    const search = new MemorySearch(vault);
    await search.refresh();
    const hits = await search.query('antifragile');
    expect(hits[0]).toMatchObject({ name: '反脆弱', score: 92, matchType: 'alias_exact' });
  });

  it('正文命中 50 分，模糊相似按 Dice 计分', async () => {
    const search = new MemorySearch(vault);
    await search.refresh();
    const body = await search.query('复利');
    expect(body.some((hit) => hit.score === 50 && hit.matchType === 'body')).toBe(true);

    const fuzzy = await search.query('反脆');
    expect(fuzzy[0]?.score).toBeGreaterThan(0);
    expect(fuzzy[0]?.score).toBeLessThan(100);
  });

  it('未命中返回空数组；空查询直接返回空', async () => {
    const search = new MemorySearch(vault);
    await search.refresh();
    expect(await search.query('完全不存在的东西')).toEqual([]);
    expect(await search.query('   ')).toEqual([]);
  });

  it('upsert/remove 维护索引（提交后增量更新用）', async () => {
    const search = new MemorySearch();
    await search.upsert({
      nodeId: 'concept:幂律分布' as never,
      name: '幂律分布',
      aliases: [],
      nodeType: 'concept',
      file: 'wiki/concepts/幂律分布.md',
      body: '',
      updatedAt: '',
    });
    expect(await search.query('幂律分布')).toHaveLength(1);
    await search.remove('concept:幂律分布' as never);
    expect(await search.query('幂律分布')).toEqual([]);
  });
});
