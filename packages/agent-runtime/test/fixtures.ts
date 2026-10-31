import type { Clock, DigestRequest } from '@sb/contracts';
import { parseRawPath } from '@sb/domain';
import { BudgetLedger } from '../src/budget';
import { MemoryCompletionCache } from '../src/cache';
import { AgentRunner, type AgentRunnerOptions, type CompletionProvider } from '../src/runner';
import type { AgentTask, ModelProfile, TaskPolicy } from '../src/route';

export const NOW = '2026-10-30T12:00:00+08:00';
let currentNow = NOW;
export const clock: Clock = { now: () => currentNow };
export function setNow(value: string): void {
  currentNow = value;
}
export function resetNow(): void {
  currentNow = NOW;
}

export const cheap: ModelProfile = {
  id: 'cheap',
  provider: 'fake',
  model: 'cheap-2026-01',
  capabilities: { contextTokens: 32_000, structuredOutput: true, toolCalls: false, languages: ['zh'], sensitivity: ['public'] },
  pricing: { inPerMTokens: 1, outPerMTokens: 2 },
  limits: { maxConcurrency: 8, requestsPerMinute: 120 },
  health: { enabled: true, fallbackTo: [] },
};

export const mid: ModelProfile = {
  id: 'mid',
  provider: 'fake',
  model: 'mid-2026-01',
  capabilities: { contextTokens: 128_000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public'] },
  pricing: { inPerMTokens: 4, outPerMTokens: 8 },
  limits: { maxConcurrency: 6, requestsPerMinute: 90 },
  health: { enabled: true, fallbackTo: [] },
};

export const strong: ModelProfile = {
  id: 'strong',
  provider: 'fake',
  model: 'strong-2026-01',
  capabilities: { contextTokens: 128_000, structuredOutput: true, toolCalls: true, languages: ['zh'], sensitivity: ['public', 'restricted'] },
  pricing: { inPerMTokens: 10, outPerMTokens: 30 },
  limits: { maxConcurrency: 4, requestsPerMinute: 60 },
  health: { enabled: true, fallbackTo: ['mid'] },
};

export const disabled: ModelProfile = {
  ...strong,
  id: 'disabled',
  health: { enabled: false, fallbackTo: [] },
};

export const profiles: readonly ModelProfile[] = [cheap, mid, strong, disabled];

const digestPolicy: TaskPolicy = {
  task: 'digest',
  requires: { contextTokens: 60_000, structuredOutput: true, toolCalls: true },
  profileOrder: ['strong', 'disabled', 'cheap'],
  maxInputTokens: 60_000,
  maxOutputTokens: 4_000,
  expectedClaims: 8,
};

export const policies = {
  triage: { ...digestPolicy, task: 'triage' as AgentTask, requires: { contextTokens: 8_000, structuredOutput: true, toolCalls: false }, profileOrder: ['strong'] },
  digest: digestPolicy,
  'review-rewrite': { ...digestPolicy, task: 'review-rewrite' as AgentTask },
  decide: { ...digestPolicy, task: 'decide' as AgentTask },
} satisfies Record<AgentTask, TaskPolicy>;

const RAW = (() => {
  const parsed = parseRawPath('raw/knowledge/cubox/a.md');
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
})();

export function digestRequest(overrides: Partial<DigestRequest> = {}): DigestRequest {
  return {
    rawPath: RAW,
    content: '这是一篇测试原文，用来验证运行时行为。'.repeat(4),
    sensitivity: 'public',
    retrieved: [],
    tools: ['search_wiki', 'read_node', 'read_raw'],
    budget: { maxInputTokens: 60_000, maxOutputTokens: 4_000, maxToolCalls: 6 },
    ...overrides,
  };
}

export function makeRunner(
  provider: CompletionProvider,
  overrides: Partial<AgentRunnerOptions> = {},
): AgentRunner {
  return new AgentRunner({
    provider,
    profiles,
    policies,
    cache: new MemoryCompletionCache(),
    budget: new BudgetLedger({ taskCostLimit: 1, dailyCostLimit: 100 }, clock),
    clock,
    prompt: { id: 'digest', version: 1, sha256: 'prompt-sha-test', system: '你是知识助产士', render: (request) => request.content },
    sleep: async () => undefined,
    now: () => 0,
    ...overrides,
  });
}
