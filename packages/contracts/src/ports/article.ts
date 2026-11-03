/** 文章与版本链（Compose C1）：大纲存在 article，正文每个版本只增不改。 */
export type ArticleStatus = 'draft' | 'review' | 'final';
export type ArticleVersionSource = 'ai_initial' | 'ai_refine' | 'deai' | 'manual_edit' | 'restore';

export interface ArticleCitation {
  readonly text: string;
  readonly source: string;
}

export interface ArticleRecord {
  readonly id: string;
  readonly title: string;
  readonly theme: string;
  readonly nodeIds: readonly string[];
  readonly outline: string | null;
  readonly status: ArticleStatus;
  readonly currentVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArticleVersionRecord {
  readonly id: string;
  readonly articleId: string;
  readonly versionNo: number;
  readonly contentMd: string;
  readonly citations: readonly ArticleCitation[];
  readonly basedOnVersionId: string | null;
  readonly source: ArticleVersionSource;
  readonly instruction: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: number | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface ArticleRepo {
  insert(record: ArticleRecord): Promise<void>;
  get(id: string): Promise<ArticleRecord | null>;
  list(): Promise<readonly ArticleRecord[]>;
  setOutline(id: string, outline: string, updatedAt: string): Promise<void>;
  setCurrentVersion(id: string, versionId: string, updatedAt: string): Promise<void>;
  setStatus(id: string, status: ArticleStatus, updatedAt: string): Promise<void>;
}

export interface ArticleVersionRepo {
  append(record: ArticleVersionRecord): Promise<void>;
  listByArticle(articleId: string): Promise<readonly ArticleVersionRecord[]>;
  get(id: string): Promise<ArticleVersionRecord | null>;
}
