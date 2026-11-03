/**
 * 「去 AI 味」确定性体检（@sb/domain 纯领域层）。
 *
 * 设计依据（只提炼可执行的 regex 与启发式，不照搬长文）：
 * - Wikipedia:Signs of AI writing：框架路标词、空泛拔高、宣传腔、套话结尾；
 * - 中文 humanizer 清单：AI 高频词/黑话、否定二分、排比对仗；
 * - CCL 2023 量化研究：连接词密度、对偶句频率、语气词密度；
 * - 产品内部「去 AI 味体检官」口径：规则命中给档位，加权求和再分级。
 *
 * 纯度约束（ADR 0002）：零依赖、零 I/O、不读时钟、不 throw；同一文本永远得到同一报告。
 * 这里只统计「可疑信号」，不做语义判断——公文/论文/通稿的规范用语、引用、专名是否需要改，
 * 由人看报告决定（见 genreNote）。
 */
import { countChars, normalizeText } from './text';

export type AiFlavorLevel = 'low' | 'medium' | 'high';

export interface AiFlavorFinding {
  /** 稳定 id，如 'frame_words'：应用层按 id 取消/忽略某类命中。 */
  readonly id: string;
  /** 中文名，如 '框架路标词'。 */
  readonly label: string;
  readonly category: 'content' | 'language' | 'structure' | 'format';
  /** 命中次数（结构类给 1）。 */
  readonly count: number;
  /** 命中档位：0 未命中、0.5 轻度、1 明显。 */
  readonly degree: 0 | 0.5 | 1;
  /** 该规则权重。 */
  readonly weight: number;
  /** ≤3 条原文短例，每条截断 ≤60 字。 */
  readonly examples: readonly string[];
  /** 一句改写建议。 */
  readonly advice: string;
}

export interface AiFlavorMetrics {
  readonly chars: number;
  readonly sentences: number;
  readonly avgSentenceChars: number;
  /** 句长变异系数 CV=std/mean，保留 3 位；越低越均匀。 */
  readonly sentenceVariation: number;
  /** 段落长度 CV（同样保留 3 位）。 */
  readonly paragraphVariation: number;
  /** 字符二元组去重率 0-1。 */
  readonly uniqueBigramRatio: number;
  /** 语气词/口语词密度（每 100 字命中数）。 */
  readonly colloquialRatio: number;
  /** 数字/日期、引号内文本、`[[raw/...]]` 引用等具体信息点计数。 */
  readonly concreteSignalCount: number;
}

export interface AiFlavorHighlight {
  readonly label: string;
  readonly text: string;
}

export interface AiFlavorReport {
  /** 0-100，越高越像 AI。 */
  readonly score: number;
  readonly level: AiFlavorLevel;
  /** 仅命中项，按 weight*degree 降序。 */
  readonly findings: readonly AiFlavorFinding[];
  readonly metrics: AiFlavorMetrics;
  /** 人味信号，≤4 条（有才给）。 */
  readonly highlights: readonly AiFlavorHighlight[];
  /** 文体提醒固定文案。 */
  readonly genreNote: string;
}

/** 文体提醒固定文案：避免把规范文体、引用与专名误判成 AI 味。 */
const GENRE_NOTE =
  '公文、学术论文、新闻通稿的规范用语不算 AI 味；引用、专名、被讨论的词不要改。判断看聚簇，不看孤例。';

/** 单条规则命中的原始证据。 */
interface PatternHit {
  /** UTF-16 下标（String#slice 口径），仅用于按原文顺序取短例。 */
  readonly index: number;
  readonly text: string;
}

/** 一条规则的判定结果。 */
interface RuleEvaluation {
  readonly degree: 0 | 0.5 | 1;
  readonly count: number;
  readonly examples: readonly string[];
}

/** 规则求值上下文：句子/段落只切一次，供 8 条规则共享。 */
interface AnalysisContext {
  readonly text: string;
  readonly metrics: AiFlavorMetrics;
  readonly sentences: readonly string[];
  readonly paragraphs: readonly string[];
}

type RuleEvaluator = (context: AnalysisContext) => RuleEvaluation;

