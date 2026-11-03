/** HTTP 层：服务端渲染审核台 + JSON API（无依赖，node:http）。 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import { join } from 'node:path';
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
} from '@sb/app';
import { parseDraftId, parseRawPath, type DraftId, type RawPath } from '@sb/domain';
import type { Runtime } from './runtime';
import { adminPage, articlePage, articlesPage, dashboard, errorPage, reviewPage, searchPage, usagePage } from './views';

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

      if (req.method === 'GET' && path === '/articles') {
        const data = await listArticles(runtime.ctx, {
          state: url.searchParams.get('state') ?? 'all',
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

      if (req.method === 'GET' && path === '/admin') {
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

        return sendHtml(res, adminPage({
          counts: summary.counts,
          total: summary.total,
          drafts: summary.drafts,
          queueRemaining: summary.queueRemaining,
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
