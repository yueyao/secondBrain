/** 运行时组装：真实适配器 + 内存检索 + MockAgent。demo 模式自动播种 mock 数据。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '@sb/app';
import { parseDraftId, stringifyFrontmatter } from '@sb/domain';
import { FsVault } from '@sb/adapters-vault';
import { migrate, SqliteStore } from '@sb/adapters-sqlite';
import { MemorySearch } from '@sb/adapters-search-memory';
import { LEGACY_RAW, MOCK_NODES, MOCK_RAW, MockAgent } from '@sb/testing';

export interface RuntimeOptions {
  readonly dataDir: string;
  readonly seedDemo?: boolean;
}

export interface Runtime {
  readonly ctx: AppContext;
  readonly vault: FsVault;
  readonly store: SqliteStore;
  readonly search: MemorySearch;
  close(): Promise<void>;
}

export const systemClock = { now: () => new Date().toISOString() };

function randomHex(bytes = 6): string {
  return randomUUID().replace(/-/g, '').slice(0, bytes * 2);
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const vault = FsVault.open({ root: path.join(dataDir, 'vault') });
  const store = SqliteStore.open({ path: path.join(dataDir, 'state.db'), clock: systemClock });
  migrate(store.database, systemClock);

  if (options.seedDemo !== false) await seedDemoVault(vault);

  const search = new MemorySearch(vault);
  await search.refresh();

  const agent = new MockAgent();
  const ctx: AppContext = {
    store,
    vault,
    search,
    agent,
    clock: systemClock,
    ids: {
      draftId: () => {
        const parsed = parseDraftId(`draft-${randomHex(6)}`);
        if (!parsed.ok) throw new Error(parsed.error.message);
        return parsed.value;
      },
      intentId: () => `intent-${randomHex(6)}`,
    },
    config: {
      longTextThreshold: 60_000,
      enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'],
    },
    agentMeta: { provider: agent.provider, model: agent.model, promptId: 'digest', promptVersion: 1 },
  };

  return {
    ctx,
    vault,
    store,
    search,
    async close() {
      await store.close();
    },
  };
}

/** 仅在 raw/ 为空时播种，避免覆盖用户数据。 */
async function seedDemoVault(vault: FsVault): Promise<void> {
  const existing = await vault.listRaw();
  if (existing.length > 0) return;

  const root = vault.rootDir;
  const write = (relative: string, content: string): void => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  };

  const files: string[] = [];
  for (const raw of MOCK_RAW) {
    write(raw.path, stringifyFrontmatter(raw.frontmatter, raw.body));
    files.push(raw.path);
  }
  write(LEGACY_RAW.path, LEGACY_RAW.content);
  files.push(LEGACY_RAW.path);
  for (const node of MOCK_NODES) {
    write(node.file, stringifyFrontmatter(node.frontmatter, node.body));
    files.push(node.file);
  }
  await vault.commitFiles(files, 'seed: demo vault (mock)');
}
