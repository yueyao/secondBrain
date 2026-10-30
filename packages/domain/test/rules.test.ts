import { describe, expect, it } from 'vitest';
import { sourceDisabledRule } from '../src/rules/r-source-disabled';
import { sourceAlreadyDigestedRule } from '../src/rules/r-source-already-digested';
import { eventAlreadyDigestedRule } from '../src/rules/r-event-already-digested';
import { eventInQueueRule } from '../src/rules/r-event-in-queue';
import { newNodeNameTakenRule } from '../src/rules/r-new-node-name-taken';
import { nearDuplicateNodeRule } from '../src/rules/r-near-duplicate-node';
import { patchTargetMissingRule } from '../src/rules/r-patch-target-missing';
import { sourceExistsRule } from '../src/rules/r-source-exists';
import { claimCountRule } from '../src/rules/r-claim-count';
import { inferredClaimsRule } from '../src/rules/r-inferred-claims';
import { evaluateAll, findRule, RULES } from '../src/rules/registry';
import { hasBlock, summarizeSeverity } from '../src/model/finding';
import { claim, existingNode, itemRef, node, ruleInput } from './helpers';

describe('规则：来源闸门', () => {
  it('r-source-disabled：禁用来源阻断，启用来源放行', () => {
    expect(sourceDisabledRule.evaluate(ruleInput({ sourceKey: 'newsletters' }))).toMatchObject({
      code: 'SOURCE_DISABLED',
      severity: 'block',
    });
    expect(sourceDisabledRule.evaluate(ruleInput({ sourceKey: 'cubox' }))).toBeNull();
  });

  it('r-source-already-digested：同一 raw 已入库阻断', () => {
    const input = ruleInput({ items: [itemRef('raw/knowledge/cubox/a.md', 'committed')] });
    expect(sourceAlreadyDigestedRule.evaluate(input)).toMatchObject({ code: 'SOURCE_ALREADY_DIGESTED' });
    expect(sourceAlreadyDigestedRule.evaluate(ruleInput({ items: [] }))).toBeNull();
    expect(
      sourceAlreadyDigestedRule.evaluate(ruleInput({ items: [itemRef('raw/knowledge/cubox/other.md', 'committed')] })),
    ).toBeNull();
  });
});

describe('规则：事件级去重', () => {
  it('r-event-already-digested：同事件另一来源已入库 → block', () => {
    const input = ruleInput({
      eventId: 'e999',
      items: [itemRef('raw/knowledge/podcast/b.md', 'committed', 'e999')],
    });
    const finding = eventAlreadyDigestedRule.evaluate(input);
    expect(finding).toMatchObject({ code: 'EVENT_ALREADY_DIGESTED', severity: 'block' });
    expect(finding?.detail?.canonicalRawPath).toBe('raw/knowledge/podcast/b.md');
  });

  it('r-event-already-digested：同一 raw 自身不算"另一来源"', () => {
    const input = ruleInput({
      eventId: 'e999',
      items: [itemRef('raw/knowledge/cubox/a.md', 'committed', 'e999')],
    });
    expect(eventAlreadyDigestedRule.evaluate(input)).toBeNull();
  });

  it('r-event-in-queue：同事件在队列 → warn（不是 block）', () => {
    const input = ruleInput({
      eventId: 'e999',
      items: [itemRef('raw/knowledge/podcast/b.md', 'queued', 'e999')],
    });
    expect(eventInQueueRule.evaluate(input)).toMatchObject({
      code: 'EVENT_IN_QUEUE',
      severity: 'warn',
    });
  });

  it('无 eventId 时两条事件规则都不适用', () => {
    const input = ruleInput({ eventId: null, items: [itemRef('raw/knowledge/podcast/b.md', 'queued', null)] });
    expect(eventAlreadyDigestedRule.evaluate(input)).toBeNull();
    expect(eventInQueueRule.evaluate(input)).toBeNull();
  });
});

