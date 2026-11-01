/**
 * 运行时组装：真实适配器 + 内存检索 + 模型路由。
 *
 * 两种模式（ADR 0005 决策 A：全部来源走云模型）：
 * - 默认 mock：无 MODEL_BASE_URL 时使用 MockAgent，零成本、可离线演示；
 * - cloud：设置 MODEL_BASE_URL + MODEL_API_KEY + MODEL_CONFIG 后，走 OpenAI 兼容接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { recoverPending, type AppContext, type ProfilePricing } from '@sb/app';
import type { AgentPort, DigestRequest } from '@sb/contracts';
import { parseDraftId, stringifyFrontmatter } from '@sb/domain';
import { FsVault } from '@sb/adapters-vault';
import { migrate, SqliteStore } from '@sb/adapters-sqlite';
import { MemorySearch } from '@sb/adapters-search-memory';
import { LEGACY_RAW, MOCK_NODES, MOCK_RAW, MockAgent } from '@sb/testing';
import {
  AgentRunner,
  BudgetLedger,
  MemoryCompletionCache,
  parseModelPolicy,
  type PromptSpec,
} from '@sb/agent-runtime';
import { OpenAICompatibleProvider } from '@sb/adapters-agent-openai';

export type AgentMode = 'mock' | 'cloud';

export interface RuntimeOptions {
  readonly dataDir: string;
  /** vault 根目录；默认 <dataDir>/vault（生产布局），可指向已有 vault */
  readonly vaultRoot?: string;
  readonly seedDemo?: boolean;
}

export interface Runtime {
  readonly ctx: AppContext;
  readonly vault: FsVault;
  readonly store: SqliteStore;
  readonly search: MemorySearch;
  readonly mode: AgentMode;
  close(): Promise<void>;
}

export const systemClock = { now: () => new Date().toISOString() };

const DIGEST_SYSTEM = `你是知识助产士。把用户提供的原文提炼成可长期复用的判断，而不是摘要。
只输出一个 JSON 对象，不要任何解释或 markdown 代码块。schema：
{
  "tier": "patch" | "standard" | "accelerated" | "full",
  "rationale": "为什么这样判档",
  "claims": [{ "text": "判断句（>=8 字，写成可长期召回的自然语言）", "inference": false, "source": "raw/..." }],
  "nodes": [{ "name": "节点名", "nodeType": "concept" | "topic" | "person", "action": "patch" | "new", "definition": "完整定义或 null" }]
}
规则：
- 每条 claim 的 source 必须是输入原文的路径；
- 原文没直接说、由你推断的内容必须标 inference: true；
- 优先 patch 已有节点（见"检索命中"），没有合适节点才新建；
- 不要写时效性数据、价格、榜单和行动建议。`;

const PROMPT_SHA = createHash('sha256').update(DIGEST_SYSTEM).digest('hex');

export function digestPrompt(): PromptSpec {
  return {
    id: 'digest',
    version: 1,
    sha256: PROMPT_SHA,
    system: DIGEST_SYSTEM,
    render: (request: DigestRequest) => {
      const retrieved = request.retrieved
        .map((hit) => `- ${hit.name}（${hit.file}，匹配：${hit.matchType}）`)
        .join('\n');
      return [
        `原文路径：${request.rawPath}`,
        retrieved ? `检索命中的已有节点：\n${retrieved}` : '检索命中：无',
        '',
        '原文：',
        request.content,
      ].join('\n');
    },
  };
}

function randomHex(bytes = 6): string {
  return randomUUID().replace(/-/g, '').slice(0, bytes * 2);
}

interface AgentBuild {
  readonly agent: AgentPort;
  readonly mode: AgentMode;
  readonly pricing: Readonly<Record<string, ProfilePricing>>;
}

function buildAgent(): AgentBuild {
  const baseUrl = process.env.MODEL_BASE_URL;
  if (!baseUrl) {
    return { agent: new MockAgent(), mode: 'mock', pricing: {} };
  }

  const configPath = process.env.MODEL_CONFIG ?? path.resolve(process.cwd(), 'config/model-profiles.example.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`模型配置不存在：${configPath}（可通过 MODEL_CONFIG 指定）`);
  }
  const parsed = parseModelPolicy(JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown);
  if (!parsed.ok) {
    throw new Error(`模型配置不合法：\n- ${parsed.errors.join('\n- ')}`);
  }

  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error('缺少 MODEL_API_KEY（不要写进配置文件或日志）');

  const provider = new OpenAICompatibleProvider({
    baseUrl,
    apiKey,
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS ?? 120_000),
  });

  const agent = new AgentRunner({
    provider,
    profiles: parsed.value.profiles,
    policies: parsed.value.policies,
    cache: new MemoryCompletionCache(),
    budget: new BudgetLedger(parsed.value.budget, systemClock),
    clock: systemClock,
    prompt: digestPrompt(),
  });

  const pricing: Record<string, ProfilePricing> = {};
  for (const profile of parsed.value.profiles) pricing[profile.id] = profile.pricing;

  return { agent, mode: 'cloud', pricing };
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const vaultRoot = options.vaultRoot ? path.resolve(options.vaultRoot) : path.join(dataDir, 'vault');
  const vault = FsVault.open({ root: vaultRoot });
  const store = SqliteStore.open({ path: path.join(dataDir, 'state.db'), clock: systemClock });
  migrate(store.database, systemClock);

  if (options.seedDemo !== false) await seedDemoVault(vault);

  const search = new MemorySearch(vault);
  await search.refresh();

  const built = buildAgent();
  const ctx: AppContext = {
    store,
    vault,
    search,
    agent: built.agent,
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
      longTextThreshold: Number(process.env.LONG_TEXT_THRESHOLD ?? 200_000),
      enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'],
    },
    pricing: built.pricing,
    hash: { sha256: (text) => createHash('sha256').update(text).digest('hex') },
  };

  // 简化版 P5：启动时把 approved 但未完成的草稿重放一次；脏工作区则拒绝启动
  const recovery = await recoverPending(ctx);
  if (recovery.recovered.length > 0) {
    console.log(`[recover] 已重放 ${recovery.recovered.length} 个待提交草稿`);
  }
  if (recovery.failed.length > 0) {
    console.warn(`[recover] ${recovery.failed.length} 个草稿回滚待人工：${recovery.failed.map((entry) => entry.draftId).join(', ')}`);
  }

  return {
    ctx,
    vault,
    store,
    search,
    mode: built.mode,
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