interface RuleDefinition {
  readonly id: string;
  readonly label: string;
  readonly category: AiFlavorFinding['category'];
  readonly weight: number;
  readonly advice: string;
  readonly patterns: readonly RegExp[];
  readonly evaluate: RuleEvaluator;
}

const EXAMPLE_LIMIT = 3;
const EXAMPLE_MAX_CHARS = 60;
/** 短例前后各保留多少字符上下文（码点口径）。 */
const SNIPPET_CONTEXT_CHARS = 12;

const EMPTY_EVALUATION: RuleEvaluation = { degree: 0, count: 0, examples: [] };

/** 四舍五入到指定位数：避免浮点数直接进报告，保证快照测试可复现。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 把任意片段压成一行并截断到 ≤60 字（含省略号占用），同时丢弃被切开的代理对残片。 */
function clipExample(input: string): string {
  const flattened = input.replace(/\s+/g, ' ').trim();
  const safe = [...flattened].filter((char) => !/^[\uD800-\uDFFF]$/.test(char)).join('');
  const chars = [...safe];
  if (chars.length <= EXAMPLE_MAX_CHARS) return safe;
  return `${chars.slice(0, EXAMPLE_MAX_CHARS - 1).join('')}…`;
}

/** 取命中位置前后少量上下文，得到可读的「原文短例」。 */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT_CHARS);
  const matched = text.slice(index, index + length);
  return clipExample(`${text.slice(start, index)}${matched}${text.slice(index + length, end)}`);
}

/**
 * 收集一个正则的全部命中。
 * 用 `new RegExp(source, flags)` 克隆：既不污染模块级 RegExp 的 lastIndex，也保证并发/重复调用确定性。
 */
function findPatternHits(text: string, pattern: RegExp): readonly PatternHit[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  const hits: PatternHit[] = [];
  for (const match of text.matchAll(global)) {
    const matched = match[0];
    if (matched.length === 0) continue;
    hits.push({ index: match.index ?? 0, text: matched });
  }
  return hits;
}

/**
 * 按原文顺序取 ≤3 条去重短例。
 * 命中密集时（如连续多个路标词）取到的上下文会互相重叠，读起来像复读；
 * 这里跳过已覆盖区域的命中，保证每条短例来自不同位置。
 */
function examplesFromHits(text: string, hits: readonly PatternHit[]): readonly string[] {
  const ordered = [...hits].sort((left, right) => left.index - right.index);
  const examples: string[] = [];
  let coveredUntil = -1;
  for (const hit of ordered) {
    if (hit.index < coveredUntil) continue;
    const snippet = snippetAround(text, hit.index, hit.text.length);
    if (snippet.length === 0 || examples.includes(snippet)) continue;
    examples.push(snippet);
    coveredUntil = hit.index + hit.text.length + SNIPPET_CONTEXT_CHARS;
    if (examples.length >= EXAMPLE_LIMIT) break;
  }
  return examples;
}

/** 普通规则的档位：0 次 → 0；1-2 次 → 0.5；≥3 次 → 1。 */
function degreeForCount(count: number): 0 | 0.5 | 1 {
  if (count <= 0) return 0;
  return count <= 2 ? 0.5 : 1;
}