describe('规则：节点级去重', () => {
  it('r-new-node-name-taken：同名/同别名阻断', () => {
    const byName = newNodeNameTakenRule.evaluate(
      ruleInput({ nodes: [node('幂律分布')], existingNodes: [existingNode('幂律分布')] }),
    );
    expect(byName).toMatchObject({ code: 'NEW_NODE_NAME_TAKEN', severity: 'block' });

    const byAlias = newNodeNameTakenRule.evaluate(
      ruleInput({ nodes: [node('幂律分布')], existingNodes: [existingNode('幂律', ['幂律分布'])] }),
    );
    expect(byAlias).toMatchObject({ code: 'NEW_NODE_NAME_TAKEN' });
  });

  it('r-new-node-name-taken：patch 动作不触发（本来就该同名）', () => {
    const input = ruleInput({
      nodes: [node('反脆弱', 'patch')],
      existingNodes: [existingNode('反脆弱')],
    });
    expect(newNodeNameTakenRule.evaluate(input)).toBeNull();
  });

  it('r-near-duplicate-node：0.5 边界命中，明显不同不命中', () => {
    const near = nearDuplicateNodeRule.evaluate(
      ruleInput({ nodes: [node('幂律分布')], existingNodes: [existingNode('幂律')] }),
    );
    expect(near).toMatchObject({ code: 'NEW_NODE_NEAR_DUPLICATE', severity: 'warn' });
    expect(near?.detail?.pairs).toEqual([
      { proposed: '幂律分布', existing: '幂律', similarity: 0.5 },
    ]);

    const far = nearDuplicateNodeRule.evaluate(
      ruleInput({ nodes: [node('复利')], existingNodes: [existingNode('幂律')] }),
    );
    expect(far).toBeNull();
  });

  it('r-patch-target-missing：并入目标不存在 → block', () => {
    const missing = patchTargetMissingRule.evaluate(ruleInput({ nodes: [node('不存在的概念', 'patch')] }));
    expect(missing).toMatchObject({ code: 'PATCH_TARGET_MISSING' });

    const ok = patchTargetMissingRule.evaluate(
      ruleInput({ nodes: [node('反脆弱', 'patch')], existingNodes: [existingNode('反脆弱')] }),
    );
    expect(ok).toBeNull();
  });
});

describe('规则：来源链接与配额', () => {
  it('r-source-exists：claim 来源不在已知 raw 集合 → block', () => {
    const input = ruleInput({ claims: [claim('一条判断', 'raw/knowledge/cubox/missing.md')] });
    expect(sourceExistsRule.evaluate(input)).toMatchObject({ code: 'SOURCE_MISSING', severity: 'block' });

    const known = ruleInput({
      claims: [claim('一条判断', 'raw/knowledge/cubox/a.md')],
      knownRawPaths: new Set(['raw/knowledge/cubox/a.md']),
    });
    expect(sourceExistsRule.evaluate(known)).toBeNull();
  });

  it('r-claim-count：超出为 block，低于下限为 warn，区间内为 null', () => {
    const tooMany = ruleInput({ tier: 'standard', claims: Array.from({ length: 16 }, (_, i) => claim(`判断 ${i}`)) });
    expect(claimCountRule.evaluate(tooMany)).toMatchObject({ code: 'CLAIMS_ABOVE_MAX', severity: 'block' });

    const tooFew = ruleInput({ tier: 'standard', claims: [] });
    expect(claimCountRule.evaluate(tooFew)).toMatchObject({ code: 'CLAIMS_BELOW_MIN', severity: 'warn' });

    const inRange = ruleInput({ tier: 'standard', claims: [claim('一条'), claim('两条')] });
    expect(claimCountRule.evaluate(inRange)).toBeNull();
  });

  it('r-inferred-claims：有推断 → warn 并列出样本', () => {
    const input = ruleInput({ claims: [claim('事实判断'), claim('我推测这是对的', 'raw/knowledge/cubox/a.md', true)] });
    const finding = inferredClaimsRule.evaluate(input);
    expect(finding).toMatchObject({ code: 'INFERRED_CLAIMS', severity: 'warn' });
    expect(finding?.detail?.count).toBe(1);
    expect(inferredClaimsRule.evaluate(ruleInput({ claims: [claim('事实判断')] }))).toBeNull();
  });
});

describe('规则注册表', () => {
  it('共 10 条规则，id 唯一且可查', () => {
    expect(RULES).toHaveLength(10);
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(10);
    expect(findRule('r-event-already-digested')).toBeDefined();
    expect(findRule('r-not-exist')).toBeUndefined();
  });

  it('每条规则命中时 ruleId 与自身 id 一致', () => {
    const input = ruleInput({
      sourceKey: 'newsletters',
      eventId: 'e999',
      items: [
        itemRef('raw/knowledge/cubox/a.md', 'committed'),
        itemRef('raw/knowledge/podcast/b.md', 'committed', 'e999'),
      ],
      nodes: [node('幂律分布'), node('不存在的概念', 'patch')],
      existingNodes: [existingNode('幂律分布'), existingNode('幂律')],
      claims: [claim('一条判断', 'raw/knowledge/cubox/missing.md', true)],
    });
    const findings = evaluateAll(input);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(findRule(finding.ruleId)?.id).toBe(finding.ruleId);
    }
  });

  it('输出按 block → warn 排序，并给出整体级别', () => {
    const findings = evaluateAll(
      ruleInput({
        claims: [claim('一条判断', 'raw/knowledge/cubox/missing.md', true)],
      }),
    );
    expect(findings[0]?.severity).toBe('block');
    expect(hasBlock(findings)).toBe(true);
    expect(summarizeSeverity(findings)).toBe('block');
  });

  it('空输入不报错、不产生 finding（规则对缺失上下文是安全的）', () => {
    const findings = evaluateAll(ruleInput({ charCount: 0 }));
    expect(Array.isArray(findings)).toBe(true);
  });
});
