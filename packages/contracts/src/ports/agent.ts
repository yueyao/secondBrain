/**
 * 起草端口（设计文档 §10）：模型只能"提议"，不能写 wiki。
 * 返回的 DraftProposal 必须在适配器边界通过 schema 校验后再进入应用层。
 */
import type { DraftProposal, RawPath } from '@sb/domain';
import type { ScoredHit } from './search-index';

export type AgentTool = 'search_wiki' | 'read_node' | 'read_raw';

export interface AgentBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
}

export interface DigestRequest {
  readonly rawPath: RawPath;
  readonly content: string;
  /** 有界检索结果：由应用层预先检索，减少 agent 自主循环。 */
  readonly retrieved: readonly ScoredHit[];
  /** 只读工具白名单；写能力物理上不在 agent 进程内。 */
  readonly tools: readonly AgentTool[];
  readonly budget: AgentBudget;
}

export interface AgentPort {
  draft(request: DigestRequest): Promise<DraftProposal>;
}