function levelForScore(score: number): AiFlavorLevel {
  if (score < 30) return 'low';
  if (score <= 60) return 'medium';
  return 'high';
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则 1-6 的关键词表。正则都做了有界匹配（不跨句、限制长度），避免灾难回溯。
// ─────────────────────────────────────────────────────────────────────────────

const FRAME_WORD_PATTERNS: readonly RegExp[] = [
  /值得注意的是|值得一提的是|需要指出的是|需要注意的是|不可忽视的是|综上所述|总而言之|总的来说|由此可见|不难发现|不可否认|毋庸置疑|众所周知|换句话说|简而言之|与此同时|归根结底|首先|其次|再次|最后|此外|再者|一方面|另一方面/gu,
];

const AI_VOCAB_PATTERNS: readonly RegExp[] = [
  /底层逻辑|长期主义|认知升级|深入探讨|深度剖析|至关重要|举足轻重|不可或缺|全方位|多维度|一站式|全链路|降本增效|干货满满|赋能|抓手|闭环|颗粒度|护城河|打造|构建|聚焦|洞察|引领|重塑|生态|格局|助力|彰显|凸显|极致|拉满/gu,
];

const ANTITHESIS_PATTERNS: readonly RegExp[] = [
  /不是[^。！？\n]{1,30}?而是/gu,
  /不在于[^。！？\n]{1,30}?而在于/gu,
  /不仅是[^。！？\n]{1,30}?更是/gu,
  /不只是[^。！？\n]{1,30}?还是/gu,
  /与其说[^。！？\n]{1,30}?不如说/gu,
  /并非[^。！？\n]{1,30}?而是/gu,
];

const GRANDIOSITY_PATTERNS: readonly RegExp[] = [
  /随着[^。！？\n]{1,24}?(?:的发展|不断发展|快速|迅速|普及|深入)/gu,
  /在这个[^。！？\n]{1,24}?的时代/gu,
  /在信息爆炸的今天|奠定了坚实基础|(?:产生|带来|造成)深远影响|影响深远|扮演着[^。！？\n]{0,16}?角色|在当今社会|标志着|里程碑|新纪元|新篇章|发挥作用|体现了|彰显了|展现了|充分说明|必将在/gu,
  /全新的时代|崭新的时代|划时代/gu,
  /(?<![因认])为(?!了)[^。！？\n]{1,20}?注入/gu,
];

const PROMO_PATTERNS: readonly RegExp[] = [
  /令人叹为观止|无与伦比|不容错过|前所未有|势不可挡|革命性|史诗级|充满活力|颠覆|震撼|完美|极致|璀璨|蓬勃|(?:一场|深刻的|彻底的|真正的)革命/gu,
];

const FORMULAIC_PATTERNS: readonly RegExp[] = [
  /相信在不久的将来|让我们拭目以待|对未来充满期待|希望对你有帮助|欢迎在评论区|让我们深入了解|接下来我们一起|直接进入正题|展望未来|未来可期|你觉得呢|话不多说|以上就是|以下是/gu,
];

// ─────────────────────────────────────────────────────────────────────────────
// 规则 3 的启发式：排比/对仗不靠词表，靠「连续三句同长同开头」与「同段顿号并列」。
// ─────────────────────────────────────────────────────────────────────────────

/** 常见连接词/发语词：连续三句都以同一个字开头时，视为句式相似的排比。 */
const PARALLEL_CONNECTIVES: readonly string[] = [
  '要', '是', '不', '把', '用', '让', '以', '而', '既', '又', '也', '都',
  '为', '在', '从', '对', '当', '如', '若', '只', '无', '有',
];

const DUNHAO_PATTERN = /、/gu;

/** 三句开头是否「同款」：前两字相同，或首字是同一个常见连接词。 */
function haveSameOpening(sentences: readonly string[]): boolean {
  const heads = sentences.map((sentence) => [...sentence].slice(0, 2).join(''));
  const firstHead = heads[0];
  if (firstHead === undefined) return false;
  if (firstHead.length === 2 && heads.every((head) => head === firstHead)) return true;

  const firstChars = sentences.map((sentence) => [...sentence][0]);
  const firstChar = firstChars[0];
  return (
    firstChar !== undefined &&
    PARALLEL_CONNECTIVES.includes(firstChar) &&
    firstChars.every((char) => char === firstChar)
  );
}

/** 连续 3 句字数差 ≤2 且开头同款：按 1 处排比计。返回首句作为短例（保持原文顺序）。 */
function findParallelTriplets(sentences: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (let index = 0; index + 2 < sentences.length; index += 1) {
    const first = sentences[index];
    const second = sentences[index + 1];
    const third = sentences[index + 2];
    if (first === undefined || second === undefined || third === undefined) continue;

    const group = [first, second, third] as const;
    const lengths = group.map((sentence) => countChars(sentence));
    if (Math.max(...lengths) - Math.min(...lengths) > 2) continue;
    if (haveSameOpening(group)) found.push(first);
  }
  return found;
}

/** 同一段出现 ≥3 个顿号：按 1 处并列排比计，返回该段文本作短例。 */
function findEnumerationParagraphs(paragraphs: readonly string[]): readonly string[] {
  return paragraphs.filter((paragraph) => findPatternHits(paragraph, DUNHAO_PATTERN).length >= 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则 8 的标点/格式信号。
// ─────────────────────────────────────────────────────────────────────────────

const EMOJI_PATTERN = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const DASH_PATTERN = /—+/gu;
const BOLD_PATTERN = /\*\*[^*\n]{1,80}\*\*/gu;
const EXCLAMATION_PATTERN = /[！!]/gu;
const CURLY_QUOTE_PATTERN = /[“”‘’]/gu;
const STRAIGHT_QUOTE_PATTERN = /["']/gu;

const PUNCTUATION_RULE_PATTERNS: readonly RegExp[] = [
  EMOJI_PATTERN,
  DASH_PATTERN,
  BOLD_PATTERN,
  EXCLAMATION_PATTERN,
];

// ─────────────────────────────────────────────────────────────────────────────
// 指标与高亮用到的词表。
// ─────────────────────────────────────────────────────────────────────────────

const COLLOQUIAL_PATTERN =
  /说白了|说实话|老实说|说到底|其实|倒是|反正|居然|竟然|罢了|而已|吧|嘛|啊|呀|呢|呗|啦|咋|啥|甭|蛮|挺/gu;

const FIRST_PERSON_PATTERN = /我们|我/gu;

/** 数字或日期：日期优先整体算一处，避免「2026-11-03」被拆成 3 个数字。 */
const NUMBER_OR_DATE_PATTERN =
  /(?:\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?|\d+(?:\.\d+)?%?)/gu;

const QUOTED_TEXT_PATTERN =
  /“[^”\n]{1,80}”|「[^」\n]{1,80}」|『[^』\n]{1,80}』|"[^"\n]{1,80}"/gu;

const RAW_REFERENCE_PATTERN = /\[\[raw\/[^\]\n]+\]\]/gu;

// ─────────────────────────────────────────────────────────────────────────────
// 8 条规则的求值器。
// ─────────────────────────────────────────────────────────────────────────────

function makePatternEvaluator(patterns: readonly RegExp[]): RuleEvaluator {
  return (context) => evaluateByPatterns(context.text, patterns);
}

function evaluateByPatterns(text: string, patterns: readonly RegExp[]): RuleEvaluation {
  const hits = patterns.flatMap((pattern) => findPatternHits(text, pattern));
  if (hits.length === 0) return EMPTY_EVALUATION;
  return {
    degree: degreeForCount(hits.length),
    count: hits.length,
    examples: examplesFromHits(text, hits),
  };
}

/** 规则 3：否定二分句式（词表）+ 连续排比/顿号并列（启发式）合并计数。 */
function evaluateAntithesis(context: AnalysisContext): RuleEvaluation {
  const { text } = context;
  const patternHits = ANTITHESIS_PATTERNS.flatMap((pattern) => findPatternHits(text, pattern));
  const triplets = findParallelTriplets(context.sentences);
  const enumerations = findEnumerationParagraphs(context.paragraphs);
  const count = patternHits.length + triplets.length + enumerations.length;
  if (count === 0) return EMPTY_EVALUATION;

  const examples = [...examplesFromHits(text, patternHits)];
  for (const sample of [...triplets, ...enumerations]) {
    if (examples.length >= EXAMPLE_LIMIT) break;
    const clipped = clipExample(sample);
    if (clipped.length > 0 && !examples.includes(clipped)) examples.push(clipped);
  }
  return { degree: degreeForCount(count), count, examples: examples.slice(0, EXAMPLE_LIMIT) };
}

/** 规则 7：句长均匀（用 metrics 判定，不数关键词）。 */
function evaluateStructure(context: AnalysisContext): RuleEvaluation {
  const { metrics } = context;
  // 句数太少的 CV 没有统计意义，也避免把两三句正常短文本判成模板段落。
  if (metrics.sentences < 3) return EMPTY_EVALUATION;

  const cv = metrics.sentenceVariation;
  if (cv < 0.3 && metrics.sentences >= 6) {
    return { degree: 1, count: 1, examples: [`句长均匀（CV=${cv.toFixed(3)}）`] };
  }
  if (cv < 0.45) {
    return { degree: 0.5, count: 1, examples: [`句长均匀（CV=${cv.toFixed(3)}）`] };
  }
  return EMPTY_EVALUATION;
}

/** 规则 8：emoji、破折号、加粗、感叹号、弯直引号混用合并计数。 */
function evaluatePunctuation(context: AnalysisContext): RuleEvaluation {
  const { text } = context;
  const emojiHits = findPatternHits(text, EMOJI_PATTERN);
  const dashHits = findPatternHits(text, DASH_PATTERN);
  const boldHits = findPatternHits(text, BOLD_PATTERN);
  const exclamationHits = findPatternHits(text, EXCLAMATION_PATTERN);
  const curlyQuoteHits = findPatternHits(text, CURLY_QUOTE_PATTERN);
  const straightQuoteHits = findPatternHits(text, STRAIGHT_QUOTE_PATTERN);
  const mixedQuote = curlyQuoteHits.length > 0 && straightQuoteHits.length > 0;

  const count =
    emojiHits.length +
    dashHits.length +
    boldHits.length +
    exclamationHits.length +
    (mixedQuote ? 1 : 0);
  if (count === 0) return EMPTY_EVALUATION;

  const ordered = [...emojiHits, ...dashHits, ...boldHits, ...exclamationHits].sort(
    (left, right) => left.index - right.index,
  );
  const examples: string[] = [];
  let coveredUntil = -1;
  for (const hit of ordered) {
    if (hit.index < coveredUntil) continue;
    const snippet = snippetAround(text, hit.index, hit.text.length);
    if (snippet.length === 0 || examples.includes(snippet)) continue;
    examples.push(snippet);
    coveredUntil = hit.index + hit.text.length + SNIPPET_CONTEXT_CHARS;
    if (examples.length >= EXAMPLE_LIMIT) break;
  }
  if (mixedQuote && examples.length < EXAMPLE_LIMIT) examples.push('弯引号与直引号混用');
  return { degree: degreeForCount(count), count, examples: examples.slice(0, EXAMPLE_LIMIT) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则注册表（权重合计 100，顺序即同分时的展示顺序）。
// ─────────────────────────────────────────────────────────────────────────────

const RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: 'frame_words',
    label: '框架路标词',
    category: 'language',
    weight: 15,
    advice: '删掉路标词，让句子靠内容自己衔接。',
    patterns: FRAME_WORD_PATTERNS,
    evaluate: makePatternEvaluator(FRAME_WORD_PATTERNS),
  },
  {
    id: 'ai_vocab',
    label: 'AI 高频词与黑话',
    category: 'language',
    weight: 15,
    advice: '把抽象名词换成具体动作、对象或数字，少用行业套话。',
    patterns: AI_VOCAB_PATTERNS,
    evaluate: makePatternEvaluator(AI_VOCAB_PATTERNS),
  },
  {
    id: 'antithesis',
    label: '否定二分与排比对仗',
    category: 'language',
    weight: 10,
    advice: '少用「不是…而是」的二段式；直接说结论，必要时给例子。',
    patterns: ANTITHESIS_PATTERNS,
    evaluate: evaluateAntithesis,
  },
  {
    id: 'grandiosity',
    label: '宏大叙事与意义拔高',
    category: 'content',
    weight: 15,
    advice: '去掉意义拔高，落到人物、时间、金额、后果等具体事实。',
    patterns: GRANDIOSITY_PATTERNS,
    evaluate: makePatternEvaluator(GRANDIOSITY_PATTERNS),
  },
  {
    id: 'promo',
    label: '宣传腔与夸张',
    category: 'content',
    weight: 10,
    advice: '把宣传式形容词换成可验证的事实，或直接删掉。',
    patterns: PROMO_PATTERNS,
    evaluate: makePatternEvaluator(PROMO_PATTERNS),
  },
  {
    id: 'formulaic',
    label: '套话结尾与对话残留',
    category: 'content',
    weight: 15,
    advice: '删掉开场/收尾套话，直接从第一件具体的事写起。',
    patterns: FORMULAIC_PATTERNS,
    evaluate: makePatternEvaluator(FORMULAIC_PATTERNS),
  },
  {
    id: 'structure',
    label: '句长均匀与模板段落',
    category: 'structure',
    weight: 10,
    advice: '有意打散句长：长句讲清因果，短句下判断。',
    patterns: [],
    evaluate: evaluateStructure,
  },
  {
    id: 'punctuation',
    label: '标点与格式痕迹',
    category: 'format',
    weight: 10,
    advice: '统一引号与标点，限量使用破折号、感叹号和 emoji。',
    patterns: PUNCTUATION_RULE_PATTERNS,
    evaluate: evaluatePunctuation,
  },
];

/**
 * 规则清单（对外只读快照）：app/server/agent-runtime 都用同一份规则元数据，
 * 不要在调用侧复制关键词，避免规则漂移。
 */
export const AI_FLAVOR_RULES: readonly {
  readonly id: string;
  readonly label: string;
  readonly category: AiFlavorFinding['category'];
  readonly weight: number;
  readonly advice: string;
  readonly patterns: readonly RegExp[];
}[] = RULE_DEFINITIONS.map((rule) => ({
  id: rule.id,
  label: rule.label,
  category: rule.category,
  weight: rule.weight,
  advice: rule.advice,
  patterns: rule.patterns,
}));

// ─────────────────────────────────────────────────────────────────────────────
// 指标计算。
// ─────────────────────────────────────────────────────────────────────────────

/** 句子切分：任务口径 `(?<=[。！？；\n])`；先归一 CRLF，避免 Windows 文本多出一句。 */
function splitSentences(text: string): readonly string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？；\n])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** 段落按空行切。 */
function splitParagraphs(text: string): readonly string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** 均值与变异系数（总体标准差 / 均值），保留 3 位；空数组返回全 0。 */
function meanAndVariation(values: readonly number[]): { readonly average: number; readonly variation: number } {
  if (values.length === 0) return { average: 0, variation: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  const mean = total / values.length;
  if (mean === 0) return { average: 0, variation: 0 };
  const squared = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const standardDeviation = Math.sqrt(squared / values.length);
  return { average: round(mean, 3), variation: round(standardDeviation / mean, 3) };
}

/** 字符二元组去重率：先去空白/标点/符号（复用 text.ts 的归一化），再算 unique/total。 */
function uniqueBigramRatio(text: string): number {
  const chars = [...normalizeText(text)];
  if (chars.length < 2) return 0;
  const unique = new Set<string>();
  let total = 0;
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const left = chars[index];
    const right = chars[index + 1];
    if (left === undefined || right === undefined) continue;
    total += 1;
    unique.add(`${left}${right}`);
  }
  return total === 0 ? 0 : round(unique.size / total, 3);
}

