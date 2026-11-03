import { describe, expect, it } from 'vitest';
import {
  bigrams,
  countChars,
  countJudgmentSentences,
  diceSimilarity,
  extractCitationSources,
  normalizeText,
  splitSentences,
  stripMarkdown,
  truncate,
} from '../src/text';

describe('文本工具（确定性、可复现）', () => {
  it('stripMarkdown 去掉标题行，避免把标题拼进第一句', () => {
    const input = '# 幂律分布与头部效应\n\n幂律分布是指少数个体占据绝大部分总量。';
    expect(stripMarkdown(input)).not.toContain('幂律分布与头部效应');
    expect(stripMarkdown(input)).toContain('幂律分布是指');
  });

  it('countJudgmentSentences 不把标题计入判断句', () => {
    const withHeading = '# 标题：本质与边界\n\n这是一个判断，因为它揭示了机制。';
    const withoutHeading = '这是一个判断，因为它揭示了机制。';
    expect(countJudgmentSentences(withHeading)).toBe(countJudgmentSentences(withoutHeading));
    expect(countJudgmentSentences(withHeading)).toBe(1);
  });

  it('判断句需要 12-160 字且含判断标记', () => {
    expect(countJudgmentSentences('太短了。')).toBe(0);
    expect(countJudgmentSentences('这是一句没有标记的普通长句子，长度足够但没有关键词。')).toBe(0);
    expect(countJudgmentSentences('关键是把冗余当成保险，而不是成本。')).toBe(1);
  });

  it('countChars 按码点计数（emoji 不拆成两半）', () => {
    expect(countChars('a😀')).toBe(2);
    expect(countChars('中文')).toBe(2);
  });

  it('splitSentences 按中文标点切分', () => {
    expect(splitSentences('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('normalizeText 去掉空白与标点，用于名称比较', () => {
    expect(normalizeText('幂律 分布。')).toBe('幂律分布');
    expect(normalizeText('Agent Security')).toBe('agentsecurity');
  });

  it('diceSimilarity：0 到 1、对称、边界正确', () => {
    expect(diceSimilarity('幂律', '幂律')).toBe(1);
    expect(diceSimilarity('幂律', '复利')).toBe(0);
    expect(diceSimilarity('幂律分布', '幂律')).toBeCloseTo(0.5, 5);
    expect(diceSimilarity('幂律', '幂律分布')).toBeCloseTo(diceSimilarity('幂律分布', '幂律'), 10);
    expect(diceSimilarity('', '幂律')).toBe(0);
  });

  it('bigrams 对单字符返回空集（不做无意义的相似度）', () => {
    expect(bigrams('单').size).toBe(0);
    expect(bigrams('幂律').size).toBe(1);
  });

  it('truncate 按码点截断并加省略号', () => {
    expect(truncate('一二三四五', 3)).toBe('一二三…');
    expect(truncate('一二', 3)).toBe('一二');
  });

  it('extractCitationSources 按出现顺序去重，只认 raw/ 前缀', () => {
    const body = [
      '幂律分布解释了头部效应（来源：[[raw/knowledge/cubox/a.md]]）。',
      '复利需要时间（来源：[[raw/knowledge/cubox/b.md]]）。',
      '再次引用同一来源（来源：[[raw/knowledge/cubox/a.md]]）。',
      '不是引用的括号（来源：[[wiki/concepts/幂律]]）应被忽略。',
    ].join('\n');
    expect(extractCitationSources(body)).toEqual([
      'raw/knowledge/cubox/a.md',
      'raw/knowledge/cubox/b.md',
    ]);
  });

  it('extractCitationSources 兼容半角括号与冒号，没有标记时返回空数组', () => {
    expect(extractCitationSources('一句话(来源: [[raw/x.md]])。')).toEqual(['raw/x.md']);
    expect(extractCitationSources('没有任何引用。')).toEqual([]);
  });
});
