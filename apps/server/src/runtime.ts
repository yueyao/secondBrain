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
import type { AgentPort, ComposePort, ComposeRequest, DeAiPort, DeAiRequest, DigestRequest } from '@sb/contracts';
import { parseDraftId, stringifyFrontmatter } from '@sb/domain';
import { FsVault } from '@sb/adapters-vault';
import { migrate, SqliteStore } from '@sb/adapters-sqlite';
import { MemorySearch } from '@sb/adapters-search-memory';
import { LEGACY_RAW, MOCK_NODES, MOCK_RAW, MockAgent, MockComposer, MockDeAi } from '@sb/testing';
import {
  AgentRunner,
  BudgetLedger,
  ComposeRunner,
  MemoryCompletionCache,
  parseModelPolicy,
  DeAiRunner,
  type ComposePromptSpec,
  type DeAiPromptSpec,
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
  readonly dataDir: string;
  readonly vaultRoot: string;
  close(): Promise<void>;
}

export const systemClock = { now: () => new Date().toISOString() };

const DIGEST_SYSTEM = `你是知识助产士。把用户提供的原文提炼成可长期复用的判断，而不是摘要。
只输出一个 JSON 对象，不要任何解释或 markdown 代码块。schema：
{
  "tier": "patch" | "standard" | "accelerated" | "full",
  "rationale": "为什么这样判档",
  "claims": [{ "text": "判断句（>=8 字，写成可长期召回的自然语言）", "inference": false, "source": "raw/..." }],
  "nodes": [{ "name": "节点名", "nodeType": "concept" | "topic" | "person", "action": "patch" | "new", "definition": "完整定义或 null", "claimIndexes": [0, 2] }]
}
规则：
- 每条 claim 的 source 必须是输入原文的路径；
- 原文没直接说、由你推断的内容必须标 inference: true；
- 优先 patch 已有节点（见"检索命中"），没有合适节点才新建；
- claimIndexes 是"这个节点由哪几条 claims 支撑"的下标（从 0 开始，至少 1 个，不要把所有下标都塞给每个节点）；
- 不要写时效性数据、价格、榜单和行动建议。`;

const PROMPT_SHA = createHash('sha256').update(DIGEST_SYSTEM).digest('hex');

