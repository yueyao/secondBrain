import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@sb/contracts';
import { MIGRATIONS } from './migrations';

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
}

/**
 * 幂等迁移：可对空库、半迁移库重复执行。
 * 每个版本一个事务；失败即回滚并把错误抛出（不允许半迁移状态）。
 */
export function migrate(db: DatabaseSync, clock: Clock): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  const appliedVersions = new Set(rows.map((row) => Number(row.version)));

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (appliedVersions.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        clock.now(),
      );
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { applied, skipped };
}

/** 供 `sb doctor` 使用：当前 schema 版本与完整性检查。 */
export function schemaStatus(db: DatabaseSync): {
  readonly version: number;
  readonly integrity: string;
} {
  const rows = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').all() as Array<{
    version: number | null;
  }>;
  const version = Number(rows[0]?.version ?? 0);
  const check = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  const integrity = String(check[0]?.integrity_check ?? 'unknown');
  return { version, integrity };
}
