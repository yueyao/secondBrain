/** 端到端：启动真实 HTTP 服务（mock 数据 + 内存实现），走一遍人审闭环。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime';
import { createServer } from '../src/server';

let runtime: Runtime;
let server: ReturnType<typeof createServer>;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  runtime = await createRuntime({ dataDir, seedDemo: true });
  server = createServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, form: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });

describe('HTTP 审核台', () => {
  it('首页可打开且包含操作入口', async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('secondBrain 审核台');
    expect(html).toContain('扫描 raw/ 并分档');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('扫描→起草→审阅→入库 全链路', async () => {
    expect((await post('/actions/ingest', {})).status).toBe(303);

    const queueResponse = await fetch(`${base}/api/queue`);
    const queue = (await queueResponse.json()) as Array<{ rawPath: string; title: string }>;
    const target = queue.find((item) => item.title.includes('反脆弱'));
    expect(target).toBeTruthy();

    const digestResponse = await post('/actions/digest', { rawPath: target!.rawPath });
    expect(digestResponse.status).toBe(303);
    const reviewPath = digestResponse.headers.get('location') ?? '';
    expect(reviewPath.startsWith('/review/')).toBe(true);

    const reviewHtml = await (await fetch(`${base}${reviewPath}`)).text();
    expect(reviewHtml).toContain('反脆弱');
    expect(reviewHtml).toContain('通过并入库');

    const draftId = reviewPath.replace('/review/', '');
    const acceptResponse = await post(`/review/${draftId}/accept`, {});
    expect(acceptResponse.status).toBe(303);

    const content = await runtime.vault.readNode('wiki/concepts/反脆弱.md');
    expect(content).toContain('mock-2026-10-01 反脆弱的第二条证据.md');

    const health = (await (await fetch(`${base}/api/health`)).json()) as { head: string | null };
    expect(health.head).toBeTruthy();
  });

  it('JSON 读模型可用（队列/搜索/审阅）', async () => {
    const searchResponse = await fetch(`${base}/api/search?q=${encodeURIComponent('反脆弱')}`);
    const hits = (await searchResponse.json()) as Array<{ name: string }>;
    expect(hits[0]?.name).toBe('反脆弱');
  });
});

describe('素材库与管理后台', () => {
  it('素材库可打开、可筛选', async () => {
    const response = await fetch(`${base}/articles`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('素材库');

    const filtered = await fetch(`${base}/articles?state=queued`);
    expect((await filtered.text())).toContain('待处理');
  });

  it('文章详情可打开', async () => {
    const payload = (await (await fetch(`${base}/api/queue`)).json()) as
      | { items: { rawPath: string; title: string }[] }
      | { rawPath: string; title: string }[];
    const items = Array.isArray(payload) ? payload : payload.items;
    const first = items[0];
    expect(first).toBeTruthy();
    const response = await fetch(`${base}/articles/${encodeURIComponent(first!.rawPath)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(first!.title);
  });

  it('运维页展示 GitHub 仓库状态与维护入口', async () => {
    const response = await fetch(`${base}/operations`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const keyword of ['GitHub 仓库与维护', '代码仓库', '知识库 vault', '原文 raw', '更新此仓库', '推送此仓库', '修改远端', '全部更新', '检查远端']) {
      expect(html).toContain(keyword);
    }
  });

  it('切换仓库远端有校验，未知仓库返回 404', async () => {
    const bad = await post('/actions/ops/repo/remote', { key: 'vault', remote: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);

    const unknown = await post('/actions/ops/repo/pull', { key: 'not-a-repo' });
    expect(unknown.status).toBe(404);

    const unknownPush = await post('/actions/ops/repo/push', { key: 'not-a-repo' });
    expect(unknownPush.status).toBe(404);
  });

  it('运维中心可打开，/admin 301 过去', async () => {
    const redirect = await fetch(`${base}/admin`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/operations');

    const response = await fetch(`${base}/operations`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('运维中心');
    expect(html).toContain('今日进度');
    expect(html).toContain('运行状态');
    expect(html).toContain('队列与状态');
  });
});

describe('主编台 Compose（AI 大纲 + 正文版本链）', () => {
  /** 创建一篇文章并返回 id：先走表单路由，再从状态库读最新一篇。 */
  async function createComposeArticle(nodes: readonly string[]): Promise<string> {
    const form = new URLSearchParams({ title: '主编台端到端测试文章', theme: '写作' });
    for (const node of nodes) form.append('node', node);
    const response = await fetch(`${base}/actions/compose/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    const articles = await runtime.ctx.store.transaction(async (tx) => tx.articles.list());
    const latest = articles[0];
    expect(latest).toBeTruthy();
    return latest!.id;
  }

  /** 从 wiki 索引里挑有 claims 的节点。 */
  function nodesWithClaims(limit: number): string[] {
    return runtime.ctx.search
      .allDocs()
      .filter((doc) => doc.body.includes('来源：[[raw/'))
      .slice(0, limit)
      .map((doc) => doc.name);
  }

  it('未确认大纲时不能生成正文（按钮禁用，接口拒绝）', async () => {
    const id = await createComposeArticle(nodesWithClaims(2));
    const page = await fetch(`${base}/compose/${encodeURIComponent(id)}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<button class="btn" type="submit" disabled>生成正文 v1</button>');

    const blocked = await post('/actions/compose/body/generate', { id });
    expect(blocked.status).toBe(500);
    expect(await blocked.text()).toContain('大纲');
  });

  it('AI 生成大纲 → 生成正文 v1 → 版本进入待主编审', async () => {
    const id = await createComposeArticle(nodesWithClaims(2));

    const outline = await post('/actions/compose/outline/generate', { id });
    expect(outline.status).toBe(303);
    const afterOutline = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(afterOutline).toContain('<button class="btn" type="submit">生成正文 v1</button>');

    const body = await post('/actions/compose/body/generate', { id });
    expect(body.status).toBe(303);
    const detail = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(detail).toContain('版本历史（1）');
    expect(detail).toContain('AI 初稿');
    expect(detail).toContain('待主编审');
    // 写作契约与审引清单
    expect(detail).toContain('写作契约');
    expect(detail).toContain('审引清单');
    expect(detail).toContain('审引通过');
    // 正文里的引用渲染成可点开的原文链接
    expect(detail).toContain('/articles/raw%2F');

    const article = await runtime.ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(article?.status).toBe('review');
    expect(article?.currentVersionId).toBe(`${id}-v1`);

    // 问答链：mock 下直接基于正文生成 Q-A 链
    const qa = await post('/actions/qa', { source: `article:${id}`, count: '4', focus: '' });
    expect(qa.status).toBe(200);
    const qaHtml = await qa.text();
    expect(qaHtml).toContain('问答链 ·《');
    expect(qaHtml).toContain('Q1.');
    expect(qaHtml).toContain('边界');
    expect(qaHtml).toContain('结论');
  });

  it('再次生成正文生成 v2（版本只增不改）', async () => {
    const id = await createComposeArticle(nodesWithClaims(2));
    await post('/actions/compose/outline/generate', { id });
    await post('/actions/compose/body/generate', { id });
    await post('/actions/compose/body/generate', { id });

    const detail = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(detail).toContain('版本历史（2）');
    expect(detail).toContain('AI 改稿');
    expect(detail).toContain('生成正文 v3');
  });
});

