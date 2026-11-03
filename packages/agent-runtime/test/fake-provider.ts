import type { DraftProposal } from '@sb/domain';
import { AgentProviderError } from '../src/errors';
import type { CompletionProvider, CompletionRequest, CompletionResponse } from '../src/runner';

export type Behavior = 'ok' | 'invalid' | 'timeout' | 'rate_limit' | 'upstream' | 'refusal';

export const VALID_PROPOSAL: DraftProposal = {
  tier: 'standard',
  rationale: '测试用草稿',
  claims: [{ text: '这是一条足够长的测试判断。', inference: false, source: 'raw/knowledge/cubox/a.md' }],
  nodes: [{ name: '幂律分布', nodeType: 'concept', action: 'new', definition: '测试定义', claimIndexes: [0] }],
};

export class FakeProvider implements CompletionProvider {
  readonly calls: CompletionRequest[] = [];

  constructor(
    private readonly behaviors: Behavior[] = [],
    private readonly proposal: DraftProposal = VALID_PROPOSAL,
    private readonly usage = { inputTokens: 1000, outputTokens: 200 },
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);
    const behavior = this.behaviors.shift() ?? 'ok';
    switch (behavior) {
      case 'ok':
        return { raw: this.proposal, usage: this.usage };
      case 'invalid':
        return { raw: { tier: 'nope' }, usage: this.usage };
      case 'timeout':
        throw new AgentProviderError('timeout', '模拟超时');
      case 'rate_limit':
        throw new AgentProviderError('rate_limit', '模拟限流');
      case 'upstream':
        throw new AgentProviderError('upstream', '模拟 5xx');
      case 'refusal':
        throw new AgentProviderError('refusal', '模拟拒答');
    }
  }
}
