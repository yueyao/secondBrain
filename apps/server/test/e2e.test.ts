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
    for (const keyword of ['GitHub 仓库与维护', '代码仓库', '知识库 vault', '原文 raw', '更新此仓库', '修改远端', '全部更新', '检查远端']) {
      expect(html).toContain(keyword);
    }
  });

  it('切换仓库远端有校验，未知仓库返回 404', async () => {
    const bad = await post('/actions/ops/repo/remote', { key: 'vault', remote: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);

    const unknown = await post('/actions/ops/repo/pull', { key: 'not-a-repo' });
    expect(unknown.status).toBe(404);
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
    // 正文里的引用渲染成可点开的原文链接
    expect(detail).toContain('/articles/raw%2F');

    const article = await runtime.ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(article?.status).toBe('review');
    expect(article?.currentVersionId).toBe(`${id}-v1`);
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
