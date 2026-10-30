/** 服务端渲染的审核台（无前端框架，手机可用）。 */
import type { QueueItemV1, ReviewViewV1, ScoredHit } from '@sb/contracts';

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LEVEL: Record<string, string> = { block: '阻断', warn: '注意', ok: '通过' };

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e8ee;--dim:#9aa3b2;
--red:#ef5f6b;--yellow:#e3b341;--green:#3fb950;--blue:#58a6ff;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:var(--dim);margin:26px 0 10px;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.stat{flex:1 1 120px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:24px}.stat span{color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px}
.mono{font-family:var(--mono);font-size:12px;color:var(--dim);word-break:break-all}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.b-block{color:var(--red);border-color:#5a2b31;background:#2a1618}
.b-warn{color:var(--yellow);border-color:#5a4a1e;background:#2a2414}
.b-ok{color:var(--green);border-color:#24512c;background:#152215}
.b-blue{color:var(--blue);border-color:#243b5a;background:#141c2a}
.btn{display:inline-block;padding:6px 14px;border-radius:8px;border:1px solid var(--line);
background:#1d222b;color:var(--fg);cursor:pointer;font-size:13.5px}
.btn.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.btn.danger{background:#3a1d22;border-color:#5a2b31;color:#ff9aa2}
.btn[disabled]{opacity:.45;cursor:not-allowed}
input[type=text]{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);
background:#0c0e12;color:var(--fg);font-size:14px}
li{margin:6px 0}.muted{color:var(--dim)}
pre{background:#0c0e12;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12.5px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · secondBrain</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function findingBadge(severity: string): string {
  const cls = severity === 'block' ? 'b-block' : severity === 'warn' ? 'b-warn' : 'b-ok';
  return `<span class="badge ${cls}">${LEVEL[severity] ?? esc(severity)}</span>`;
}

export interface DashboardData {
  readonly queue: readonly QueueItemV1[];
  readonly pending: readonly ReviewViewV1[];
  readonly counts: { readonly items: number; readonly queued: number; readonly committed: number; readonly deferred: number };
}

export function dashboard(data: DashboardData): string {
  const pendingRows = data.pending.map((view) => {
    const level = view.actions.accept ? (view.findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok') : 'block';
    return `<tr>
      <td>${findingBadge(level)}</td>
      <td><a href="/review/${esc(view.draftId)}">${esc(view.title)}</a>
        <div class="mono">${esc(view.rawPath)}</div></td>
      <td>${view.claims.length}</td><td>${esc(view.tier)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">没有待审草稿。先点「扫描并分档」，再对队列里的条目生成草稿。</td></tr>';

  const queueRows = data.queue.map((item) => `<tr>
      <td>${esc(item.title)}<div class="mono">${esc(item.rawPath)}</div></td>
      <td>${item.charCount.toLocaleString()} 字</td>
      <td><span class="badge b-blue">${esc(item.state)}</span></td>
      <td>${item.draftId
        ? `<a class="btn" href="/review/${esc(item.draftId)}">去审阅</a>`
        : `<form method="post" action="/actions/digest" style="margin:0">
             <input type="hidden" name="rawPath" value="${esc(item.rawPath)}">
             <button class="btn" type="submit">生成草稿</button></form>`}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">队列为空。</td></tr>';

  return layout('审核台', `
  <h1>secondBrain 审核台</h1>
  <div class="muted">mock 原文 · 真实状态机 · 每次入库一次 git commit</div>

  <div class="row" style="margin-top:16px">
    <div class="stat"><b>${data.counts.items}</b><span>原文</span></div>
    <div class="stat"><b>${data.counts.queued}</b><span>待加工</span></div>
    <div class="stat"><b>${data.pending.length}</b><span>待审</span></div>
    <div class="stat"><b>${data.counts.committed}</b><span>已入库</span></div>
    <div class="stat"><b>${data.counts.deferred}</b><span>已延后</span></div>
  </div>

  <h2>操作</h2>
  <div class="card row">
    <form method="post" action="/actions/ingest" style="margin:0">
      <button class="btn primary" type="submit">扫描 raw/ 并分档</button>
    </form>
    <span class="muted">超 60,000 字的原文自动延后，不读全文。</span>
  </div>

  <h2>搜索知识库</h2>
  <form class="card" method="get" action="/search">
    <input type="text" name="q" placeholder="例如：反脆弱、幂律、长期主义">
    <div class="row" style="margin-top:10px"><button class="btn" type="submit">搜索</button></div>
  </form>

  <h2>待审草稿（人只在这里动手）</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>预警</th><th>草稿</th><th>claims</th><th>档位</th></tr>${pendingRows}
  </table></div>

  <h2>队列</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>原文</th><th>字数</th><th>状态</th><th></th></tr>${queueRows}
  </table></div>`);
}

export function reviewPage(view: ReviewViewV1, hits: readonly ScoredHit[] = [], query = ''): string {
  const level = view.actions.accept ? (view.findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok') : 'block';
  const findings = view.findings.map((finding) => `<div class="card" style="margin:6px 0;border-color:${
    finding.severity === 'block' ? '#5a2b31' : finding.severity === 'warn' ? '#5a4a1e' : '#24512c'}">
      ${findingBadge(finding.severity)} ${esc(finding.message)}
      <div class="mono">${esc(finding.ruleId)}</div></div>`).join('')
    || '<div class="muted">无预警</div>';

  const claims = view.claims.map((claim) => `<li>${esc(claim.text)}
    ${claim.inference ? '<span class="badge b-warn">推断</span>' : ''}
    <div class="mono">来源：${esc(claim.source)}</div></li>`).join('');

  const nodes = view.nodes.map((node) => `<li>
    <span class="badge b-blue">${node.action === 'patch' ? '并入' : '新建'}</span>
    ${esc(node.name)} <span class="muted">(${esc(node.nodeType)})</span>
    ${node.definition ? `<div class="muted">${esc(node.definition)}</div>` : ''}</li>`).join('');

  const hitsHtml = hits.map((hit) => `<li><span class="badge">${hit.score}</span>
    <b>${esc(hit.name)}</b> <span class="mono">${esc(hit.file)} · ${esc(hit.matchType)}</span></li>`).join('')
    || (query ? '<li class="muted">没有命中</li>' : '');

  return layout(view.title, `
  <div class="row" style="justify-content:space-between">
    <div><h1>${esc(view.title)}</h1><div class="mono">${esc(view.rawPath)}</div></div>
    <a class="btn" href="/">← 返回</a>
  </div>

  <div class="row" style="margin-top:12px">
    <div class="stat"><b>${view.charCount.toLocaleString()}</b><span>原文字数</span></div>
    <div class="stat"><b>${esc(view.tier)}</b><span>判档</span></div>
    <div class="stat"><b>${view.claims.length}</b><span>claims</span></div>
    <div class="stat"><b>${findingBadge(level)}</b><span>预警</span></div>
  </div>

  <h2>① 预警</h2>${findings}

  <h2>② 搜索现有知识库</h2>
  <form class="card" method="get" action="/search">
    <input type="hidden" name="draft" value="${esc(view.draftId)}">
    <input type="text" name="q" value="${esc(query)}" placeholder="换几个关键词复核">
    <div class="row" style="margin-top:10px"><button class="btn" type="submit">搜索</button></div>
    <ul style="margin:10px 0 0">${hitsHtml}</ul>
  </form>

  <h2>③ 草稿</h2>
  <div class="card"><ul>${claims}</ul>
    <h2 style="margin-top:16px">目标节点</h2><ul>${nodes}</ul></div>

  <h2>④ 决策</h2>
  <div class="card row">
    <form method="post" action="/review/${esc(view.draftId)}/accept" style="margin:0">
      <button class="btn primary" type="submit" ${view.actions.accept ? '' : 'disabled'}>通过并入库</button>
    </form>
    <form method="post" action="/review/${esc(view.draftId)}/reject" class="row" style="margin:0">
      <input type="text" name="note" placeholder="驳回理由" style="max-width:300px">
      <button class="btn danger" type="submit">驳回</button>
    </form>
    ${view.actions.accept ? '' : `<div class="muted">被规则阻断：${view.actions.blockedBy.map(esc).join(', ')}</div>`}
  </div>
  <div class="muted" style="margin-top:10px">
    来源：${esc(view.provenance.provider)} / ${esc(view.provenance.model)} · prompt v${view.provenance.promptVersion}
  </div>`);
}

export function searchPage(query: string, hits: readonly ScoredHit[]): string {
  const rows = hits.map((hit) => `<tr><td><span class="badge">${hit.score}</span></td>
    <td><b>${esc(hit.name)}</b><div class="mono">${esc(hit.file)} · ${esc(hit.matchType)}</div></td></tr>`).join('')
    || '<tr><td colspan="2" class="muted">没有命中</td></tr>';

  return layout('搜索', `
  <div class="row" style="justify-content:space-between"><h1>搜索知识库</h1><a class="btn" href="/">← 返回</a></div>
  <form class="card" method="get" action="/search" style="margin-top:12px">
    <input type="text" name="q" value="${esc(query)}" placeholder="概念 / 人物 / 关键词">
    <div class="row" style="margin-top:10px"><button class="btn" type="submit">搜索</button></div>
  </form>
  <div class="card" style="margin-top:16px;padding:4px 0"><table>
    <tr><th style="width:70px">分数</th><th>节点</th></tr>${rows}
  </table></div>`);
}

export function errorPage(message: string): string {
  return layout('出错了', `<h1>出错了</h1><pre>${esc(message)}</pre><a class="btn" href="/">← 返回</a>`);
}
