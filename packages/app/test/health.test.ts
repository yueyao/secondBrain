import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringifyFrontmatter } from '@sb/domain';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { knowledgeHealth } from '../src/health';
import { createArticle } from '../src/compose';

function ctxOf(harness: TestHarness): AppContext {
  return {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: { longTextThreshold: 60_000, enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'] },
  };
}

async function writeNode(
  harness: TestHarness,
  file: string,
  name: string,
  options: { readonly body: string; readonly updatedAt?: string; readonly aliases?: string[] } ,
): Promise<void> {
  const content = stringifyFrontmatter(
    {
      type: 'node', node_type: 'concept', name, aliases: options.aliases ?? [],
      review_status: 'active', updated_at: options.updatedAt ?? '2026-10-31', confirmed: true,
      tags: ['layer/wiki', 'node/concept'],
    },
    options.body,
  );
  await harness.vault.writeNode(file, content);
  await harness.search.refresh();
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('知识库体检（只读）', () => {
  it('基线：mock 节点无断链、无缺失来源，长期主义暂无入链因此是孤立节点', async () => {
    const report = await knowledgeHealth(ctxOf(harness));
    expect(report.nodes).toBe(3);
    expect(report.claims).toBe(3);
    expect(report.brokenLinks).toBe(0);
    expect(report.missingRawLinks).toBe(0);
    expect(report.claimsWithoutSource).toBe(0);
    expect(report.nodesWithoutClaims).toBe(0);
    expect(report.nodesWithoutDefinition).toBe(0);
    // 反应脆弱/安全边际互链；长期主义没有被其他节点引用，也没有文章引用
    expect(report.orphanNodes).toBe(1);
    expect(report.issues.orphanNodes).toContain('长期主义');
  });

  it('发现断链、缺失 raw 来源、无 claims、无定义、无入链的新节点', async () => {
    await writeNode(harness, 'wiki/concepts/测试节点.md', '测试节点', {
      body: [
        '# 测试节点',
        '',
        '## 一句话定义',
        '',
        '## 核心观点',
        '',
        '- 这是一个没有来源标记的判断',
        '',
        '## 相关概念',
        '',
        '- [[不存在的节点]]',
        '- [[raw/不存在/原文.md]]',
        '',
      ].join('\n'),
    });

    const report = await knowledgeHealth(ctxOf(harness));
    expect(report.nodes).toBe(4);
    expect(report.brokenLinks).toBeGreaterThanOrEqual(1);
    expect(report.issues.brokenLinks.some((item) => item.target === '不存在的节点')).toBe(true);
    expect(report.missingRawLinks).toBeGreaterThanOrEqual(1);
    expect(report.claimsWithoutSource).toBe(1);
    expect(report.issues.claimsWithoutSource[0]?.node).toBe('测试节点');
    expect(report.nodesWithoutClaims).toBe(1);
    expect(report.nodesWithoutDefinition).toBe(1);
    expect(report.issues.orphanNodes).toContain('测试节点');
  });

  it('发现重复节点（名称/别名冲突）与重复 claims', async () => {
    await writeNode(harness, 'wiki/concepts/反脆弱-副本.md', '反脆弱', {
      body: [
        '# 反脆弱',
        '',
        '## 一句话定义',
        '',
        '重复定义的节点。',
        '',
        '## 核心观点',
        '',
        '- 反脆弱不是坚强，而是从波动中获益。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）',
        '',
      ].join('\n'),
    });

    const report = await knowledgeHealth(ctxOf(harness));
    expect(report.duplicateNodeGroups).toBeGreaterThanOrEqual(1);
    expect(report.issues.duplicateNodeGroups.some((group) => group.names.includes('反脆弱'))).toBe(true);
    expect(report.duplicateClaims).toBeGreaterThanOrEqual(1);
    expect(report.issues.duplicateClaims[0]?.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('陈旧节点（updated_at 超过 180 天）会被标出', async () => {
    await writeNode(harness, 'wiki/concepts/旧节点.md', '旧节点', {
      updatedAt: '2020-01-01',
      body: [
        '# 旧节点',
        '',
        '## 一句话定义',
        '',
        '一个很早以前的节点。',
        '',
        '## 核心观点',
        '',
        '- 很久以前写下的判断。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）',
        '',
      ].join('\n'),
    });

    const report = await knowledgeHealth(ctxOf(harness));
    expect(report.staleNodes).toBe(1);
    expect(report.issues.staleNodes[0]?.node).toBe('旧节点');
  });

  it('被文章引用的节点不再算孤立节点', async () => {
    const ctx = ctxOf(harness);
    await createArticle(ctx, 'article-health-1', { title: '体检测试文章', theme: '测试', nodeIds: ['长期主义'] });
    const report = await knowledgeHealth(ctx);
    expect(report.orphanNodes).toBe(0);
    expect(report.issues.orphanNodes).not.toContain('长期主义');
  });
});