describe('主编台 C3/C4（改稿/对比/恢复/定稿/导出）', () => {
  const versionsOf = (id: string) => runtime.ctx.store.transaction(async (tx) => tx.articleVersions.listByArticle(id));

  const nodesWithClaims = (): string[] =>
    runtime.ctx.search
      .allDocs()
      .filter((doc) => doc.body.includes('来源：[[raw/'))
      .slice(0, 2)
      .map((doc) => doc.name);

  /** 建一篇文章并生成大纲 + 正文 v1。 */
  async function createWithBody(): Promise<string> {
    const form = new URLSearchParams({ title: 'C3C4 测试文章', theme: '写作' });
    for (const node of nodesWithClaims()) form.append('node', node);
    const created = await fetch(`${base}/actions/compose/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(created.status).toBe(303);
    const articles = await runtime.ctx.store.transaction(async (tx) => tx.articles.list());
    const id = articles[0]!.id;
    await post('/actions/compose/outline/generate', { id });
    await post('/actions/compose/body/generate', { id });
    return id;
  }

  it('改稿指令生成 v2，并记录指令与 basedOn', async () => {
    const id = await createWithBody();
    const response = await post('/actions/compose/refine', { id, instruction: '结尾改成三条可执行建议' });
    expect(response.status).toBe(303);

    const versions = await versionsOf(id);
    expect(versions.map((version) => version.versionNo)).toEqual([2, 1]);
    expect(versions[0]?.source).toBe('ai_refine');
    expect(versions[0]?.instruction).toBe('结尾改成三条可执行建议');
    expect(versions[0]?.basedOnVersionId).toBe(`${id}-v1`);

    const detail = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(detail).toContain('版本历史（2）');
    expect(detail).toContain('结尾改成三条可执行建议');
    expect(detail).toContain('对比当前');
    expect(detail).toContain('恢复此版');
  });

  it('版本对比页展示行级新增/删除', async () => {
    const id = await createWithBody();
    await post('/actions/compose/refine', { id, instruction: '把结尾改成三条可执行建议' });
    const versions = await versionsOf(id);
    const v2 = versions[0]!;
    const v1 = versions[1]!;

    const response = await fetch(
      `${base}/compose/${encodeURIComponent(id)}/diff?from=${encodeURIComponent(v1.id)}&to=${encodeURIComponent(v2.id)}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('版本对比');
    expect(html).toContain('新增 2');
    expect(html).toContain('删除 0');
    expect(html).toContain('<tr class="diff-add">');
    expect(html).toContain('改稿要求');

    const missing = await fetch(
      `${base}/compose/${encodeURIComponent(id)}/diff?from=not-a-version&to=${encodeURIComponent(v2.id)}`,
    );
    expect(missing.status).toBe(404);
  });

  it('恢复旧版本 / 定稿 / 导出 Markdown / 重新打开', async () => {
    const id = await createWithBody();
    await post('/actions/compose/refine', { id, instruction: '更克制一些' });
    const versions = await versionsOf(id);
    const v1 = versions[1]!;

    const restore = await post('/actions/compose/restore', { id, versionId: v1.id });
    expect(restore.status).toBe(303);
    const afterRestore = await versionsOf(id);
    expect(afterRestore[0]?.versionNo).toBe(3);
    expect(afterRestore[0]?.source).toBe('restore');
    expect(afterRestore[0]?.note).toBe('恢复自 v1');
    expect(afterRestore[0]?.contentMd).toBe(v1.contentMd);
    expect(afterRestore[0]?.provider).toBeNull();

    const finalized = await post('/actions/compose/finalize', { id });
    expect(finalized.status).toBe(303);
    let article = await runtime.ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(article?.status).toBe('final');
    const finalPage = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(finalPage).toContain('已定稿');
    expect(finalPage).toContain('重新打开');
    expect(finalPage).toContain('导出 Markdown');

    const exported = await fetch(`${base}/compose/${encodeURIComponent(id)}/export.md`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/markdown');
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    const markdown = await exported.text();
    expect(markdown.startsWith('# ')).toBe(true);
    expect(markdown).toContain('C3C4 测试文章');
    expect(markdown).toContain('已定稿');
    expect(markdown).toContain('## 引用来源');
    expect(markdown).toContain('[[raw/');

    const reopened = await post('/actions/compose/reopen', { id });
    expect(reopened.status).toBe(303);
    article = await runtime.ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(article?.status).toBe('review');
    const reopenedPage = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(reopenedPage).toContain('待主编审');
  });
});

describe('关于页（功能地图）', () => {
  it('关于页可打开，介绍工作台全部功能并带实时数据', async () => {
    const response = await fetch(`${base}/about`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const keyword of ['关于本工作台', '工作流', '功能地图', '核心概念', '系统能力', '运行信息', '主编台', '审核中心', '运维中心', '使用说明', '导出 Markdown']) {
      expect(html).toContain(keyword);
    }
    // 导航里有「关于」入口
    expect(html).toContain('href="/about"');
  });
});

describe('去 AI 味（独立能力）', () => {
  const AI_TEXT = [
    '首先，随着人工智能技术的不断发展，我们已经进入一个全新的时代。',
    '其次，AI 正在赋能千行百业，打造闭环生态，成为不可或缺的底层逻辑。',
    '值得注意的是，这不是一次简单的升级，而是一场深刻的革命。',
    '由此可见，AI 必将带来深远影响，未来可期。',
    '最后，希望本文对你有帮助，欢迎在评论区留言讨论。',
  ].join('');

  it('体检页可打开并列出检测项', async () => {
    const response = await fetch(`${base}/deai`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('去 AI 味');
    expect(html).toContain('检测项与权重');
    expect(html).toContain('框架路标词');
    expect(html).toContain('先做体检');
  });

  it('确定性体检能命中框架词、黑话、宏大叙事与套话', async () => {
    const response = await post('/actions/deai/analyze', { text: AI_TEXT, style: 'auto' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('AI 味体检');
    for (const label of ['框架路标词', 'AI 高频词与黑话', '宏大叙事与意义拔高', '套话结尾与对话残留']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('/ 100');
  });

  it('改写走 MockDeAi：保引用、给出改写后体检', async () => {
    const withCitation = `${AI_TEXT}（来源：[[raw/knowledge/cubox/e2e.md]]）`;
    const response = await post('/actions/deai/rewrite', { text: withCitation, style: 'casual' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('改写结果');
    expect(html).toContain('改写后体检');
    expect(html).toContain('raw/knowledge/cubox/e2e.md');
  });

  it('主编台正文可一键去 AI 味并生成新版本', async () => {
    const form = new URLSearchParams({ title: '去 AI 味端到端文章', theme: '写作' });
    for (const doc of runtime.ctx.search.allDocs().filter((entry) => entry.body.includes('来源：[[raw/')).slice(0, 2)) {
      form.append('node', doc.name);
    }
    const created = await fetch(`${base}/actions/compose/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(created.status).toBe(303);
    const articles = await runtime.ctx.store.transaction(async (tx) => tx.articles.list());
    const id = articles[0]!.id;
    await post('/actions/compose/outline/generate', { id });
    await post('/actions/compose/body/generate', { id });
    const response = await post('/actions/compose/deai', { id });
    expect(response.status).toBe(303);
    const versions = await runtime.ctx.store.transaction(async (tx) => tx.articleVersions.listByArticle(id));
    expect(versions[0]?.source).toBe('deai');
    expect(versions[0]?.note).toContain('去 AI 味：');
    const page = await (await fetch(`${base}/compose/${encodeURIComponent(id)}`)).text();
    expect(page).toContain('去 AI 味');
  });
});

describe('导航信息架构（一级分组 + 二级菜单）', () => {
  it('一级导航收敛为 6 个入口，其余页面收进分组菜单', async () => {
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain('class="nav-group"');
    for (const label of ['工作台', '内容', '知识', '写作', '运维', '帮助']) {
      expect(home).toContain(label);
    }
    for (const href of ['/articles', '/review', '/exceptions', '/nodes', '/topics', '/claims', '/kb-health', '/search', '/compose', '/deai', '/qa', '/operations', '/usage', '/guide', '/about']) {
      expect(home).toContain(`href="${href}"`);
    }
    // 首页：工作台 active；主编台：写作分组 active
    expect(home).toMatch(/nav-item active"[^>]*>工作台/);
    const compose = await (await fetch(`${base}/compose`)).text();
    expect(compose).toMatch(/nav-item active">写作/);
    const operations = await (await fetch(`${base}/operations`)).text();
    expect(operations).toMatch(/nav-item active">运维/);
  });
});

describe('展示时间（去掉 ISO 的 T、转本地时区）', () => {
  it('运维页与主编台不再出现带 T 的 ISO 时间', async () => {
    const ops = await (await fetch(`${base}/operations`)).text();
    expect(ops).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(ops).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    const compose = await (await fetch(`${base}/compose`)).text();
    expect(compose).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(compose).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});


describe('知识库体检页（只读）', () => {
  it('体检页可打开并给出统计与问题分类', async () => {
    const response = await fetch(`${base}/kb-health`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const keyword of ['知识库体检', '链接健康', '节点完整性', 'claims 健康', '处理建议', '知识节点', 'raw 来源缺失', '孤立节点', '重复 claims']) {
      expect(html).toContain(keyword);
    }
  });
});


describe('主题地图页（只读）', () => {
  it('主题页可打开并给出主题清单、文章覆盖与缺口提示', async () => {
    const response = await fetch(`${base}/topics`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const keyword of ['主题地图', '主题清单', '文章覆盖', '缺口提示', '有料但未成文', '无 claims 主题', '无来源主题', '筛选']) {
      expect(html).toContain(keyword);
    }
  });
});


describe('问答链页（只读工具）', () => {
  it('GET /qa 可打开并给出来源选择与生成表单', async () => {
    const response = await fetch(`${base}/qa`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const keyword of ['问答链', '生成问答链', '聚焦', '选题与审稿工具', '不写入文章版本']) {
      expect(html).toContain(keyword);
    }
  });
});

describe('长列表收敛（分页/折叠）', () => {
  it('/claims 有分页条，不再全量渲染', async () => {
    const response = await fetch(`${base}/claims`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('pager');
    expect(html).toContain('条 / 共');
    expect(html).toContain('筛选判断句');
    expect(html).toContain('全量');
    expect(html).not.toContain('扫描上限');
  });

  it('/nodes 枢纽图折叠、节点清单有分页', async () => {
    const response = await fetch(`${base}/nodes`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('展开知识枢纽图');
    expect(html).toContain('节点清单');
    expect(html).toContain('pager-meta');
  });
});


describe('审核批量通过（异步）', () => {
  it('JSON 提交立即返回 jobId，后台完成并逐篇入库', async () => {
    await post('/actions/ingest', {});
    const queue = (await (await fetch(`${base}/api/queue`)).json()) as Array<{ rawPath: string; title: string }>;
    const target = queue.find((item) => item.title.includes('安全边际')) ?? queue[0];
    expect(target).toBeTruthy();
    const digest = await post('/actions/digest', { rawPath: target!.rawPath });
    expect(digest.status).toBe(303);
    const draftId = (digest.headers.get('location') ?? '').replace('/review/', '');
    expect(draftId).not.toBe('');

    // 浏览器 FormData 走 multipart，服务端必须能解析到 draftId
    const form = new FormData();
    form.append('draftId', draftId);
    const created = await fetch(`${base}/actions/review/bulk-accept`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: form,
    });
    expect(created.status).toBe(200);
    const job = (await created.json()) as { ok: boolean; jobId: string; total: number };
    expect(job.ok).toBe(true);
    expect(job.total).toBe(1);

    type JobState = { status: string; done: number; ok: number; failed: number };
    let state: JobState | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      state = (await (await fetch(`${base}/api/jobs/${job.jobId}`)).json()) as JobState;
      if (state?.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state?.status).toBe('done');
    expect(state?.ok).toBe(1);
    expect(state?.failed).toBe(0);

    const empty = await fetch(`${base}/actions/review/bulk-accept`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as { ok: boolean; error?: { code?: string } };
    expect(emptyBody.ok).toBe(false);
    expect(emptyBody.error?.code).toBe('NO_DRAFTS');

    const reviewHtml = await (await fetch(`${base}/review`)).text();
    expect(reviewHtml).toContain('批量通过');
    expect(reviewHtml).toContain('已选 0 项');
  });
});

describe('内联脚本可解析（防止模板字符串换行回归）', () => {
  it('主要页面脚本语法正确', async () => {
    for (const path of ['/', '/review', '/compose', '/deai', '/qa', '/nodes', '/articles']) {
      const html = await (await fetch(`${base}${path}`)).text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] as string);
      expect(scripts.length, `${path} 应有内联脚本`).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(() => new Function(script), `${path} 内联脚本语法错误`).not.toThrow();
      }
    }
  });
});
