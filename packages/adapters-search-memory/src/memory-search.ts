/**
 * 内存检索适配器（设计文档 §6 的 SearchIndex）。
 * 从 vault 读全部节点建索引；查询用与规则一致的评分：
 * 名称精确 100 / 别名 92 / 名称部分 72 / 正文 50 / 模糊（Dice）35-60。
 */
import type { MatchType, NodeDoc, ScoredHit, SearchIndex, VaultReader } from '@sb/contracts';
import { diceSimilarity, makeNodeId, normalizeText, parseFrontmatter, type NodeId, type NodeType } from '@sb/domain';

export class MemorySearch implements SearchIndex {
  private readonly docs = new Map<string, NodeDoc>();

  constructor(private readonly vault?: VaultReader) {}

  /** 从 vault 重建索引；返回节点数。 */
  async refresh(): Promise<number> {
    if (!this.vault) return 0;
    const files = await this.vault.listNodes();
    for (const file of files) {
      let text: string;
      try {
        text = await this.vault.readNode(file);
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = typeof data.name === 'string' ? data.name : null;
      if (!name) continue;
      const nodeType = (typeof data.node_type === 'string' ? data.node_type : 'concept') as NodeType;
      this.upsertSync({
        nodeId: makeNodeId(nodeType, name),
        name,
        aliases: Array.isArray(data.aliases) ? data.aliases : [],
        nodeType,
        file,
        body,
        updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
      });
    }
    return this.docs.size;
  }

  async upsert(doc: NodeDoc): Promise<void> {
    this.upsertSync(doc);
  }

  private upsertSync(doc: NodeDoc): void {
    this.docs.set(doc.file, doc);
  }

  async remove(nodeId: NodeId): Promise<void> {
    for (const [file, doc] of this.docs) {
      if (doc.nodeId === nodeId) this.docs.delete(file);
    }
  }

  /** 供应用层评估规则时拿到"现有节点"快照。 */
  allDocs(): readonly NodeDoc[] {
    return [...this.docs.values()];
  }

  async query(query: string, limit = 10): Promise<readonly ScoredHit[]> {
    const normalized = normalizeText(query);
    if (!normalized) return [];
    const hits: ScoredHit[] = [];

    for (const doc of this.docs.values()) {
      let score = 0;
      let matchType: MatchType | null = null;

      if (normalizeText(doc.name) === normalized) {
        score = 100;
        matchType = 'name_exact';
      } else if (doc.aliases.some((alias) => normalizeText(alias) === normalized)) {
        score = 92;
        matchType = 'alias_exact';
      } else if (normalizeText(doc.name).includes(normalized) || normalized.includes(normalizeText(doc.name))) {
        score = 72;
        matchType = 'name_partial';
      } else if (normalizeText(doc.body).includes(normalized)) {
        score = 50;
        matchType = 'body';
      } else {
        const similarity = diceSimilarity(query, doc.name);
        if (similarity >= 0.35) {
          score = Math.round(similarity * 60);
          matchType = 'fuzzy';
        }
      }

      if (matchType) {
        hits.push({ nodeId: doc.nodeId, name: doc.name, file: doc.file, score, matchType });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
