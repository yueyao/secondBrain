/**
 * 状态存储端口（设计文档 §6 / §7）。
 * 这里只声明能力，不出现任何 SQL；适配器（SQLite）负责实现。
 */
import type {
  CommitSha,
  ContentHash,
  DraftId,
  DraftProposal,
  Finding,
  RawPath,
  RawState,
} from '@sb/domain';
import type { UsageRepo } from './usage';
import type { ArticleRepo, ArticleVersionRepo } from './article';

export interface RawItemRecord {
  readonly id: number;
  readonly rawPath: RawPath;
  readonly contentHash: ContentHash;
  readonly sourceKey: string;
  readonly eventId: string | null;
  readonly title: string;
  readonly charCount: number;
  readonly state: RawState;
  /** 乐观锁版本号；状态更新必须带 expectedVersion。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface DraftRecord {
  readonly id: DraftId;
  readonly rawItemId: number;
  readonly proposal: DraftProposal;
  readonly findings: readonly Finding[];
  /** 起草时目标文件的 sha256（file → hash）；accept 时用于"不覆盖"校验 */
  readonly targetHashes: Readonly<Record<string, string>>;
  /** provenance：任何一条知识都能追溯到模型、prompt 与用量（设计文档 §10）。 */
  readonly provider: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptSha256: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly status: DraftStatus;
  readonly createdAt: string;
}

export interface ReviewDecisionRecord {
  readonly draftId: DraftId;
  readonly action: 'accept' | 'reject' | 'defer';
  readonly note: string | null;
  readonly actor: string;
  readonly createdAt: string;
}

export interface CommitRecord {
  readonly draftId: DraftId;
  readonly gitSha: CommitSha;
  readonly files: readonly string[];
  readonly createdAt: string;
}

export type JobKind = 'triage' | 'digest' | 'commit';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'dead';

export interface JobRecord {
  readonly id: number;
  readonly kind: JobKind;
  readonly target: string;
  readonly state: JobState;
  readonly attempts: number;
  /** 围栏令牌：陈旧 worker 的写入会因 token 不匹配而失败。 */
  readonly fencingToken: number;
  readonly leaseUntil: string | null;
  readonly lastError: string | null;
}

export interface EventRecord {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export interface RawItemRepo {
  getByPath(path: RawPath): Promise<RawItemRecord | null>;
  upsert(record: RawItemRecord): Promise<void>;
  /** 乐观锁：版本不匹配返回 false，调用方重读重试。 */
  compareAndSwapVersion(id: number, expectedVersion: number, next: RawState): Promise<boolean>;
  listByState(states: readonly RawState['kind'][]): Promise<readonly RawItemRecord[]>;
  listAll(): Promise<readonly RawItemRecord[]>;
}

export interface DraftRepo {
  insert(record: DraftRecord): Promise<void>;
  get(id: DraftId): Promise<DraftRecord | null>;
  listByStatus(status: DraftStatus): Promise<readonly DraftRecord[]>;
  setStatus(id: DraftId, status: DraftStatus): Promise<void>;
}

export interface DecisionRepo {
  append(record: ReviewDecisionRecord): Promise<void>;
}

export interface CommitRepo {
  append(record: CommitRecord): Promise<void>;
}

export interface JobRepo {
  enqueue(input: { kind: JobKind; target: string }): Promise<JobRecord>;
  /** 原子领取：UPDATE ... WHERE state='queued' RETURNING *，并递增围栏令牌。 */
  claimNext(kind: JobKind, leaseMs: number): Promise<JobRecord | null>;
  finish(id: number, state: JobState, lastError: string | null): Promise<void>;
}

export interface EventRepo {
  append(input: Omit<EventRecord, 'seq'>): Promise<EventRecord>;
  listSince(seq: number): Promise<readonly EventRecord[]>;
}

export interface Transaction {
  readonly rawItems: RawItemRepo;
  readonly drafts: DraftRepo;
  readonly decisions: DecisionRepo;
  readonly commits: CommitRepo;
  readonly jobs: JobRepo;
  readonly events: EventRepo;
  readonly usage: UsageRepo;
  readonly articles: ArticleRepo;
  readonly articleVersions: ArticleVersionRepo;
}

export interface StateStore {
  /** 一个用例 = 一个事务；状态变更与事件追加必须同事务。 */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
