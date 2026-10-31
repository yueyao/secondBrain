/**
 * 迁移脚本：只追加，不修改历史版本。
 * 每个版本的 SQL 在事务内执行；执行记录写 schema_migrations。
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

const INIT = `
CREATE TABLE raw_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  event_id     TEXT,
  title        TEXT NOT NULL,
  char_count   INTEGER NOT NULL,
  state        TEXT NOT NULL,
  state_data   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_raw_item_state ON raw_item(state);

CREATE TABLE draft (
  id             TEXT PRIMARY KEY,
  raw_item_id    INTEGER NOT NULL REFERENCES raw_item(id) ON DELETE CASCADE,
  proposal       TEXT NOT NULL,
  findings       TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_id      TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  prompt_sha256  TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_draft_status ON draft(status);

CREATE TABLE review_decision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id   TEXT NOT NULL REFERENCES draft(id),
  action     TEXT NOT NULL,
  note       TEXT,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE commit_record (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id   TEXT NOT NULL REFERENCES draft(id),
  git_sha    TEXT NOT NULL,
  files      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE job (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  state         TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_until   TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX ix_job_pick ON job(kind, state, id);

CREATE TABLE event (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  type         TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX ix_event_aggregate ON event(aggregate_id, seq);

`;

const USAGE = `
CREATE TABLE usage_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  raw_path      TEXT NOT NULL,
  draft_id      TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  latency_ms    INTEGER,
  cache_hit     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_usage_at ON usage_record(at);
`;

const DRAFT_TARGET_HASHES = `
ALTER TABLE draft ADD COLUMN target_hashes TEXT NOT NULL DEFAULT '{}';
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', up: INIT },
  { version: 2, name: 'usage', up: USAGE },
  { version: 3, name: 'draft-target-hashes', up: DRAFT_TARGET_HASHES },
];
