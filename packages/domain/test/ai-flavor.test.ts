import { describe, expect, it } from 'vitest';
import { AI_FLAVOR_RULES, analyzeAiFlavor, type AiFlavorReport } from '../src/ai-flavor';

/** 只取指定规则：其他规则顺带命中时，测试仍只断言关注项。 */
function findingOf(report: AiFlavorReport, id: string) {
  return report.findings.find((finding) => finding.id === id);
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** 干净样本：具体时间、地点、金额、对话细节，句长有明显起伏，不含 AI 味词表。 */
const CLEAN_TEXT = [
  '十月二十八日下午三点，杭州西湖边的咖啡店只剩两桌客人。',
  '我点了一杯二十三块的美式，店员说豆子来自云南保山，海拔大约一千八百米，今年雨水多，收成比去年少了三成。',
  '隔壁桌两个人在讨论裁员，其中一个说他所在的部门从四十人缩到十七人，赔偿按 N+1 算。',
  '雨停了。',
  '结账时我发现小票上多算了一份可颂，店员退了十二块，又重新打了一张单。',
].join('');

/** 框架路标词 + 句长均匀：验证语言类命中与结构类加权。 */
const FRAME_TEXT =
  '首先，我们需要明确目标。其次，要梳理现有流程。再次，把任务拆成可执行的小步。最后，定期复盘并调整方向。值得注意的是，执行比计划更难。综上所述，这套方法值得坚持。';

/** AI 高频词/黑话密集。 */
const AI_VOCAB_TEXT = '我们要打造闭环，聚焦底层逻辑，赋能生态，形成护城河。';

/** 宏大叙事与意义拔高。 */
const GRANDIOSITY_TEXT =
  '随着大模型的发展，写作门槛迅速降低。这标志着内容生产进入新纪元，也为个人表达注入了新的可能。在当今社会，会写的人更容易被看见。';

/** 六句等长、开头各不相同：只应触发结构规则，不触发排比。 */
const UNIFORM_TEXT =
  '春风吹过河岸。夏雨落满屋檐。秋叶铺满小路。冬雪盖住屋顶。清晨鸟叫很响。傍晚钟声很长。';

/** 三条命中，得 medium（15 + 15 = 30）。 */
const MEDIUM_TEXT =
  '首先，我们要打造闭环。这一点需要反复说明，因为流程里的每个角色都得知道下一步做什么。其次，聚焦底层逻辑。最后，赋能生态。';

/** 多规则叠加，得分应进入 high。 */
const HIGH_TEXT =
  '首先，在当今社会，我们要打造闭环，赋能生态。其次，随着技术的发展，我们要聚焦底层逻辑，形成护城河。最后，这标志着新纪元的到来，令人震撼！此外，行业格局将被重塑，这是革命性的时刻。综上所述，未来可期，让我们拭目以待！';

/** 同时具备数字、引用、口语、第一人称、句长起伏五类人味信号。 */
const HIGHLIGHT_TEXT =
  '说实话，我懂了。去年我跑了 3 场马拉松，最长的一次用了四小时十二分，报名费一千二百块，后来我把这些数字记进日志（来源：[[raw/log/2025.md]]）。就这样吧。';

/** 三条具体信息点，用于验证短例条数上限。 */
const LONG_EXAMPLE_TEXT =
  '这次改版体现了团队对细节的重视，从按钮间距到文案长度都反复调整，连图标的圆角都改了三次。这个版本标志着第一阶段收尾，算是一个小小的里程碑。';

describe('去 AI 味确定性体检', () => {
  it('空文本返回零分与全零指标，不产生命中项', () => {
    const empty = analyzeAiFlavor('');
    expect(empty.score).toBe(0);
    expect(empty.level).toBe('low');
    expect(empty.findings).toEqual([]);
    expect(empty.highlights).toEqual([]);
    expect(empty.metrics).toEqual({
      chars: 0,
      sentences: 0,
      avgSentenceChars: 0,
      sentenceVariation: 0,
      paragraphVariation: 0,
      uniqueBigramRatio: 0,
      colloquialRatio: 0,
      concreteSignalCount: 0,
    });
    expect(empty.genreNote).toContain('公文');

    const blank = analyzeAiFlavor('  \n\t ');
    expect(blank.metrics).toEqual(empty.metrics);
    expect(blank.findings).toEqual([]);
    expect(blank.highlights).toEqual([]);
  });

  it('干净、具体、句长有起伏的文本得低分', () => {
    const report = analyzeAiFlavor(CLEAN_TEXT);
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(0);
    expect(report.level).toBe('low');
    expect(report.metrics.sentenceVariation).toBeGreaterThan(0.45);
    expect(report.metrics.concreteSignalCount).toBeGreaterThan(0);
    expect(report.highlights.map((highlight) => highlight.label)).toContain('句长起伏');
  });

  it('框架路标词堆叠会命中并给出明显档位', () => {
    const report = analyzeAiFlavor(FRAME_TEXT);
    const finding = findingOf(report, 'frame_words');
    expect(finding).toBeDefined();
    expect(finding?.label).toBe('框架路标词');
    expect(finding?.category).toBe('language');
    expect(finding?.weight).toBe(15);
    expect(finding?.count).toBeGreaterThanOrEqual(3);
    expect(finding?.degree).toBe(1);
    expect(finding?.examples.length).toBeLessThanOrEqual(3);
    expect(finding?.advice.length).toBeGreaterThan(0);
    expect(report.score).toBeGreaterThanOrEqual(15);
  });

  it('AI 高频词与黑话按命中次数给档位', () => {
    const report = analyzeAiFlavor(AI_VOCAB_TEXT);
    const finding = findingOf(report, 'ai_vocab');
    expect(finding).toBeDefined();
    expect(finding?.label).toBe('AI 高频词与黑话');
    expect(finding?.category).toBe('language');
    expect(finding?.weight).toBe(15);
    expect(finding?.count).toBeGreaterThanOrEqual(3);
    expect(finding?.degree).toBe(1);
  });

  it('「不是…而是」否定二分会被识别', () => {
    const report = analyzeAiFlavor('这件事不是能力问题，而是资源问题。');
    const finding = findingOf(report, 'antithesis');
    expect(finding).toBeDefined();
    expect(finding?.category).toBe('language');
    expect(finding?.weight).toBe(10);
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(0.5);
    expect(finding?.examples[0]).toContain('不是');
    expect(finding?.examples[0]).toContain('而是');
  });

  it('连续三句同长同开头会按排比计数', () => {
    const report = analyzeAiFlavor('我们要读书。我们要思考。我们要行动。');
    const finding = findingOf(report, 'antithesis');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(0.5);
    expect(finding?.examples[0]).toContain('我们要读书');
  });

  it('同一段出现三个顿号会按并列计数', () => {
    const report = analyzeAiFlavor('他买了苹果、香蕉、橘子、葡萄和西瓜。');
    const finding = findingOf(report, 'antithesis');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(0.5);
    expect(finding?.examples[0]).toContain('葡萄');
  });

  it('宏大叙事与意义拔高命中并进入内容类', () => {
    const report = analyzeAiFlavor(GRANDIOSITY_TEXT);
    const finding = findingOf(report, 'grandiosity');
    expect(finding).toBeDefined();
    expect(finding?.label).toBe('宏大叙事与意义拔高');
    expect(finding?.category).toBe('content');
    expect(finding?.weight).toBe(15);
    expect(finding?.count).toBeGreaterThanOrEqual(3);
    expect(finding?.degree).toBe(1);
  });

  it('宣传腔与夸张词命中', () => {
    const report = analyzeAiFlavor('这场发布会令人叹为观止，产品完美到极致，体验前所未有。');
    const finding = findingOf(report, 'promo');
    expect(finding).toBeDefined();
    expect(finding?.category).toBe('content');
    expect(finding?.weight).toBe(10);
    expect(finding?.count).toBe(4);
    expect(finding?.degree).toBe(1);
  });

  it('套话结尾与对话残留命中', () => {
    const report = analyzeAiFlavor('以上就是全部内容，未来可期，让我们拭目以待。');
    const finding = findingOf(report, 'formulaic');
    expect(finding).toBeDefined();
    expect(finding?.category).toBe('content');
    expect(finding?.weight).toBe(15);
    expect(finding?.count).toBe(3);
    expect(finding?.degree).toBe(1);
  });

  it('句长均匀且句数达到六句时判为满档', () => {
    const report = analyzeAiFlavor(UNIFORM_TEXT);
    const finding = findingOf(report, 'structure');
    expect(report.metrics.sentences).toBe(6);
    expect(report.metrics.sentenceVariation).toBe(0);
    expect(finding).toBeDefined();
    expect(finding?.category).toBe('structure');
    expect(finding?.weight).toBe(10);
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(1);
    expect(finding?.examples[0]).toBe('句长均匀（CV=0.000）');
  });

  it('句数过少的短文本不按句长均匀判定', () => {
    const report = analyzeAiFlavor('今天很好。今天很亮。');
    expect(report.metrics.sentences).toBe(2);
    expect(report.metrics.sentenceVariation).toBe(0);
    expect(findingOf(report, 'structure')).toBeUndefined();
    expect(report.findings).toEqual([]);
  });

  it('emoji、破折号、加粗和感叹号累计为格式痕迹', () => {
    const report = analyzeAiFlavor('这真的是**重点**——不要错过！😀 快来！');
    const finding = findingOf(report, 'punctuation');
    expect(finding).toBeDefined();
    expect(finding?.category).toBe('format');
    expect(finding?.weight).toBe(10);
    expect(finding?.count).toBe(5);
    expect(finding?.degree).toBe(1);
    expect(finding?.examples.length).toBeGreaterThan(0);
    expect(finding?.examples.length).toBeLessThanOrEqual(3);
  });

  it('单个破折号只给半档', () => {
    const report = analyzeAiFlavor('他只说了一句——然后转身走了。');
    const finding = findingOf(report, 'punctuation');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(0.5);
    expect(report.score).toBe(5);
  });

  it('弯引号与直引号混用算一处格式痕迹', () => {
    const report = analyzeAiFlavor('他说“这个方案不错”，我回了一句"再看看"。');
    const finding = findingOf(report, 'punctuation');
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(1);
    expect(finding?.degree).toBe(0.5);
    expect(finding?.examples).toContain('弯引号与直引号混用');
  });

  it('人味信号按固定顺序最多保留四条', () => {
    const report = analyzeAiFlavor(HIGHLIGHT_TEXT);
    const labels = report.highlights.map((highlight) => highlight.label);
    expect(labels).toEqual(['具体数字', '可回溯引用', '口语语气', '句长起伏']);
    expect(report.highlights.length).toBeLessThanOrEqual(4);
    expect(report.highlights.every((highlight) => highlight.text.length > 0)).toBe(true);
    expect(report.metrics.colloquialRatio).toBeGreaterThan(0.5);
    // 第五类信号「第一人称」确实存在，只因上限被裁掉。
    expect(HIGHLIGHT_TEXT).toContain('我');
  });

  it('命中项按权重乘档位降序排列', () => {
    const report = analyzeAiFlavor(HIGH_TEXT);
    const weighted = report.findings.map((finding) => finding.weight * finding.degree);
    expect(weighted).toEqual([...weighted].sort((left, right) => right - left));
    expect(report.findings.every((finding) => finding.degree > 0)).toBe(true);
    expect(report.findings[0]?.weight).toBe(15);
  });

  it('示例截断不超过 60 字且最多 3 条', () => {
    const withThreeExamples = analyzeAiFlavor(LONG_EXAMPLE_TEXT);
    const grandiosity = findingOf(withThreeExamples, 'grandiosity');
    expect(grandiosity?.examples.length).toBe(3);

    // 长加粗片段 + 多个感叹号：命中内容本身超过 60 字，必须被截断。
    const longBold = `**${'很长的加粗文字'.repeat(10)}**！！！！`;
    const longReport = analyzeAiFlavor(longBold);
    const punctuation = findingOf(longReport, 'punctuation');
    expect(punctuation).toBeDefined();
    const clipped = punctuation?.examples[0] ?? '';
    expect(codePointLength(clipped)).toBe(60);
    expect(clipped.endsWith('…')).toBe(true);

    for (const report of [withThreeExamples, longReport]) {
      for (const finding of report.findings) {
        expect(finding.examples.length).toBeLessThanOrEqual(3);
        for (const example of finding.examples) {
          expect(codePointLength(example)).toBeLessThanOrEqual(60);
        }
      }
    }
  });

  it('评分等于加权和，30 分与 60 分按档位归档', () => {
    const clean = analyzeAiFlavor(CLEAN_TEXT);
    const medium = analyzeAiFlavor(MEDIUM_TEXT);
    const high = analyzeAiFlavor(HIGH_TEXT);

    for (const report of [clean, medium, high]) {
      const weighted = report.findings.reduce(
        (sum, finding) => sum + finding.weight * finding.degree,
        0,
      );
      expect(report.score).toBe(Math.min(100, Math.max(0, Math.round(weighted))));
    }

    expect(clean.level).toBe('low');
    expect(medium.score).toBe(30);
    expect(medium.level).toBe('medium');
    expect(high.score).toBeGreaterThan(60);
    expect(high.level).toBe('high');
  });

  it('普通规则按 1-2 次半档、3 次以上满档', () => {
    const one = findingOf(analyzeAiFlavor('打造'), 'ai_vocab');
    const two = findingOf(analyzeAiFlavor('打造构建'), 'ai_vocab');
    const three = findingOf(analyzeAiFlavor('打造构建聚焦'), 'ai_vocab');
    expect(one?.count).toBe(1);
    expect(one?.degree).toBe(0.5);
    expect(two?.count).toBe(2);
    expect(two?.degree).toBe(0.5);
    expect(three?.count).toBe(3);
    expect(three?.degree).toBe(1);
  });

  it('同一文本两次分析结果完全一致', () => {
    const first = analyzeAiFlavor(HIGH_TEXT);
    const second = analyzeAiFlavor(HIGH_TEXT);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('八条规则权重合计 100 且 id 稳定', () => {
    expect(AI_FLAVOR_RULES.map((rule) => rule.id)).toEqual([
      'frame_words',
      'ai_vocab',
      'antithesis',
      'grandiosity',
      'promo',
      'formulaic',
      'structure',
      'punctuation',
    ]);
    expect(AI_FLAVOR_RULES.map((rule) => rule.weight)).toEqual([15, 15, 10, 15, 10, 15, 10, 10]);
    expect(AI_FLAVOR_RULES.reduce((sum, rule) => sum + rule.weight, 0)).toBe(100);
    for (const rule of AI_FLAVOR_RULES) {
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.advice.length).toBeGreaterThan(0);
      expect(Array.isArray(rule.patterns)).toBe(true);
      expect(['content', 'language', 'structure', 'format']).toContain(rule.category);
    }
  });

  it('指标统计字符、句子、口语密度与具体信息点', () => {
    const text = '2026 年有 3 次发布，他说“先等等”，见（来源：[[raw/a.md]]）。';
    const report = analyzeAiFlavor(text);
    expect(report.metrics.chars).toBe(41);
    expect(report.metrics.sentences).toBe(1);
    expect(report.metrics.avgSentenceChars).toBe(41);
    expect(report.metrics.sentenceVariation).toBe(0);
    expect(report.metrics.paragraphVariation).toBe(0);
    expect(report.metrics.uniqueBigramRatio).toBeGreaterThan(0);
    expect(report.metrics.uniqueBigramRatio).toBeLessThanOrEqual(1);
    expect(report.metrics.colloquialRatio).toBe(0);
    expect(report.metrics.concreteSignalCount).toBe(4);

    const twoParagraphs = analyzeAiFlavor('短句。\n\n这是一段明显更长的段落，用来制造段落长度差异。');
    expect(twoParagraphs.metrics.paragraphVariation).toBeGreaterThan(0.5);
  });

  it('报告始终带固定文体提醒', () => {
    const expected =
      '公文、学术论文、新闻通稿的规范用语不算 AI 味；引用、专名、被讨论的词不要改。判断看聚簇，不看孤例。';
    expect(analyzeAiFlavor(CLEAN_TEXT).genreNote).toBe(expected);
    expect(analyzeAiFlavor('').genreNote).toBe(expected);
  });
});
