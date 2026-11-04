/**
 * StateStore 的 SQLite 实现（设计文档 §7 / §8）。
 *
 * - 事务：一个用例一个事务，`BEGIN IMMEDIATE`；嵌套调用复用外层事务
 * - 乐观锁：状态更新必须带 expectedVersion，版本不匹配返回 false
 * - 围栏令牌：job 领取时自增，陈旧 worker 无法覆盖新结果
 * - 事件：与状态同事务追加，供 replay 校验
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  ArticleRecord,
  ArticleVersionRecord,
  Clock,
  CommitRecord,
  DraftRecord,
  DraftStatus,
  EventRecord,
  JobKind,
  JobRecord,
  JobState,
  RawItemRecord,
  ReviewDecisionRecord,
  StateStore,
  Transaction,
  UsageRecord,
  ArticleRepo,
  ArticleVersionRepo,
} from '@sb/contracts';
import type { DraftId, RawPath, RawState } from '@sb/domain';
import {
  commitToRow,
  decisionToRow,
  rowToDraft,
  rowToEvent,
  rowToJob,
  rowToRawItem,
  rowToUsage,
  serializeState,
  type Row,
} from './mapping';

export interface SqliteStoreOptions {
  /** ':memory:' 或文件路径 */
  readonly path: string;
  readonly clock: Clock;
}

export class SqliteStore implements StateStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private readonly tx: Transaction;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
    this.tx = {
      rawItems: new RawItems(this),
      drafts: new Drafts(this),
      decisions: new Decisions(this),
      commits: new Commits(this),
      jobs: new Jobs(this),
      events: new Events(this),
      usage: new Usage(this),
      articles: new Articles(this),
      articleVersions: new ArticleVersions(this),
    };
  }

  static open(options: SqliteStoreOptions): SqliteStore {
    const db = new DatabaseSync(options.path);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    if (options.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    return new SqliteStore(db, options.clock);
  }

  get database(): DatabaseSync {
    return this.db;
  }

  get now(): string {
    return this.clock.now();
  }

  /** 供仓储与 doctor 使用；不对外承诺稳定。 */
  stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this.tx);
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = await fn(this.tx);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    this.statements.clear();
    this.db.close();
  }
}

class RawItems {
  constructor(private readonly store: SqliteStore) {}

  async getByPath(path: RawPath): Promise<RawItemRecord | null> {
    const row = this.store.stmt('SELECT * FROM raw_item WHERE path = ?').get(path) as Row | undefined;
    return row ? rowToRawItem(row) : null;
  }

  async upsert(record: RawItemRecord): Promise<void> {
    const encoded = serializeState(record.state);
    this.store
      .stmt(
        `INSERT INTO raw_item
           (path, content_hash, source_key, event_id, title, char_count, state, state_data, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           content_hash = excluded.content_hash,
           source_key   = excluded.source_key,
           event_id     = excluded.event_id,
           title        = excluded.title,
           char_count   = excluded.char_count,
           state        = excluded.state,
           state_data   = excluded.state_data,
           version      = excluded.version,
           updated_at   = excluded.updated_at`,
      )
      .run(
        record.rawPath,
        record.contentHash,
        record.sourceKey,
        record.eventId,
        record.title,
        record.charCount,
        encoded.kind,
        encoded.data,
        record.version,
        record.createdAt,
        record.updatedAt,
      );
  }

