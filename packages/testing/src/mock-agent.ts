/** MockAgent：用可解释启发式模拟"提炼"步骤，供测试与本地 mock 演示使用。 */
import type { AgentOutcome, AgentPort, DigestRequest } from '@sb/contracts';
import type { Claim, DraftProposal, NodeChange } from '@sb/domain';
import { firstHeading, judgmentSentences, parseFrontmatter, truncate } from '@sb/domain';

export interface MockAgentOptions {
  readonly provider?: string;
  readonly model?: string;
}

export class MockAgent implements AgentPort {
  readonly provider: string;
  readonly model: string;

  constructor(options: MockAgentOptions = {}) {
    this.provider = options.provider ?? 'mock';
    this.model = options.model ?? 'heuristic-v1';
  }

  async draft(request: DigestRequest): Promise<AgentOutcome> {
    const { data, body } = parseFrontmatter(request.content);
    const hint = typeof data.node_hint === 'string' ? data.node_hint : null;
    const title =
      typeof data.title === 'string' ? data.title : (firstHeading(body) ?? String(request.rawPath).split('/').pop() ?? '未命名');

    const target = request.retrieved.find(
      (hit) =>
        (hit.matchType === 'name_exact' || hit.matchType === 'alias_exact') &&
        (hint ? hit.name === hint : true),
    );

    const claims: Claim[] = judgmentSentences(body)
      .slice(0, 5)
      .map((text) => ({ text, inference: /推测|可能|大概/.test(text), source: String(request.rawPath) }));

    const nodes: NodeChange[] = target
      ? [{ name: target.name, nodeType: 'concept', action: 'patch', definition: null, claimIndexes: claims.map((_, index) => index) }]
      : [
          {
            name: hint ?? title,
            nodeType: 'concept',
            action: 'new',
            definition: deriveDefinition(body, hint ?? title),
            claimIndexes: claims.map((_, index) => index),
          },
        ];

    const proposal: DraftProposal = {
      tier: target ? 'patch' : 'standard',
      rationale: target
        ? `命中已有节点「${target.name}」，按 patch 处理，新增 ${claims.length} 条 claims`
        : `未命中同名/别名节点，新建「${hint ?? title}」并沉淀 ${claims.length} 条 claims`,
      claims,
      nodes,
    };

    return {
      proposal,
      cost: 0,
      provenance: {
        profileId: 'mock-profile',
        provider: this.provider,
        model: this.model,
        promptId: 'digest',
        promptVersion: 1,
        promptSha256: 'mock',
        inputTokens: 1200,
        outputTokens: 300,
        latencyMs: 800,
        fallbackChain: [],
        cacheHit: false,
      },
    };
  }
}

function deriveDefinition(body: string, fallback: string): string {
  const sentences = body.split(/(?<=[。！？])/).map((sentence) => sentence.trim());
  const defined = sentences.find((sentence) => /是指|就是|本质是|指的是/.test(sentence) && sentence.length < 120);
  if (defined) return defined;
  const first = judgmentSentences(body)[0];
  return truncate(first ?? `${fallback}，由本篇文章提炼。`, 90);
}
