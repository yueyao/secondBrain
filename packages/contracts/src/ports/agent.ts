/**
 * 起草端口（设计文档 §10 / ADR 0005）。
 * 模型只能"提议"，不能写 wiki；输出必须是校验通过的 DraftProposal，且附带 provenance。
 */
import type { DraftProposal, RawPath } from '@sb/domain';
import type { ScoredHit } from './search-index';

/** 敏感度：restricted 的原文只能走允许的 provider（ADR 0005 §2.3）。 */
export type Sensitivity = 'public' | 'restricted';

export type AgentTool = 'search_wiki' | 'read_node' | 'read_raw';

export interface AgentBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
}

export interface DigestRequest {
  readonly rawPath: RawPath;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  /** 有界检索结果：由应用层预先检索，减少 agent 自主循环。 */
  readonly retrieved: readonly ScoredHit[];
  /** 只读工具白名单；写能力物理上不在 agent 进程内。 */
  readonly tools: readonly AgentTool[];
  readonly budget: AgentBudget;
}

/** 这条草稿到底是谁产的——换模型/降级后必须可归因。 */
export interface AgentProvenance {
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptSha256: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  /** 发生降级时的备选链（按尝试顺序，不含最终成功者） */
  readonly fallbackChain: readonly string[];
  readonly cacheHit: boolean;
}

export interface AgentOutcome {
  readonly proposal: DraftProposal;
  readonly provenance: AgentProvenance;
  /** 本次调用的估算成本；缓存命中为 0 */
  readonly cost: number;
}

export interface AgentPort {
  draft(request: DigestRequest): Promise<AgentOutcome>;
}