export function digestPrompt(): PromptSpec {
  return {
    id: 'digest',
    version: 2,
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

const OUTLINE_SYSTEM = `你是资深主编。基于给定的知识节点与 claims，为文章生成一份可执行的中文大纲。
规则：
- 4-7 节，每节 3-6 个要点；节标题用 Markdown "## 一、标题" 形式，要点用 "- " 开头；
- 每个要点写清"要论证什么"，并注明依据哪个节点的哪条判断；
- 只能使用给定 claims 里的信息，不编造知识库以外的内容；
- 只输出 Markdown 大纲，不要解释、不要代码块。`;

const BODY_SYSTEM = `你是资深主编，负责把已确认的大纲写成可发表的中文文章。
规则：
- 严格按大纲的小节结构写；开头写一段导语，每个小节 2-5 段；
- 每一个来自知识库的判断，必须在句末用"（来源：[[raw/路径]]）"标注来源，路径必须原样取自材料里的 claims 来源，不要改写、不要只写节点名；
- 不要编造材料之外的事实、数据、人名、价格或案例；需要例子时只用材料里的；
- 只输出 Markdown 正文（## 小节标题 + 段落），不要解释、不要代码块。`;

/** 把文章标题、大纲与节点 claims 渲染成模型输入。 */
function renderComposeInput(request: ComposeRequest): string {
  const nodes = request.nodes
    .map((node) => [
      `## 节点：${node.name}（${node.nodeType}）`,
      node.claims.map((claim) => `- ${claim.text}\n  来源：${claim.source}`).join('\n'),
    ].join('\n'))
    .join('\n\n');
  return [
    `文章标题：${request.title}`,
    `主题：${request.theme || '未设定'}`,
    ...(request.outline ? ['', '已确认大纲：', request.outline] : []),
    ...(request.instruction ? ['', '改稿指令：', request.instruction] : []),
    '',
    '材料（知识节点与 claims）：',
    nodes,
  ].join('\n');
}

export function composePrompts(): Readonly<Record<'outline' | 'body', ComposePromptSpec>> {
  return {
    outline: {
      id: 'compose-outline',
      version: 1,
      sha256: createHash('sha256').update(OUTLINE_SYSTEM).digest('hex'),
      system: OUTLINE_SYSTEM,
      render: renderComposeInput,
    },
    body: {
      id: 'compose-body',
      version: 1,
      sha256: createHash('sha256').update(BODY_SYSTEM).digest('hex'),
      system: BODY_SYSTEM,
      render: renderComposeInput,
    },
  };
}

const DEAI_STYLE_LABEL: Readonly<Record<DeAiRequest['style'], string>> = {
  auto: '自动（按内容判断）',
  casual: '更口语、更像聊天',
  formal: '更书面、接近正式发表',
  opinion: '允许明确立场与判断',
};

const DEAI_SYSTEM = `你是中文写作编辑，任务是去除文本的“AI 味”，让文字读起来像真人写的。
硬规则（先保信息，再谈风格）：
1. 不新增原文没有的事实、数字、人名、日期、引语、出处；不得虚构第一人称经历；观点可以换表达，但立场和归属不能变。
2. 所有“（来源：[[raw/...]]）”引用标记必须原样保留：不得删除、不得改写路径、不得新增来源。
3. 保留原文全部信息点与论点；可以调整详略与段落划分，但不许删掉关键信息。
4. 清除框架路标词（首先/其次/最后/总之/综上所述/值得注意的是/由此可见/不难发现 等），逻辑靠前后句自然承接。
5. 拆掉“不是X，而是Y”“不仅…而且…”“一方面…另一方面…”式否定二分与排比堆砌，改成朴素、具体的陈述。
6. 砍掉宏大开场与升华结尾（随着…的发展、未来可期、让我们拭目以待 等），直接说事。
7. 减少形容词、副词、宣传腔与万能动词（进行/作出/赋能/抓手/闭环 等），把空泛表达换成具体对象、动作与场景（细节只能来自原文）。
8. 句长要有变化：重要处写长，次要处写短，长短句交替；不要每段结构一模一样。带引用的句子也要重写，只把“（来源：[[raw/...]]）”留在对应句末；整句照抄视为失败。
9. 篇幅与原文相当（±30%）；如果原文 AI 套话很多、删完后明显变短，这是正常的，但不得删掉具体信息点（数字、人名、引语、引用、事件）。
10. 只输出改写后的全文：不要解释、不要标题前缀、不要代码块标记，不要输出“修改说明”。
文风按输入指定的目标文体处理；公文、学术、新闻通稿的规范用语不必强行口语化。`;

function renderDeAiInput(request: DeAiRequest): string {
  const issues = request.issues.length > 0
    ? request.issues.map((issue) => `- ${issue.label} ×${issue.count}${issue.examples.length > 0 ? `，例：${issue.examples.join(' / ')}` : ''}`).join('\n')
    : '- （体检未命中明显模式，仍按硬规则整体润色）';
  const citations = request.keepCitations.length > 0
    ? request.keepCitations.map((source) => `- （来源：[[${source}]]）`).join('\n')
    : '- （原文没有 raw 引用）';
  return [
    `文章标题：${request.title ?? '（未命名）'}`,
    `目标文体：${DEAI_STYLE_LABEL[request.style]}`,
    '',
    '需要清除的 AI 味项：',
    issues,
    '',
    '必须原样保留的引用标记：',
    citations,
    ...(request.instruction ? ['', `额外要求：${request.instruction}`] : []),
    '',
    '原文：',
    request.text,
  ].join('\n');
}

export function deAiPrompt(): DeAiPromptSpec {
  return {
    id: 'deai',
    version: 3,
    sha256: createHash('sha256').update(DEAI_SYSTEM).digest('hex'),
    system: DEAI_SYSTEM,
    render: renderDeAiInput,
  };
}

interface AgentBuild {
  readonly agent: AgentPort;
  readonly composer: ComposePort;
  readonly deAi: DeAiPort;
  readonly mode: AgentMode;
  readonly pricing: Readonly<Record<string, ProfilePricing>>;
}

function buildAgent(): AgentBuild {
  const baseUrl = process.env.MODEL_BASE_URL;
  if (!baseUrl) {
    return {
      agent: new MockAgent(),
      composer: new MockComposer(),
      deAi: new MockDeAi(),
      mode: 'mock',
      pricing: {},
    };
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

  // 主编台与 digest 共用同一份 profile/策略/预算账本（ADR 0005）
  const budget = new BudgetLedger(parsed.value.budget, systemClock);

  const agent = new AgentRunner({
    provider,
    profiles: parsed.value.profiles,
    policies: parsed.value.policies,
    cache: new MemoryCompletionCache(),
    budget,
    clock: systemClock,
    prompt: digestPrompt(),
  });

  const composer = new ComposeRunner({
    provider,
    profiles: parsed.value.profiles,
    policies: parsed.value.policies,
    budget,
    clock: systemClock,
    prompts: composePrompts(),
  });

  const deAi = new DeAiRunner({
    provider,
    profiles: parsed.value.profiles,
    policies: parsed.value.policies,
    budget,
    clock: systemClock,
    prompt: deAiPrompt(),
  });

  const pricing: Record<string, ProfilePricing> = {};
  for (const profile of parsed.value.profiles) pricing[profile.id] = profile.pricing;

  return { agent, composer, deAi, mode: 'cloud', pricing };
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
    composer: built.composer,
    deAi: built.deAi,
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
    dataDir,
    vaultRoot,
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