  async compareAndSwapVersion(id: number, expectedVersion: number, next: RawState): Promise<boolean> {
    const encoded = serializeState(next);
    const result = this.store
      .stmt(
        `UPDATE raw_item
            SET state = ?, state_data = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(encoded.kind, encoded.data, this.store.now, id, expectedVersion);
    return Number(result.changes) === 1;
  }

  async listByState(states: readonly RawState['kind'][]): Promise<readonly RawItemRecord[]> {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.store
      .stmt(`SELECT * FROM raw_item WHERE state IN (${placeholders}) ORDER BY id`)
      .all(...states) as Row[];
    return rows.map(rowToRawItem);
  }

  async listAll(): Promise<readonly RawItemRecord[]> {
    const rows = this.store.stmt('SELECT * FROM raw_item ORDER BY id').all() as Row[];
    return rows.map(rowToRawItem);
  }
}

class Drafts {
  constructor(private readonly store: SqliteStore) {}

  async insert(record: DraftRecord): Promise<void> {
    this.store
      .stmt(
        `INSERT INTO draft
           (id, raw_item_id, proposal, findings, target_hashes, provider, model, prompt_id, prompt_version,
            prompt_sha256, input_tokens, output_tokens, latency_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.rawItemId,
        JSON.stringify(record.proposal),
        JSON.stringify(record.findings),
        JSON.stringify(record.targetHashes ?? {}),
        record.provider,
        record.model,
        record.promptId,
        record.promptVersion,
        record.promptSha256,
        record.inputTokens,
        record.outputTokens,
        record.latencyMs,
        record.status,
        record.createdAt,
      );
  }

  async get(id: DraftId): Promise<DraftRecord | null> {
    const row = this.store.stmt('SELECT * FROM draft WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToDraft(row) : null;
  }

  async listByStatus(status: DraftStatus): Promise<readonly DraftRecord[]> {
    const rows = this.store
      .stmt('SELECT * FROM draft WHERE status = ? ORDER BY created_at DESC')
      .all(status) as Row[];
    return rows.map(rowToDraft);
  }

  async updateReview(
    id: DraftId,
    proposal: DraftRecord['proposal'],
    findings: DraftRecord['findings'],
    targetHashes: DraftRecord['targetHashes'],
  ): Promise<void> {
    this.store.stmt('UPDATE draft SET proposal = ?, findings = ?, target_hashes = ? WHERE id = ?')
      .run(JSON.stringify(proposal), JSON.stringify(findings), JSON.stringify(targetHashes), String(id));
  }

  async setStatus(id: DraftId, status: DraftStatus): Promise<void> {
    this.store.stmt('UPDATE draft SET status = ? WHERE id = ?').run(status, id);
  }
}

class Decisions {
  constructor(private readonly store: SqliteStore) {}

  async append(record: ReviewDecisionRecord): Promise<void> {
    this.store
      .stmt('INSERT INTO review_decision (draft_id, action, note, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(...decisionToRow(record));
  }
}

class Commits {
  constructor(private readonly store: SqliteStore) {}

  async append(record: CommitRecord): Promise<void> {
    this.store
      .stmt('INSERT INTO commit_record (draft_id, git_sha, files, created_at) VALUES (?, ?, ?, ?)')
      .run(...commitToRow(record));
  }
}

class Jobs {
  constructor(private readonly store: SqliteStore) {}

  async enqueue(input: { kind: JobKind; target: string }): Promise<JobRecord> {
    const result = this.store
      .stmt(
        `INSERT INTO job (kind, target, state, attempts, fencing_token, lease_until, last_error, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, 0, NULL, NULL, ?, ?)`,
      )
      .run(input.kind, input.target, this.store.now, this.store.now);
    const row = this.store.stmt('SELECT * FROM job WHERE id = ?').get(Number(result.lastInsertRowid)) as Row;
    return rowToJob(row);
  }

  async claimNext(kind: JobKind, leaseMs: number): Promise<JobRecord | null> {
    const leaseUntil = new Date(new Date(this.store.now).getTime() + leaseMs).toISOString();
    const row = this.store
      .stmt(
        `UPDATE job
            SET state = 'running',
                attempts = attempts + 1,
                fencing_token = fencing_token + 1,
                lease_until = ?,
                updated_at = ?
          WHERE id = (
            SELECT id FROM job WHERE kind = ? AND state = 'queued' ORDER BY id LIMIT 1
          )
        RETURNING *`,
      )
      .get(leaseUntil, this.store.now, kind) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  async finish(id: number, state: JobState, lastError: string | null): Promise<void> {
    this.store
      .stmt('UPDATE job SET state = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?')
      .run(state, lastError, this.store.now, id);
  }
}

class Events {
  constructor(private readonly store: SqliteStore) {}

  async append(input: Omit<EventRecord, 'seq'>): Promise<EventRecord> {
    const result = this.store
      .stmt('INSERT INTO event (at, actor, type, aggregate_id, payload) VALUES (?, ?, ?, ?, ?)')
      .run(input.at, input.actor, input.type, input.aggregateId, JSON.stringify(input.payload));
    return { ...input, seq: Number(result.lastInsertRowid) };
  }

  async listSince(seq: number): Promise<readonly EventRecord[]> {
    const rows = this.store.stmt('SELECT * FROM event WHERE seq > ? ORDER BY seq').all(seq) as Row[];
    return rows.map(rowToEvent);
  }
}

class Usage {
  constructor(private readonly store: SqliteStore) {}

  async append(record: UsageRecord): Promise<void> {
    this.store
      .stmt(
        `INSERT INTO usage_record
           (at, raw_path, draft_id, profile_id, provider, model, input_tokens, output_tokens, latency_ms, cache_hit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.at,
        record.rawPath,
        record.draftId,
        record.profileId,
        record.provider,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.latencyMs,
        record.cacheHit ? 1 : 0,
      );
  }

  async listAll(): Promise<readonly UsageRecord[]> {
    const rows = this.store.stmt('SELECT * FROM usage_record ORDER BY id').all() as Row[];
    return rows.map(rowToUsage);
  }

  async listByDay(day: string): Promise<readonly UsageRecord[]> {
    const rows = this.store
      .stmt('SELECT * FROM usage_record WHERE at LIKE ? ORDER BY id')
      .all(`${day}%`) as Row[];
    return rows.map(rowToUsage);
  }
}

/** 供 doctor / 测试使用的便捷构造。 */
export function openMemoryStore(clock: Clock): SqliteStore {
  return SqliteStore.open({ path: ':memory:', clock });
}


class Articles implements ArticleRepo {
  constructor(private readonly store: SqliteStore) {}

  private row(row: Record<string, unknown>): ArticleRecord {
    return {
      id: String(row.id), title: String(row.title), theme: String(row.theme),
      nodeIds: JSON.parse(String(row.node_ids)) as string[],
      outline: row.outline === null ? null : String(row.outline),
      status: String(row.status) as ArticleRecord['status'],
      currentVersionId: row.current_version_id === null ? null : String(row.current_version_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  async insert(record: ArticleRecord): Promise<void> {
    this.store.stmt('INSERT INTO article (id,title,theme,node_ids,outline,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(record.id, record.title, record.theme, JSON.stringify(record.nodeIds), record.outline, record.status, record.currentVersionId, record.createdAt, record.updatedAt);
  }

  async get(id: string): Promise<ArticleRecord | null> {
    const row = this.store.stmt('SELECT * FROM article WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.row(row) : null;
  }

  async list(): Promise<readonly ArticleRecord[]> {
    const rows = this.store.stmt('SELECT * FROM article ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => this.row(row));
  }

  async setOutline(id: string, outline: string, updatedAt: string): Promise<void> {
    this.store.stmt('UPDATE article SET outline = ?, updated_at = ? WHERE id = ?').run(outline, updatedAt, id);
  }

  async setCurrentVersion(id: string, versionId: string, updatedAt: string): Promise<void> {
    this.store.stmt('UPDATE article SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, updatedAt, id);
  }

  async setStatus(id: string, status: ArticleRecord['status'], updatedAt: string): Promise<void> {
    this.store.stmt('UPDATE article SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
  }
}

class ArticleVersions implements ArticleVersionRepo {
  constructor(private readonly store: SqliteStore) {}

  private row(row: Record<string, unknown>): ArticleVersionRecord {
    return {
      id: String(row.id), articleId: String(row.article_id), versionNo: Number(row.version_no),
      contentMd: String(row.content_md), citations: JSON.parse(String(row.citations)) as ArticleVersionRecord['citations'],
      basedOnVersionId: row.based_on_version_id === null ? null : String(row.based_on_version_id),
      source: String(row.source) as ArticleVersionRecord['source'],
      instruction: row.instruction === null ? null : String(row.instruction),
      provider: row.provider === null ? null : String(row.provider),
      model: row.model === null ? null : String(row.model),
      promptVersion: row.prompt_version === null ? null : Number(row.prompt_version),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cost: row.cost === null ? null : Number(row.cost),
      note: row.note === null ? null : String(row.note),
      createdAt: String(row.created_at),
    };
  }

  async append(record: ArticleVersionRecord): Promise<void> {
    this.store.stmt('INSERT INTO article_version (id,article_id,version_no,content_md,citations,based_on_version_id,source,instruction,provider,model,prompt_version,input_tokens,output_tokens,cost,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.id, record.articleId, record.versionNo, record.contentMd, JSON.stringify(record.citations), record.basedOnVersionId, record.source, record.instruction, record.provider, record.model, record.promptVersion, record.inputTokens, record.outputTokens, record.cost, record.note, record.createdAt);
  }

  async listByArticle(articleId: string): Promise<readonly ArticleVersionRecord[]> {
    const rows = this.store.stmt('SELECT * FROM article_version WHERE article_id = ? ORDER BY version_no DESC').all(articleId) as Record<string, unknown>[];
    return rows.map((row) => this.row(row));
  }

  async get(id: string): Promise<ArticleVersionRecord | null> {
    const row = this.store.stmt('SELECT * FROM article_version WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.row(row) : null;
  }
}
