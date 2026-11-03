/**
 * MockDeAi：确定性的「去 AI 味」mock 实现（不调用模型、零 I/O）。
 *
 * 只做两件事：
 * 1) 按替换表把常见框架路标词 / AI 黑话换成口语表达（或直接删除）；
 * 2) 保护 `（来源：[[raw/...]]）` 引用标记，并按应用层给定的目标长度区间做
 *    回补（只回补原文）或按自然句边界截断。
 *
 * 用途：mock 模式下的本地演示、app 用例测试、e2e 测试；输出可复现（同输入同输出）。
 */
import type { AgentProvenance, DeAiPort, DeAiRequest, DeAiResult } from '@sb/contracts';
import { CITATION_MARKER } from '@sb/domain';

/**
 * 常见 AI 味 → 口语表达替换表（目标为空串表示删除）。
 *
 * 使用前按匹配串长度降序排序：保证「综上所述，」先于「总之」、「首先，」先于「首先」，
 * 避免长词被短词截胡产生半截替换。
 */
const BASE_REWRITES: readonly (readonly [string, string])[] = [
  // —— 框架路标词（带逗号形式优先，替换为口语连接）——
  ['值得注意的是，', '有意思的是，'],
  ['值得一提的是，', '有意思的是，'],
  ['需要指出的是，', '要说的是，'],
  ['综上所述，', '这么看下来，'],
  ['总而言之，', '说到底，'],
  ['总的来说，', '总体看，'],
  ['由此可见，', '看得出，'],
  ['不难发现，', '能看出来，'],
  ['不可否认，', '确实，'],
  ['毋庸置疑，', '不用怀疑，'],
  ['众所周知，', '大家都知道，'],
  ['换句话说，', '也就是说，'],
  ['简而言之，', '简单说，'],
  ['与此同时，', '同时，'],
  ['首先，', '先说，'],
  ['其次，', '再看，'],
  ['再次，', '还有，'],
  ['最后，', '末了，'],
  ['此外，', '另外，'],
  ['再者，', '还有，'],
  ['归根结底，', '说到底，'],
  ['一方面，', '一面，'],
  ['另一方面，', '另一面，'],
  // —— 框架路标词（无逗号形式）——
  ['值得注意的是', '有意思的是'],
  ['需要指出的是', '要说的是'],
  ['综上所述', '这么看下来'],
  ['总而言之', '说到底'],
  ['由此可见', '看得出'],
  ['不难发现', '能看出来'],
  ['不可否认', '确实'],
  ['毋庸置疑', '不用怀疑'],
  ['众所周知', '大家都知道'],
  ['换句话说', '也就是说'],
  ['与此同时', '同时'],
  ['归根结底', '说到底'],
  ['首先', '先说'],
  ['其次', '再看'],
  ['再次', '还有'],
  ['最后', '末了'],
  ['此外', '另外'],
  ['再者', '还有'],
  // —— AI 黑话 / 大词 → 人话 ——
  ['底层逻辑', '基本道理'],
  ['深入探讨', '仔细看'],
  ['至关重要', '很关键'],
  ['不可或缺', '少不了'],
  ['降本增效', '省钱提效'],
  ['认知升级', '想明白'],
  ['颗粒度', '细节'],
  ['护城河', '优势'],
  ['全链路', '从头到尾'],
  ['一站式', '一步到位'],
  ['多维度', '多个角度'],
  ['全方位', '全面'],
  ['干货满满', '内容实在'],
  ['长期主义', '看长期'],
  ['赋能', '帮助'],
  ['打造', '做'],
  ['构建', '搭'],
  ['助力', '帮'],
  ['抓手', '方法'],
  ['闭环', '循环'],
  ['极致', '很'],
  ['聚焦', '专注'],
  ['洞察', '看懂'],
  ['引领', '带着'],
  ['重塑', '改'],
  ['彰显', '显示'],
  ['凸显', '露出'],
  // —— 纯过渡套话：直接删除（连后面的逗号一起删，避免留下孤立标点）——
  ['一言以蔽之，', ''],
  ['需要说明的是，', ''],
];

const REWRITE_TABLE: readonly (readonly [string, string])[] = [...BASE_REWRITES].sort(
  (left, right) => right[0].length - left[0].length,
);

/** 仅由标点 / 空白组成的片段没有信息量，删除后直接丢弃。 */
const ONLY_PUNCTUATION = /^[\s。！？；，、,.!?;：:]*$/u;

