import { describe, expect, it } from 'vitest';
import type { DeAiRequest } from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { MockDeAi } from '../src/mock-deai';

/** 一段 AI 味很重的文本：框架路标词 + 黑话 + 两条独立引用。 */
const AI_TEXT = [
  '首先，我们需要打造一个从想法到落地的闭环，赋能一线团队。',
  '其次，底层逻辑至关重要，构建统一抓手才能助力协作。',
  '此外，值得注意的是，极致体验不可或缺，深入探讨之后还要形成闭环。',
  '最后，综上所述，我们打造的方案由此可见有效，不难发现它的价值。',
  '与此同时，换句话说，众所周知，不可否认，再者，归根结底，这些判断都要落回具体动作。',
  '这些判断来自实际项目复盘。（来源：[[raw/knowledge/cubox/a.md]]）',
  '另一条依据见团队访谈记录。（来源：[[raw/knowledge/cubox/b.md]]）',
].join('');

/** 参考实现里必须被清掉的 AI 味词（注释里说明用途：逐词断言比整句比对更稳）。 */
const AI_FLAVOR_WORDS = [
  '首先',
  '其次',
  '此外',
  '综上所述',
  '值得注意的是',
  '最后',
  '打造',
  '闭环',
  '赋能',
  '底层逻辑',
  '抓手',
  '极致',
  '不可或缺',
  '深入探讨',
  '至关重要',
  '助力',
  '构建',
  '由此可见',
  '不难发现',
  '不可否认',
  '众所周知',
  '换句话说',
  '与此同时',
  '再者',
  '归根结底',
] as const;

const charCount = (text: string): number => [...text].length;

/** 构造一个默认目标区间为原文 0.7~1.4 倍的改写请求。 */
function request(overrides: Partial<DeAiRequest> = {}): DeAiRequest {
  const text = overrides.text ?? AI_TEXT;
  const length = charCount(text);
  return {
    text,
    title: '测试文章',
    style: 'auto',
    issues: [],
    keepCitations: extractCitationSources(text),
    target: { minChars: Math.floor(length * 0.7), maxChars: Math.ceil(length * 1.4) },
    instruction: null,
    ...overrides,
  };
}

describe('MockDeAi：去 AI 味', () => {
  it('去掉框架路标词与 AI 黑话，替换为口语表达', async () => {
    const result = await new MockDeAi().humanize(request());

    for (const word of AI_FLAVOR_WORDS) {
      expect(result.text, `不应残留 AI 味词：${word}`).not.toContain(word);
    }
    // 替换成口语连接而不是简单删空
    expect(result.text).toContain('先说');
    expect(result.text).toContain('循环');
    // mock 不花钱
    expect(result.cost).toBe(0);
  });

  it('引用标记原样保留：只改写引用之外的片段', async () => {
    const text =
      '首先，这条判断来自实际项目复盘（来源：[[raw/knowledge/cubox/a.md]]）。' +
      '其次，另一条依据见访谈记录（来源：[[raw/knowledge/cubox/b.md]]）。';
    const result = await new MockDeAi().humanize(request({ text }));

    // 引用标记逐字节不变，来源顺序不变
    expect(result.text).toContain('（来源：[[raw/knowledge/cubox/a.md]]）');
    expect(result.text).toContain('（来源：[[raw/knowledge/cubox/b.md]]）');
    expect(extractCitationSources(result.text)).toEqual([
      'raw/knowledge/cubox/a.md',
      'raw/knowledge/cubox/b.md',
    ]);
    // 同一个句子里的框架词仍会被替换
    expect(result.text).not.toContain('首先');
    expect(result.text).toContain('先说');
  });

  it('输出长度落在目标区间内（短 / 中 / 长文本）', async () => {
    const longText = [
      '这段话先说清楚问题，再给出依据，最后落到具体动作，不堆砌形容词。',
      '判断的依据是实际做过的项目，不是听起来漂亮的结论。',
      '写下来的每个观点都要能追溯，做不到就先不写。',
      ...Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段补充材料来自一线访谈记录，保留原始细节。`),
    ].join('');
    for (const text of [AI_TEXT, longText]) {
      const result = await new MockDeAi().humanize(request({ text }));
      const length = charCount(text);
      expect(charCount(result.text)).toBeGreaterThanOrEqual(Math.floor(length * 0.7));
      expect(charCount(result.text)).toBeLessThanOrEqual(Math.ceil(length * 1.4));
    }
  });

  it('目标上限很小时按自然句边界截断', async () => {
    const result = await new MockDeAi().humanize(request({ text: AI_TEXT, target: { minChars: 60, maxChars: 100 } }));

    expect(charCount(result.text)).toBeGreaterThanOrEqual(60);
    expect(charCount(result.text)).toBeLessThanOrEqual(100);
  });

  it('替换后低于目标下限时按原顺序回补原文句子，不编造新内容', async () => {
    const sentence = '一言以蔽之，先把具体的事做起来。';
    const text = sentence.repeat(12);
    const length = charCount(text);
    const result = await new MockDeAi().humanize(
      request({ text, target: { minChars: Math.floor(length * 0.9), maxChars: length } }),
    );

    expect(charCount(result.text)).toBeGreaterThanOrEqual(Math.floor(length * 0.9));
    expect(charCount(result.text)).toBeLessThanOrEqual(length);
    // 回补的是原文句子，不是模型编的内容
    expect(result.text).toContain('一言以蔽之，');
  });

  it('确定性：同输入两次结果与 provenance 完全一致', async () => {
    const deAi = new MockDeAi();
    const first = await deAi.humanize(request());
    const second = await deAi.humanize(request());

    expect(second).toEqual(first);
    expect(first.provenance).toEqual({
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: 'deai',
      promptVersion: 1,
      promptSha256: 'mock',
      inputTokens: expect.any(Number) as number,
      outputTokens: expect.any(Number) as number,
      latencyMs: 400,
      fallbackChain: [],
      cacheHit: false,
    });
    expect(first.provenance.inputTokens).toBeGreaterThan(0);
    expect(first.provenance.outputTokens).toBeGreaterThan(0);
  });
});
