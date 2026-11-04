/**
 * MockQa：确定性的「问答链」mock 实现（不调用模型、零 I/O）。
 *
 * 从材料里抽取 claims（`- 判断（来源：[[raw/...]]）`），按请求数量生成
 * `### Qn.` + 四段（结论/形式化/论证步/边界）的问答链；输出可复现。
 * 用于 mock 模式演示、app 用例与 e2e 测试。
 */
import type { AgentProvenance, QaPort, QaRequest, QaResult } from '@sb/contracts';

const CLAIM_PATTERN = /^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/;

interface MockClaim {
  readonly text: string;
  readonly source: string;
}

function claimsOf(text: string): MockClaim[] {
  const rows: MockClaim[] = [];
  for (const line of text.split('\n')) {
    const match = CLAIM_PATTERN.exec(line.trim());
    if (match) rows.push({ text: match[1] as string, source: match[2] as string });
  }
  return rows;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class MockQa implements QaPort {
  async generate(request: QaRequest): Promise<QaResult> {
    const claims = claimsOf(request.sourceText);
    const count = Math.max(1, Math.min(request.questionCount.max, Math.max(request.questionCount.min, claims.length || 1)));
    const blocks: string[] = [];
    for (let index = 0; index < count; index++) {
      const claim = claims[index] ?? claims[claims.length - 1];
      const conclusion = claim ? truncate(claim.text, 90) : truncate(request.sourceText.replace(/\s+/gu, ' ').trim(), 90);
      const citation = claim ? `（来源：[[${claim.source}]]）` : '';
      blocks.push([
        `### Q${index + 1}. ${request.sourceTitle}的第 ${index + 1} 个判断为什么成立，它在什么条件下失效？`,
        '',
        `**结论**：${conclusion}`,
        `**形式化**：判断 = 条件 × 机制 → 结果${citation === '' ? '' : `；依据 ${citation}`}`,
        `**论证步**：材料给出的依据是「${truncate(conclusion, 60)}」，需要读者沿着这个依据复述条件与结果。`,
        '**边界**：材料没有展开失效条件，这里标记为待补：换一个场景或反例检验。',
        '',
      ].join('\n'));
    }

    const markdown = blocks.join('\n');
    return {
      markdown,
      questionCount: count,
      cost: 0,
      provenance: this.provenance(request),
    };
  }

  private provenance(request: QaRequest): AgentProvenance {
    return {
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: 'qa',
      promptVersion: 1,
      promptSha256: 'mock',
      inputTokens: 300 + Math.ceil(request.sourceText.length * 0.7),
      outputTokens: 200 + request.questionCount.max * 80,
      latencyMs: 250,
      fallbackChain: [],
      cacheHit: false,
    };
  }
}
