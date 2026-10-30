/** 检索索引端口（设计文档 §6）：实现可以是 FTS5，也可以是内存扫描；契约不变。 */
import type { NodeId, NodeType } from '@sb/domain';

export interface NodeDoc {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly nodeType: NodeType;
  readonly file: string;
  readonly body: string;
  readonly updatedAt: string;
}

export type MatchType = 'name_exact' | 'alias_exact' | 'name_partial' | 'body' | 'fuzzy';

export interface ScoredHit {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly file: string;
  readonly score: number;
  readonly matchType: MatchType;
}

export interface SearchIndex {
  upsert(doc: NodeDoc): Promise<void>;
  remove(nodeId: NodeId): Promise<void>;
  query(query: string, limit?: number): Promise<readonly ScoredHit[]>;
}
