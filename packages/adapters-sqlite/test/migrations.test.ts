import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@sb/contracts';
import { migrate, schemaStatus } from '../src/migrate';
import { MIGRATIONS } from '../src/migrations';

const clock: Clock = { now: () => '2026-10-30T22:00:00+08:00' };

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => String(row.name));
}

describe('迁移', () => {
  it('空库一次迁移：版本 1，所有表就位，integrity_check 通过', () => {
    const db = new DatabaseSync(':memory:');
    const result = migrate(db, clock);

    expect(result.applied).toEqual([1, 2]);
    expect(result.skipped).toEqual([]);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'raw_item',
        'draft',
        'review_decision',
        'commit_record',
        'job',
        'event',
        'schema_migrations',
      ]),
    );
    expect(schemaStatus(db)).toEqual({ version: 2, integrity: 'ok' });
    db.close();
  });

  it('重复迁移是幂等的（第二次全部跳过）', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, clock);
    const second = migrate(db, clock);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1, 2]);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').all() as Array<{ n: number }>;
    expect(Number(rows[0]?.n)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('迁移记录带 applied_at，且版本号唯一', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, clock);
    const rows = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string; applied_at: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, name: 'init', applied_at: clock.now() });
    db.close();
  });

  it('迁移脚本版本号不重复且单调递增', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});
