/** 草稿契约（设计文档 §6）：agent 只能产出这个结构，不能直接写 wiki。 */

export type DraftTier = 'patch' | 'standard' | 'accelerated' | 'full';
export type NodeType = 'concept' | 'topic' | 'person';
export type NodeAction = 'patch' | 'new';

export interface Claim {
  readonly text: string;
  /** 原文没说、由模型推断的必须为 true，人审时要看到。 */
  readonly inference: boolean;
  /** 必须指向已存在的 raw 路径（由 r-source-exists 校验）。 */
  readonly source: string;
}

export interface NodeChange {
  readonly name: string;
  readonly nodeType: NodeType;
  readonly action: NodeAction;
  readonly definition: string | null;
}

export interface DraftProposal {
  readonly tier: DraftTier;
  readonly rationale: string;
  readonly claims: readonly Claim[];
  readonly nodes: readonly NodeChange[];
}

export const DRAFT_TIERS: readonly DraftTier[] = ['patch', 'standard', 'accelerated', 'full'];

export function isDraftTier(value: string): value is DraftTier {
  return (DRAFT_TIERS as readonly string[]).includes(value);
}
