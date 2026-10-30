/** 规则输入（设计文档 §4.3）：所有规则共用一个只读快照，便于统一测试与 explain。 */
import type { Claim, DraftTier, NodeChange, NodeType } from './draft';
import type { RawStateKind } from './raw-state';

export interface ExistingNode {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly nodeType: NodeType;
  readonly file: string;
}

export interface ItemRef {
  readonly rawPath: string;
  readonly eventId: string | null;
  readonly stateKind: RawStateKind;
}

export interface RuleInput {
  readonly rawPath: string;
  readonly eventId: string | null;
  readonly sourceKey: string;
  readonly enabledSources: readonly string[];
  readonly charCount: number;
  readonly longTextThreshold: number;
  readonly tier: DraftTier;
  readonly claims: readonly Claim[];
  readonly nodes: readonly NodeChange[];
  readonly existingNodes: readonly ExistingNode[];
  readonly items: readonly ItemRef[];
  /** 领域层不做 I/O：由应用层把 vault 里真实存在的 raw 路径集合传进来。 */
  readonly knownRawPaths: ReadonlySet<string>;
}
