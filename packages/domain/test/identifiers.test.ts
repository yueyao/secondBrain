import { describe, expect, it } from 'vitest';
import {
  makeNodeId,
  parseCommitSha,
  parseContentHash,
  parseDraftId,
  parseNodeId,
  parseRawPath,
} from '../src/model/identifiers';

describe('branded identifiers', () => {
  it('合法 raw 路径通过', () => {
    const result = parseRawPath('raw/knowledge/podcast/collection 面基/items/mock-E999 长期主义.md');
    expect(result.ok).toBe(true);
  });

  it.each([
    ['缺少 raw/ 前缀', 'knowledge/cubox/a.md'],
    ['不是 .md', 'raw/knowledge/cubox/a.txt'],
    ['绝对路径', '/raw/knowledge/cubox/a.md'],
    ['包含 ..', 'raw/knowledge/../../etc/passwd.md'],
    ['包含 . 段', 'raw/./a.md'],
    ['空段', 'raw//a.md'],
    ['反斜杠', 'raw\\a.md'],
    ['控制字符', 'raw/a\u0000b.md'],
    ['过短', 'raw/a'],
  ])('非法 raw 路径被拒绝：%s', (_label, value) => {
    const result = parseRawPath(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_RAW_PATH');
  });

  it('草稿 id 规则', () => {
    expect(parseDraftId('draft-abc123').ok).toBe(true);
    expect(parseDraftId('draft-abc').ok).toBe(false);
    expect(parseDraftId('abc-def123').ok).toBe(false);
  });

  it('commit sha 规则', () => {
    expect(parseCommitSha('abc1234').ok).toBe(true);
    expect(parseCommitSha('abcdef1234567890abcdef1234567890abcdef12').ok).toBe(true);
    expect(parseCommitSha('XYZ1234').ok).toBe(false);
    expect(parseCommitSha('abc').ok).toBe(false);
  });

  it('content hash 规则', () => {
    const valid = `sha256:${'a'.repeat(64)}`;
    expect(parseContentHash(valid).ok).toBe(true);
    expect(parseContentHash(`sha256:${'a'.repeat(63)}`).ok).toBe(false);
    expect(parseContentHash('md5:abc').ok).toBe(false);
  });

  it('节点 id 禁止 Obsidian 链接保留字符', () => {
    expect(parseNodeId('concept:二元帝国').ok).toBe(true);
    expect(parseNodeId('a[[b]]').ok).toBe(false);
    expect(parseNodeId('a|b').ok).toBe(false);
    expect(parseNodeId('a#b').ok).toBe(false);
    expect(parseNodeId('').ok).toBe(false);
  });

  it('节点 id 规范形式', () => {
    expect(makeNodeId('concept', '二元帝国')).toBe('concept:二元帝国');
  });
});
