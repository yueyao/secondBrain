/** HTTP 层：服务端渲染审核台 + JSON API（无依赖，node:http）。 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface BulkJob { total: number; done: number; ok: number; failed: number; status: 'running' | 'done'; }
const bulkJobs = new Map<string, BulkJob>();

interface OpsRecord { readonly action: string; readonly at: string; readonly ok: boolean; readonly detail: string; }

function readOps(dataDir: string): OpsRecord[] {
  try {
    return (JSON.parse(fs.readFileSync(join(dataDir, 'last-ops.json'), 'utf8')) as OpsRecord[]).slice(-5);
  } catch {
    return [];
  }
}

function recordOps(dataDir: string, record: OpsRecord): void {
  const next = [...readOps(dataDir), record].slice(-10);
  fs.writeFileSync(join(dataDir, 'last-ops.json'), JSON.stringify(next, null, 2));
}

async function runLogged(dataDir: string, action: string, fn: () => Promise<string>): Promise<string> {
  try {
    const detail = await fn();
    recordOps(dataDir, { action, at: new Date().toISOString(), ok: true, detail });
    return detail;
  } catch (error) {
    const detail = String((error as Error).message ?? error).slice(0, 300);
    recordOps(dataDir, { action, at: new Date().toISOString(), ok: false, detail });
    return detail;
  }
}
import {
  decideReview,
  draftDigest,
  ingestAndTriage,
  listPendingDrafts,
  listQueue,
  reviewView,
  searchWiki,
  usageSummary,
  listArticles,
  articleDetail,
  adminSummary,
  overview,
  pendingReviewList,
  wikiClaims,
  listWikiNodes,
  wikiNodeDetail,
  nodeStats,
  createArticle,
  listComposeArticles,
  saveArticleOutline,
  composeArticleView,
  generateArticleOutline,
  generateArticleBody,
  refineArticle,
  restoreArticleVersion,
  composeArticleDiff,
  finalizeArticle,
  reopenArticle,
  exportArticleMarkdown,
  deAiText,
  deAiArticleVersion,
} from '@sb/app';
import type { DeAiStyle } from '@sb/contracts';
import { analyzeAiFlavor, parseDraftId, parseRawPath, type DraftId, type RawPath } from '@sb/domain';
import type { Runtime } from './runtime';
import { aboutPage, adminPage, deAiPage, articlePage, articlesPage, claimsPage, composeArticlePage, composeDiffPage, composePage, dashboard, errorPage, guidePage, nodePage, nodesPage, reviewListPage, reviewPage, searchPage, usagePage } from './views';

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

function sendHtml(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

/** 附件下载：中文文件名按 RFC 5987 编码，filename 兜底用 ASCII。 */
function sendDownload(res: http.ServerResponse, filename: string, content: string): void {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': Buffer.byteLength(content),
  });
  res.end(content);
}

async function readFormParams(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(body));
}