function charCount(text: string): number {
  return [...text].length;
}

/**
 * 按句末标点与换行切句，保留分隔符（用于截断时只落在自然句边界）。
 * 换行本身归到前一句，因此段落结构在改写后不变。
 */
function splitPieces(text: string): readonly string[] {
  return text.split(/(?<=[。！？；\n])/u).filter((piece) => piece.length > 0);
}

/** 删除式替换后的收尾：去掉孤立开头标点、合并重复逗号。 */
function tidyAfterDelete(text: string): string {
  const output = text
    .replace(/[，、,]{2,}/gu, '，')
    .replace(/^[，、,；;：:]+/u, '');
  return ONLY_PUNCTUATION.test(output) ? '' : output;
}

/** 改写不含引用标记的普通片段；引用标记由调用方原样拼回。 */
function rewriteFreeText(text: string): string {
  if (text.length === 0) return text;
  let output = text;
  for (const [from, to] of REWRITE_TABLE) {
    if (output.includes(from)) output = output.split(from).join(to);
  }
  return tidyAfterDelete(output);
}

/**
 * 改写一个句子：按引用标记切片段，只改普通片段。
 * 这样「首先……（来源：[[raw/x]]）」里的引用标记保持逐字节不变，
 * 而同一个句子里其它位置的框架词仍会被替换。
 *
 * 注意不能用 `String.split(/(...)/)` 切：正则里带分组时 split 只保留捕获组，
 * 会把整个标记替换成捕获到的路径；这里手工扫描，完整保留 match[0]。
 */
function rewritePiece(piece: string): string {
  const segments: { readonly text: string; readonly citation: boolean }[] = [];
  let cursor = 0;
  for (const match of piece.matchAll(CITATION_MARKER)) {
    const index = match.index;
    if (index > cursor) segments.push({ text: piece.slice(cursor, index), citation: false });
    segments.push({ text: match[0], citation: true });
    cursor = index + match[0].length;
  }
  if (cursor < piece.length) segments.push({ text: piece.slice(cursor), citation: false });
  return segments.map((segment) => (segment.citation ? segment.text : rewriteFreeText(segment.text))).join('');
}

/**
 * 长度超上限时按自然句边界截断：取尽量多的完整句子。
 * 极端情况下（第一句就超上限，或完整句子前缀不足下限）退化为按码点截断，
 * 保证输出仍落在目标区间内——正常应用层按 0.7~1.4 倍给定区间，不会走到这里。
 */
function truncateAtSentence(sentences: readonly string[], minChars: number, maxChars: number): string {
  let output = '';
  for (const sentence of sentences) {
    if (charCount(output + sentence) > maxChars) break;
    output += sentence;
  }
  if (charCount(output) >= minChars) return output;
  return [...sentences.join('')].slice(0, maxChars).join('');
}

export class MockDeAi implements DeAiPort {
  async humanize(request: DeAiRequest): Promise<DeAiResult> {
    const pieces = splitPieces(request.text).map((original) => {
      const rewritten = rewritePiece(original);
      return { original, rewritten, changed: rewritten !== original };
    });

    const minChars = Math.max(0, request.target.minChars);
    const maxChars = Math.max(minChars, request.target.maxChars);
    const texts = pieces.map((piece) => piece.rewritten);
    let length = charCount(texts.join(''));

    // 低于下限：按原顺序把被改写的句子恢复成原文（只回补已有内容，不编造）；
    // 若原文本身就不足 minChars，则最多只能返回原文。
    if (length < minChars) {
      for (let index = 0; index < pieces.length && length < minChars; index++) {
        const piece = pieces[index];
        if (piece === undefined || !piece.changed) continue;
        length += charCount(piece.original) - charCount(piece.rewritten);
        texts[index] = piece.original;
      }
    }

    let text = texts.join('');
    if (charCount(text) > maxChars) text = truncateAtSentence(texts, minChars, maxChars);

    return {
      text,
      provenance: this.provenance(charCount(request.text), charCount(text)),
      cost: 0,
    };
  }

  private provenance(inputChars: number, outputChars: number): AgentProvenance {
    return {
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: 'deai',
      promptVersion: 1,
      promptSha256: 'mock',
      inputTokens: 400 + Math.ceil(inputChars * 0.7),
      outputTokens: Math.ceil(outputChars * 0.7),
      latencyMs: 400,
      fallbackChain: [],
      cacheHit: false,
    };
  }
}
