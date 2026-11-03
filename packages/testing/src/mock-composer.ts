/**
 * MockComposer：确定性生成大纲 / 正文，供测试与本地 mock 演示使用。
 * 不调用模型、零 I/O；正文按 claims 生成可回溯到 raw 的引用标记。
 */
import type {
  AgentProvenance,
  ArticleCitation,
  ComposeKind,
  ComposeNodeMaterial,
  ComposePort,
  ComposeRequest,
  ComposeResult,
} from '@sb/contracts';
import { CITATION_MARKER, extractCitationSources } from '@sb/domain';

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七'] as const;
/** 节点不足 4 个时补足的小节标题（保证大纲 4-7 节）。 */
const PAD_TOPICS = ['背景与问题', '核心判断', '边界与例外', '行动建议'] as const;
const MIN_SECTIONS = 4;
const MAX_SECTIONS = 7;
const MIN_OUTLINE_CHARS = 80;
const MIN_BODY_CHARS = 400;
const MIN_CITATION_MARKERS = 2;
/** 每节最多引用的 claims 条数（避免 mock 输出过长）。 */
const CLAIMS_PER_SECTION = 3;

interface Section {
  readonly name: string;
  readonly node: ComposeNodeMaterial | null;
}

function charCount(text: string): number {
  return [...text].length;
}

function sectionTitle(section: Section, index: number): string {
  return `## ${CHINESE_NUMERALS[index] ?? String(index + 1)}、${section.name}`;
}

/** 节点按名称成节；不足 4 节时用通用小节补齐，最多 7 节。 */
function planSections(request: ComposeRequest): readonly Section[] {
  const sections: Section[] = request.nodes
    .slice(0, MAX_SECTIONS)
    .map((node) => ({ name: node.name || '未命名节点', node }));
  for (const topic of PAD_TOPICS) {
    if (sections.length >= MIN_SECTIONS) break;
    sections.push({ name: topic, node: null });
  }
  return sections;
}

function themeLabel(request: ComposeRequest): string {
  return request.theme.trim() || request.title.trim() || '这一主题';
}

function citationMarker(source: string): string {
  return `（来源：[[${source}]]）`;
}

function citationCount(text: string): number {
  return [...text.matchAll(CITATION_MARKER)].length;
}

function ensureLength(text: string, minimum: number, filler: string): string {
  let output = text;
  while (charCount(output) < minimum) output += `\n\n${filler}`;
  return output;
}

function outlineText(request: ComposeRequest, sections: readonly Section[]): string {
  const lines: string[] = [`# ${request.title.trim() || '未命名文章'}`, ''];
  for (const [index, section] of sections.entries()) {
    lines.push(sectionTitle(section, index));
    const claims = section.node?.claims ?? [];
    if (claims.length === 0) {
      lines.push(`- 围绕「${section.name}」展开可验证的判断与依据`);
    } else {
      for (const claim of claims.slice(0, CLAIMS_PER_SECTION)) lines.push(`- ${claim.text}`);
    }
    lines.push('');
  }
  return ensureLength(
    lines.join('\n').trim(),
    MIN_OUTLINE_CHARS,
    `以「${themeLabel(request)}」为主线，把节点里的判断组织成可审阅的写作提纲。`,
  );
}

function bodyText(request: ComposeRequest, sections: readonly Section[]): string {
  const lines: string[] = [`# ${request.title.trim() || '未命名文章'}`, ''];
  if (request.theme.trim() !== '') lines.push(`> 主题：${request.theme.trim()}`, '');
  // 改稿指令进入正文，保证 mock 模式下的版本 diff 有实际变化（真实模型由提示词影响行文）
  const instruction = (request.instruction ?? '').trim();
  if (instruction !== '') lines.push(`> 改稿要求：${instruction}`, '');

  for (const [index, section] of sections.entries()) {
    lines.push(sectionTitle(section, index), '');
    const claims = section.node?.claims ?? [];
    for (const claim of claims.slice(0, CLAIMS_PER_SECTION)) {
      const marker = claim.source.startsWith('raw/') ? citationMarker(claim.source) : '';
      const punctuation = /[。！？]$/u.test(claim.text) ? '' : '。';
      lines.push(`${claim.text}${marker}${punctuation}`);
    }
    // 每个小节都补一段围绕主题的展开，既保证篇幅也保证"判断可落地"
    lines.push(
      `这些判断共同指向一个结论：${section.name}不是孤立的概念，而是「${themeLabel(request)}」在具体情境下的一条取舍原则。` +
        '写作时应当先交代它解决的问题，再给出可验证的依据，最后说明适用边界，避免把结论当成口号。',
    );
    lines.push('');
  }

  // 引用兜底：正文至少 2 个引用标记；去重后不足 2 个来源时重复引用同一来源。
  const sources = request.nodes
    .flatMap((node) => node.claims.map((claim) => claim.source))
    .filter((source) => source.startsWith('raw/'));
  const primarySource = sources[0];
  let body = lines.join('\n').trim();
  if (primarySource !== undefined) {
    while (citationCount(body) < MIN_CITATION_MARKERS) {
      body += `\n\n以上判断均可回溯到原文${citationMarker(primarySource)}。`;
    }
  }
  return ensureLength(
    body,
    MIN_BODY_CHARS,
    `围绕「${themeLabel(request)}」写作时，先交代问题，再给出可验证的判断，最后落到可执行的行动，避免只罗列概念。`,
  );
}

export class MockComposer implements ComposePort {
  async write(request: ComposeRequest): Promise<ComposeResult> {
    const sections = planSections(request);
    const text = request.kind === 'outline' ? outlineText(request, sections) : bodyText(request, sections);
    const citations: readonly ArticleCitation[] =
      request.kind === 'body' ? extractCitationSources(text).map((source) => ({ source, text: '' })) : [];
    return { text, citations, provenance: this.provenance(request.kind, request, text), cost: 0 };
  }

  private provenance(kind: ComposeKind, request: ComposeRequest, text: string): AgentProvenance {
    const materialChars = request.nodes.reduce(
      (total, node) => total + node.claims.reduce((sum, claim) => sum + charCount(claim.text), 0),
      0,
    );
    return {
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: `compose-${kind}`,
      promptVersion: 1,
      promptSha256: 'mock',
      inputTokens: 800 + Math.ceil(materialChars * 0.7),
      outputTokens: Math.ceil(charCount(text) * 0.7),
      latencyMs: 500,
      fallbackChain: [],
      cacheHit: false,
    };
  }
}
