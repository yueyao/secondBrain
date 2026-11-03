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

describe('文章库与管理后台', () => {
  it('文章库可打开、可筛选', async () => {
    const response = await fetch(`${base}/articles`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('文章库');

    const filtered = await fetch(`${base}/articles?state=queued`);
    expect((await filtered.text())).toContain('queued');
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

  it('管理后台可打开', async () => {
    const response = await fetch(`${base}/admin`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('管理后台');
    expect(html).toContain('今日进度');
    expect(html).toContain('运行状态');
    expect(html).toContain('状态分布');
  });
});
