/** HTTP 层：服务端渲染审核台 + JSON API（无依赖，node:http）。 */
import http from 'node:http';
import { URL } from 'node:url';
import {
  decideReview,
  draftDigest,
  ingestAndTriage,
  listPendingDrafts,
  listQueue,
  reviewView,
  searchWiki,
} from '@sb/app';
import { parseDraftId, parseRawPath, type DraftId, type RawPath } from '@sb/domain';
import type { Runtime } from './runtime';
import { dashboard, errorPage, reviewPage, searchPage } from './views';

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
        const [queue, pending, stats] = await Promise.all([
          listQueue(runtime.ctx),
          listPendingDrafts(runtime.ctx),
          counts(runtime),
        ]);
        return sendHtml(res, dashboard({ queue, pending, counts: stats }));
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
