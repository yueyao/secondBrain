/**
 * 测试环境组装：临时 vault（真实 git）+ 内存 SQLite + 内存检索 + MockAgent。
 * 用法见 docs/TESTING.md。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock, HashPort, IdGenerator } from '@sb/contracts';
import { FsVault } from '@sb/adapters-vault';
import { migrate, SqliteStore } from '@sb/adapters-sqlite';
import { MemorySearch } from '@sb/adapters-search-memory';
import { parseDraftId, stringifyFrontmatter, type CommitSha, type DraftId } from '@sb/domain';
import { LEGACY_RAW, MOCK_NODES, MOCK_RAW } from './fixtures';
import { MockAgent } from './mock-agent';

export const FIXED_NOW = '2026-10-30T23:00:00+08:00';

export const fixedClock: Clock = { now: () => FIXED_NOW };

export const hashPort: HashPort = { sha256: (text) => createHash('sha256').update(text).digest('hex') };

export class SequentialIds implements IdGenerator {
  private draftSeq = 0;
  private intentSeq = 0;

  draftId(): DraftId {
    this.draftSeq += 1;
    const parsed = parseDraftId(`draft-${String(this.draftSeq).padStart(6, '0')}`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  }

  intentId(): string {
    this.intentSeq += 1;
    return `intent-${String(this.intentSeq).padStart(6, '0')}`;
  }
}

export interface TestHarness {
  readonly root: string;
  readonly vault: FsVault;
  readonly store: SqliteStore;
  readonly search: MemorySearch;
  readonly agent: MockAgent;
  readonly clock: Clock;
  readonly ids: SequentialIds;
  readonly seedCommit: CommitSha;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  readonly seed?: boolean;
  readonly clock?: Clock;
}

/** 创建一个隔离的测试环境（每个测试用例独立 tmpdir + 独立 :memory: 库）。 */
export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-harness-'));
  const clock = options.clock ?? fixedClock;
  const vault = FsVault.open({ root });
  const store = SqliteStore.open({ path: ':memory:', clock });
  migrate(store.database, clock);
  const search = new MemorySearch(vault);
  const agent = new MockAgent();

  if (options.seed !== false) {
    const files: string[] = [];
    for (const raw of MOCK_RAW) {
      writeFile(root, raw.path, stringifyFrontmatter(raw.frontmatter, raw.body));
      files.push(raw.path);
    }
    writeFile(root, LEGACY_RAW.path, LEGACY_RAW.content);
    files.push(LEGACY_RAW.path);

    for (const node of MOCK_NODES) {
      writeFile(root, node.file, stringifyFrontmatter(node.frontmatter, node.body));
      files.push(node.file);
    }
    await vault.commitFiles(files, 'seed: mock vault');
  }

  const seedCommit = (await vault.head()) as CommitSha;
  await search.refresh();

  return {
    root,
    vault,
    store,
    search,
    agent,
    clock,
    ids: new SequentialIds(),
    seedCommit,
    async cleanup() {
      await store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeFile(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}