/** 口语/语气词密度：每 100 字命中数。 */
function colloquialRatio(text: string, chars: number): number {
  if (chars === 0) return 0;
  const hits = findPatternHits(text, COLLOQUIAL_PATTERN).length;
  return round((hits / chars) * 100, 3);
}

/** 具体信息点：数字/日期 + 引号内文本 + `[[raw/...]]` 引用。 */
function countConcreteSignals(text: string): number {
  return (
    findPatternHits(text, NUMBER_OR_DATE_PATTERN).length +
    findPatternHits(text, QUOTED_TEXT_PATTERN).length +
    findPatternHits(text, RAW_REFERENCE_PATTERN).length
  );
}

function computeMetrics(
  text: string,
  sentences: readonly string[],
  paragraphs: readonly string[],
): AiFlavorMetrics {
  const chars = countChars(text);
  const sentenceStats = meanAndVariation(sentences.map((sentence) => countChars(sentence)));
  const paragraphStats = meanAndVariation(paragraphs.map((paragraph) => countChars(paragraph)));
  return {
    chars,
    sentences: sentences.length,
    avgSentenceChars: sentenceStats.average,
    sentenceVariation: sentenceStats.variation,
    paragraphVariation: paragraphStats.variation,
    uniqueBigramRatio: uniqueBigramRatio(text),
    colloquialRatio: colloquialRatio(text, chars),
    concreteSignalCount: countConcreteSignals(text),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 人味信号（highlights）：有才给，按固定顺序最多 4 条。
// ─────────────────────────────────────────────────────────────────────────────

function collectHighlights(context: AnalysisContext): readonly AiFlavorHighlight[] {
  const { text, metrics } = context;
  const highlights: AiFlavorHighlight[] = [];

  const numberHits = findPatternHits(text, NUMBER_OR_DATE_PATTERN);
  if (numberHits.length > 0) {
    const evidence = numberHits.slice(0, 2).map((hit) => hit.text).join('、');
    highlights.push({ label: '具体数字', text: clipExample(evidence) });
  }

  const rawHits = findPatternHits(text, RAW_REFERENCE_PATTERN);
  const quoteHits = findPatternHits(text, QUOTED_TEXT_PATTERN);
  const reference = rawHits[0] ?? quoteHits[0];
  if (reference !== undefined) {
    highlights.push({ label: '可回溯引用', text: snippetAround(text, reference.index, reference.text.length) });
  }

  if (metrics.colloquialRatio > 0.5) {
    const colloquialHits = findPatternHits(text, COLLOQUIAL_PATTERN);
    const first = colloquialHits[0];
    highlights.push({
      label: '口语语气',
      text:
        first !== undefined
          ? snippetAround(text, first.index, first.text.length)
          : `口语词密度 ${metrics.colloquialRatio}/百字`,
    });
  }

  if (metrics.sentenceVariation > 0.5) {
    highlights.push({ label: '句长起伏', text: `句长变异系数 ${metrics.sentenceVariation}` });
  }

  const firstPersonHits = findPatternHits(text, FIRST_PERSON_PATTERN);
  const firstPerson = firstPersonHits[0];
  if (firstPerson !== undefined) {
    highlights.push({ label: '第一人称', text: snippetAround(text, firstPerson.index, firstPerson.text.length) });
  }

  return highlights.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// 对外入口。
// ─────────────────────────────────────────────────────────────────────────────

function emptyReport(): AiFlavorReport {
  return {
    score: 0,
    level: 'low',
    findings: [],
    metrics: {
      chars: 0,
      sentences: 0,
      avgSentenceChars: 0,
      sentenceVariation: 0,
      paragraphVariation: 0,
      uniqueBigramRatio: 0,
      colloquialRatio: 0,
      concreteSignalCount: 0,
    },
    highlights: [],
    genreNote: GENRE_NOTE,
  };
}

/**
 * 体检入口：纯函数，同文本永远同结果；空/纯空白文本返回零分与全零指标。
 * 评分 = round(Σ weight×degree)，clamp 0-100；level：<30 low、30-60 medium、>60 high。
 */
export function analyzeAiFlavor(text: string): AiFlavorReport {
  if (text.trim().length === 0) return emptyReport();

  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(text);
  const metrics = computeMetrics(text, sentences, paragraphs);
  const context: AnalysisContext = { text, metrics, sentences, paragraphs };

  const findings: AiFlavorFinding[] = [];
  for (const rule of RULE_DEFINITIONS) {
    const evaluation = rule.evaluate(context);
    if (evaluation.degree === 0) continue;
    findings.push({
      id: rule.id,
      label: rule.label,
      category: rule.category,
      count: evaluation.count,
      degree: evaluation.degree,
      weight: rule.weight,
      examples: evaluation.examples.slice(0, EXAMPLE_LIMIT),
      advice: rule.advice,
    });
  }

  // weight*degree 降序；同分按规则声明顺序（显式 tie-break，避免依赖引擎排序稳定性）。
  const ruleOrder = new Map<string, number>(
    RULE_DEFINITIONS.map((rule, index) => [rule.id, index] as const),
  );
  findings.sort((left, right) => {
    const weightedDegree = right.weight * right.degree - left.weight * left.degree;
    if (weightedDegree !== 0) return weightedDegree;
    return (ruleOrder.get(left.id) ?? 0) - (ruleOrder.get(right.id) ?? 0);
  });

  const weighted = findings.reduce((sum, finding) => sum + finding.weight * finding.degree, 0);
  const score = Math.min(100, Math.max(0, Math.round(weighted)));

  return {
    score,
    level: levelForScore(score),
    findings,
    metrics,
    highlights: collectHighlights(context),
    genreNote: GENRE_NOTE,
  };
}