function draftIdOf(value: string): DraftId {
  const parsed = parseDraftId(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function rawPathOf(value: string): RawPath {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

async function counts(runtime: Runtime) {
  const items = await runtime.store.transaction(async (tx) => tx.rawItems.listAll());
  return {
    items: items.length,
    queued: items.filter((item) => item.state.kind === 'queued').length,
    committed: items.filter((item) => item.state.kind === 'committed').length,
    deferred: items.filter((item) => item.state.kind === 'deferred').length,
  };
}

export function createServer(runtime: Runtime): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = decodeURIComponent(url.pathname);

    try {
      if (req.method === 'GET' && path === '/') {
        const today = runtime.ctx.clock.now().slice(0, 10);
        const [queue, pending, stats, usage] = await Promise.all([
          listQueue(runtime.ctx),
          listPendingDrafts(runtime.ctx),
          counts(runtime),
          usageSummary(runtime.ctx, { day: today }),
        ]);
        return sendHtml(res, dashboard({
          mode: runtime.mode,
          queue,
          pending,
          counts: stats,
          usage: {
            calls: usage.totals.calls,
            inputTokens: usage.totals.inputTokens,
            outputTokens: usage.totals.outputTokens,
            estimatedCost: usage.totals.estimatedCost,
          },
        }));
      }

      if (req.method === 'GET' && path === '/usage') {
        return sendHtml(res, usagePage(await usageSummary(runtime.ctx)));
      }

      if (req.method === 'GET' && path === '/compose') {
        return sendHtml(res, composePage({
          articles: await listComposeArticles(runtime.ctx),
          nodes: (await listWikiNodes(runtime.ctx)).slice(0, 20).map((node) => ({ name: node.name, claimCount: node.claimCount })),
        }));
      }
      if (req.method === 'POST' && path === '/actions/compose/create') {
        const params = await readFormParams(req);
        const nodes = params.getAll('node');
        const id = `article-${Date.now().toString(36)}`;
        await createArticle(runtime.ctx, id, { title: params.get('title') ?? '', theme: params.get('theme') ?? '', nodeIds: nodes });
        return redirect(res, '/compose');
      }
      if (req.method === 'POST' && path === '/actions/compose/outline/generate') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await generateArticleOutline(runtime.ctx, id);
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/body/generate') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await generateArticleBody(runtime.ctx, id);
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/refine') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await refineArticle(runtime.ctx, id, form.instruction ?? '');
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/restore') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await restoreArticleVersion(runtime.ctx, id, form.versionId ?? '');
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/deai') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await deAiArticleVersion(runtime.ctx, id);
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/finalize') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await finalizeArticle(runtime.ctx, id);
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      if (req.method === 'POST' && path === '/actions/compose/reopen') {
        const form = await readForm(req);
        const id = form.id ?? '';
        await reopenArticle(runtime.ctx, id);
        return redirect(res, `/compose/${encodeURIComponent(id)}`);
      }
      const composeDiffMatch = /^\/compose\/([^/]+)\/diff$/.exec(path);
      if (req.method === 'GET' && composeDiffMatch) {
        const id = composeDiffMatch[1] as string;
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        const diff = await composeArticleDiff(runtime.ctx, id, from, to);
        if (!diff) return sendHtml(res, errorPage('版本对比失败：文章或版本不存在'), 404);
        return sendHtml(res, composeDiffPage(diff));
      }
      const composeExportMatch = /^\/compose\/([^/]+)\/export\.md$/.exec(path);
      if (req.method === 'GET' && composeExportMatch) {
        const id = composeExportMatch[1] as string;
        const exported = await exportArticleMarkdown(runtime.ctx, id);
        return sendDownload(res, exported.filename, exported.markdown);
      }
      if (req.method === 'GET' && path.startsWith('/compose/')) {
        const id = decodeURIComponent(path.slice('/compose/'.length));
        const detail = await composeArticleView(runtime.ctx, id);
        if (!detail) return sendHtml(res, errorPage('文章不存在'), 404);
        return sendHtml(res, composeArticlePage(detail));
      }
      if (req.method === 'POST' && path === '/actions/compose/outline') {
        const form = await readForm(req);
        await saveArticleOutline(runtime.ctx, form.id ?? '', form.outline ?? '');
        return redirect(res, `/compose/${encodeURIComponent(form.id ?? '')}`);
      }
      if (req.method === 'GET' && path === '/nodes') {
        const url3 = new URL(req.url ?? '/', 'http://localhost');
        const type = url3.searchParams.get('type') ?? 'all';
        const q = url3.searchParams.get('q') ?? '';
        const topRaw = Number(url3.searchParams.get('top') ?? '60');
        const top = Number.isFinite(topRaw) ? Math.min(200, Math.max(20, Math.trunc(topRaw))) : 60;
        const allDocs = runtime.ctx.search.allDocs();
        const counts: Record<string, number> = { all: allDocs.length, concept: 0, topic: 0, person: 0 };
        for (const doc of allDocs) counts[doc.nodeType] = (counts[doc.nodeType] ?? 0) + 1;
        return sendHtml(res, nodesPage(await listWikiNodes(runtime.ctx, { type, q }), type, q, counts, await nodeStats(runtime.ctx), top));
      }
      if (req.method === 'GET' && path.startsWith('/nodes/')) {
        const file = decodeURIComponent(path.slice('/nodes/'.length));
        const node = await wikiNodeDetail(runtime.ctx, file);
        if (!node) return sendHtml(res, errorPage('节点不存在'), 404);
        return sendHtml(res, nodePage(node));
      }
      if (req.method === 'GET' && path === '/claims') {
        return sendHtml(res, claimsPage(await wikiClaims(runtime.ctx)));
      }
      if (req.method === 'GET' && path === '/guide') {
        return sendHtml(res, guidePage());
      }
      if (req.method === 'GET' && path === '/about') {
        const [pending, rawCounts, usage, nodeSummary, articles] = await Promise.all([
          listPendingDrafts(runtime.ctx),
          counts(runtime),
          // 数据概览里的调用/成本按"今天"统计，与工作台首页口径一致
          usageSummary(runtime.ctx, { day: runtime.ctx.clock.now().slice(0, 10) }),
          nodeStats(runtime.ctx),
          listComposeArticles(runtime.ctx),
        ]);
        let workerPhase = 'unknown';
        try {
          const status = JSON.parse(fs.readFileSync(join(runtime.dataDir, 'worker-status.json'), 'utf8')) as { phase?: string };
          workerPhase = String(status.phase ?? 'unknown');
        } catch { /* worker 未启动过：保持 unknown */ }
        return sendHtml(res, aboutPage({
          mode: runtime.mode,
          head: (await runtime.vault.head()) ?? 'unknown',
          dataDir: runtime.dataDir,
          vaultRoot: runtime.vaultRoot,
          workerPhase,
          generatedAt: runtime.ctx.clock.now(),
          stats: {
            rawTotal: rawCounts.items,
            committed: rawCounts.committed,
            queued: rawCounts.queued,
            deferred: rawCounts.deferred,
            pendingDrafts: pending.length,
            nodes: nodeSummary.total,
            claims: nodeSummary.totalClaims,
            articles: articles.length,
            calls: usage.totals.calls,
            estimatedCost: usage.totals.estimatedCost,
          },
        }));
      }
      if (req.method === 'GET' && path === '/deai') {
        return sendHtml(res, deAiPage({
          mode: runtime.mode, text: '', title: '', instruction: '', style: 'auto',
          before: null, after: null, rewritten: null, model: null, cost: null, error: null,
        }));
      }
      if (req.method === 'POST' && (path === '/actions/deai/analyze' || path === '/actions/deai/rewrite')) {
        const form = await readForm(req);
        const text = form.text ?? '';
        const rawStyle = form.style ?? 'auto';
        const styles: readonly DeAiStyle[] = ['auto', 'casual', 'formal', 'opinion'];
        const style = styles.includes(rawStyle as DeAiStyle) ? rawStyle as DeAiStyle : 'auto';
        const base = { mode: runtime.mode, text, title: form.title ?? '', instruction: '', style };
        if (text.trim() === '') {
          return sendHtml(res, deAiPage({
            ...base, before: null, after: null, rewritten: null, model: null, cost: null,
            error: '请先粘贴要处理的文本',
          }), 400);
        }
        try {
          if (path === '/actions/deai/analyze') {
            return sendHtml(res, deAiPage({
              ...base, before: analyzeAiFlavor(text), after: null, rewritten: null, model: null, cost: null, error: null,
            }));
          }
          const result = await deAiText(runtime.ctx, {
            text,
            title: form.title && form.title.trim() !== '' ? form.title.trim() : null,
            style,
          });
          return sendHtml(res, deAiPage({
            ...base,
            before: result.before,
            after: result.after,
            rewritten: result.rewritten,
            model: result.provenance.model,
            cost: result.cost,
            error: null,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return sendHtml(res, deAiPage({
            ...base, before: null, after: null, rewritten: null, model: null, cost: null, error: message,
          }), 400);
        }
      }
      if (req.method === 'GET' && path === '/exceptions') {
        return redirect(res, '/articles?group=error');
      }
      if (req.method === 'GET' && path === '/articles') {
        const data = await listArticles(runtime.ctx, {
          state: url.searchParams.get('state') ?? 'all',
          group: url.searchParams.get('group') ?? 'all',
          source: url.searchParams.get('source') ?? 'all',
          days: Number(url.searchParams.get('days') ?? '0'),
          triage: url.searchParams.get('triage') ?? 'all',
          sort: (url.searchParams.get('sort') as 'updated' | 'judgments' | 'chars' | 'title' | null) ?? 'updated',
          query: url.searchParams.get('q') ?? '',
          page: Number(url.searchParams.get('page') ?? '1'),
        });
        return sendHtml(res, articlesPage(data));
      }

      if (req.method === 'GET' && path.startsWith('/articles/')) {
        const rawPath = decodeURIComponent(path.slice('/articles/'.length));
        const detail = await articleDetail(runtime.ctx, rawPath);
        if (!detail) return sendHtml(res, errorPage('文章不存在'), 404);
        return sendHtml(res, articlePage(detail));
      }

      if (req.method === 'POST' && path === '/actions/worker/pause') {
        fs.writeFileSync(join(runtime.dataDir, 'worker-pause.json'), JSON.stringify({ pausedAt: new Date().toISOString(), by: 'ui' }));
        return redirect(res, '/admin');
      }
      if (req.method === 'POST' && path === '/actions/ops/sync') {
        await runLogged(runtime.dataDir, '同步', async () => {
          const outputs: string[] = [];
          for (const repo of [runtime.vaultRoot, join(runtime.vaultRoot, 'raw')]) {
            const { stdout } = await execFileAsync('git', ['-C', repo, 'pull', '--ff-only'], { timeout: 120_000 });
            outputs.push(stdout.trim().split('\n').pop() ?? 'ok');
          }
          return outputs.join(' / ');
        });
        return redirect(res, '/operations');
      }
      if (req.method === 'POST' && path === '/actions/ops/scan') {
        const outcomes = await runLogged(runtime.dataDir, '扫描', async () => {
          const result = await ingestAndTriage(runtime.ctx);
          return `扫描 ${result.length} 篇`;
        });
        void outcomes;
        return redirect(res, '/operations');
      }
      if (req.method === 'POST' && path === '/actions/ops/config') {
        const form = await readForm(req);
        const pendingLimit = Number(form.pendingLimit ?? '300');
        const configPath = join(runtime.dataDir, 'ops-config.json');
        fs.writeFileSync(configPath, JSON.stringify({ pendingLimit: Number.isFinite(pendingLimit) && pendingLimit > 0 ? pendingLimit : 300 }));
        return redirect(res, '/operations');
      }
      if (req.method === 'POST' && path === '/actions/ops/backup') {
        await runLogged(runtime.dataDir, '备份', async () => {
          const backupDir = join(runtime.dataDir, 'backup');
          fs.mkdirSync(backupDir, { recursive: true });
          const file = join(backupDir, `state-${new Date().toISOString().slice(0, 10)}.db`);
          await execFileAsync('sqlite3', [join(runtime.dataDir, 'state.db'), `.backup '${file}'`], { timeout: 120_000 });
          return `已备份 ${file}`;
        });
        return redirect(res, '/operations');
      }
      if (req.method === 'POST' && path === '/actions/worker/resume') {
        fs.rmSync(join(runtime.dataDir, 'worker-pause.json'), { force: true });
        return redirect(res, '/admin');
      }
      if (req.method === 'GET' && path === '/admin') {
        res.writeHead(301, { location: '/operations' });
        return res.end();
      }
      if (req.method === 'GET' && path === '/operations') {
        const summary = await adminSummary(runtime.ctx, {
          mode: runtime.mode,
          dataDir: runtime.dataDir,
          vaultRoot: runtime.vaultRoot,
        });
        let worker: Parameters<typeof adminPage>[0]['worker'] = null;
        try {
          const statusPath = join(runtime.dataDir, 'worker-status.json');
          const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
          const lastTick = parsed.lastTick as Record<string, number> | undefined;
          worker = {
            phase: String(parsed.phase ?? 'unknown'),
            updatedAt: String(parsed.updatedAt ?? ''),
            ...(parsed.rawPath ? { rawPath: String(parsed.rawPath) } : {}),
            ...(parsed.title ? { title: String(parsed.title) } : {}),
            ...(parsed.startedAt ? { startedAt: String(parsed.startedAt) } : {}),
            ...(parsed.lastTickAt ? { lastTickAt: String(parsed.lastTickAt) } : {}),
            ...(lastTick ? {
              lastTick: {
                ingested: Number(lastTick.ingested ?? 0),
                drafted: Number(lastTick.drafted ?? 0),
                failed: Number(lastTick.failed ?? 0),
                queueLength: Number(lastTick.queueLength ?? 0),
              },
            } : {}),
            stale: Date.now() - Date.parse(String(parsed.updatedAt ?? '')) > 10 * 60 * 1000,
          };
        } catch {
          worker = null;
        }

        let logs: string[] = [];
        try {
          const { stdout } = await execFileAsync('journalctl', ['-u', 'secondbrain-worker', '-n', '12', '--no-pager'], { timeout: 5_000 });
          logs = stdout.trim().split('\n').slice(-12);
        } catch {
          logs = [];
        }
        return sendHtml(res, adminPage({
          ops: readOps(runtime.dataDir),
          logs,
          pendingLimit: (() => {
            try {
              const config = JSON.parse(fs.readFileSync(join(runtime.dataDir, 'ops-config.json'), 'utf8')) as { pendingLimit?: number };
              if (typeof config.pendingLimit === 'number' && config.pendingLimit > 0) return config.pendingLimit;
            } catch { /* ignore */ }
            return Number(process.env.WORKER_MAX_PENDING_DRAFTS ?? 300);
          })(),
          paused: fs.existsSync(join(runtime.dataDir, 'worker-pause.json')),
          counts: summary.counts,
          total: summary.total,
          drafts: summary.drafts,
          queueRemaining: summary.queueRemaining,
          progress: summary.progress,
          throughput: summary.throughput,
          today: summary.today,
          worker,
          usage: {
            calls: summary.usage.totals.calls,
            inputTokens: summary.usage.totals.inputTokens,
            outputTokens: summary.usage.totals.outputTokens,
            estimatedCost: summary.usage.totals.estimatedCost,
          },
          env: summary.env,
          recentEvents: summary.recentEvents,
        }));
      }

      if (req.method === 'GET' && path === '/review') {
        const url2 = new URL(req.url ?? '/', 'http://localhost');
        return sendHtml(res, reviewListPage({
          items: await pendingReviewList(runtime.ctx),
          accepted: Number(url2.searchParams.get('ok') ?? '0'),
          failed: Number(url2.searchParams.get('failed') ?? '0'),
          jobId: url2.searchParams.get('job') ?? '',
        }));
      }
      if (req.method === 'POST' && path === '/actions/review/bulk-accept') {
        const params = await readFormParams(req);
        const draftIds = params.getAll('draftId');
        const jobId = Math.random().toString(36).slice(2, 10);
        const job: BulkJob = { total: draftIds.length, done: 0, ok: 0, failed: 0, status: 'running' };
        bulkJobs.set(jobId, job);
        void (async () => {
          for (const rawId of draftIds) {
            const parsed = parseDraftId(rawId);
            if (parsed.ok) {
              try { await decideReview(runtime.ctx, parsed.value, 'accept', { actor: 'owner', note: '批量通过' }); job.ok += 1; }
              catch { job.failed += 1; }
            } else { job.failed += 1; }
            job.done += 1;
          }
          job.status = 'done';
        })();
        return redirect(res, `/review?job=${jobId}`);
      }
      if (req.method === 'GET' && path.startsWith('/api/jobs/')) {
        return sendJson(res, bulkJobs.get(path.slice('/api/jobs/'.length)) ?? { total: 0, done: 0, ok: 0, failed: 0, status: 'done' });
      }
      if (req.method === 'GET' && path.startsWith('/review/')) {
        const view = await reviewView(runtime.ctx, draftIdOf(path.slice('/review/'.length)));
        const query = url.searchParams.get('q') ?? '';
        const hits = query ? await searchWiki(runtime.ctx, query) : [];
        return sendHtml(res, reviewPage(view, hits, query));
      }

      if (req.method === 'GET' && path === '/search') {
        const query = url.searchParams.get('q') ?? '';
        return sendHtml(res, searchPage(query, query ? await searchWiki(runtime.ctx, query) : []));
      }

      if (req.method === 'POST' && path === '/actions/ingest') {
        await ingestAndTriage(runtime.ctx);
        return redirect(res, '/');
      }

      if (req.method === 'POST' && path === '/actions/digest') {
        const form = await readForm(req);
        const draft = await draftDigest(runtime.ctx, rawPathOf(form.rawPath ?? ''));
        return redirect(res, `/review/${draft.draftId}`);
      }

      if (req.method === 'POST' && path.startsWith('/review/')) {
        const rest = path.slice('/review/'.length);
        const [id, action] = rest.split('/');
        if (!id || (action !== 'accept' && action !== 'reject')) {
          return sendHtml(res, errorPage(`未知操作：${path}`), 404);
        }
        const form = await readForm(req);
        const note = form.note && form.note.length > 0 ? form.note : undefined;
        await decideReview(runtime.ctx, draftIdOf(id), action, {
          actor: 'owner',
          ...(note ? { note } : {}),
        });
        await runtime.search.refresh();
        return redirect(res, '/');
      }

      // ---- JSON API ----
      if (req.method === 'GET' && path === '/api/health') {
        return sendJson(res, { ok: true, head: await runtime.vault.head() });
      }
      if (req.method === 'GET' && path === '/api/queue') {
        return sendJson(res, await listQueue(runtime.ctx));
      }
      if (req.method === 'GET' && path.startsWith('/api/reviews/')) {
        return sendJson(res, await reviewView(runtime.ctx, draftIdOf(path.slice('/api/reviews/'.length))));
      }
      if (req.method === 'GET' && path === '/api/overview') {
        const data = await overview(runtime.ctx);
        let workerPhase: string | null = null;
        try {
          workerPhase = String((JSON.parse(fs.readFileSync(join(runtime.dataDir, 'worker-status.json'), 'utf8')) as { phase?: string }).phase ?? 'unknown');
        } catch {
          workerPhase = null;
        }
        return sendJson(res, { ...data, workerPhase });
      }
      if (req.method === 'GET' && path === '/api/usage') {
        const day = url.searchParams.get('day') ?? undefined;
        return sendJson(res, await usageSummary(runtime.ctx, day ? { day } : {}));
      }
      if (req.method === 'GET' && path === '/api/search') {
        const query = url.searchParams.get('q') ?? '';
        return sendJson(res, await searchWiki(runtime.ctx, query));
      }

      return sendHtml(res, errorPage(`404 ${path}`), 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (path.startsWith('/api/')) return sendJson(res, { error: message }, 500);
      return sendHtml(res, errorPage(message), 500);
    }
  });
}
