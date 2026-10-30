/**
 * 纯文本工具：领域层唯一的"文本理解"能力，全部是确定性函数。
 * 注意：这里不做语义判断——语义交给模型；这里只做可复现的计数与相似度。
 */

/** 与 MVP 保持一致的判断标记，供 triage 策略计数使用。 */
export const JUDGMENT_MARKERS: readonly string[] = [
  '不是',
  '而是',
  '本质',
  '关键是',
  '意味着',
  '因为',
  '所以',
  '取决于',
  '复利',
  '代价',
  '前提',
  '边界',
  '应该',
  '风险',
];

export function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function countChars(input: string): number {
  return [...input].length;
}

/** 去掉标题行、强调符号、列表符号，避免把 "# 标题" 拼进第一条句子。 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim();
}

export function splitSentences(input: string): readonly string[] {
  return input
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？；])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** 抽出"像判断"的句子（长度 12-160 且含判断标记），供 triage 策略与 mock agent 使用。 */
export function judgmentSentences(input: string): readonly string[] {
  const text = stripMarkdown(input);
  return splitSentences(text).filter((sentence) => {
    if (sentence.length < 12 || sentence.length > 160) return false;
    return JUDGMENT_MARKERS.some((marker) => sentence.includes(marker));
  });
}

export function countJudgmentSentences(input: string): number {
  const text = stripMarkdown(input);
  return splitSentences(text).filter((sentence) => {
    if (sentence.length < 12 || sentence.length > 160) return false;
    return JUDGMENT_MARKERS.some((marker) => sentence.includes(marker));
  }).length;
}

export function bigrams(input: string): ReadonlySet<string> {
  const chars = [...normalizeText(input)];
  const set = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const left = chars[i];
    const right = chars[i + 1];
    if (left !== undefined && right !== undefined) set.add(left + right);
  }
  return set;
}

/** Dice 系数：0-1，用于"近义节点"预警（设计文档 §4.3 r-near-duplicate-node）。 */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection++;
  return (2 * intersection) / (left.size + right.size);
}

export function truncate(input: string, maxChars: number): string {
  const chars = [...input];
  return chars.length <= maxChars ? input : `${chars.slice(0, maxChars).join('')}…`;
}
