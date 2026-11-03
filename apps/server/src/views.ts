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
<body><div id="refresh-bar" class="refresh-bar"></div><div class="wrap">${body}</div>
<script>
(function(){
  var version=null;
  function show(text){var bar=document.getElementById('refresh-bar');if(!bar)return;bar.textContent=text;bar.style.display='block';bar.onclick=function(){location.reload();};}
  function render(d){
    var light=document.getElementById('worker-light');
    if(light&&d.workerPhase){var m={drafting:'起草中',ingesting:'扫描中',sleeping:'等待中',paused:'已暂停',starting:'启动中',stopping:'停止中'};light.textContent='worker: '+(m[d.workerPhase]||d.workerPhase);}
    var badge=document.getElementById('pending-badge');
    if(badge&&typeof d.pendingDrafts==='number'){badge.textContent='待审 '+d.pendingDrafts;}
  }
  function poll(){fetch('/api/overview',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    render(d);
    if(version===null){version=d.version;return;}
    if(d.version!==version&&document.activeElement&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){show('有更新（当前有输入，未自动刷新）· 点击刷新');return;}
    if(d.version!==version){version=d.version;show('有更新 · 点击刷新');}
  }).catch(function(){});}
  poll();setInterval(poll,5000);
})();
</script></body></html>`;
}

function findingBadge(severity: string): string {
  const cls = severity === 'block' ? 'b-block' : severity === 'warn' ? 'b-warn' : 'b-ok';
  return `<span class="badge ${cls}">${LEVEL[severity] ?? esc(severity)}</span>`;
}

const STATE_LABEL: Record<string, string> = {
  ingested: '已摄取', triaged: '已分档', quarantined: '已隔离', queued: '待处理', drafting: '起草中',
  draft_ready: '待审核', in_review: '审阅中', approved: '已批准', committing: '提交中', committed: '已入库',
  rejected: '已驳回', changes_requested: '需修改', deferred: '已延后', failed: '失败', blocked: '已阻塞',
  rolled_back: '已回滚', expired: '已过期', abandoned: '已放弃',
};
const TRIAGE_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const REASON_LABEL: Record<string, string> = {
  human_story: '人物故事', interesting: '有趣', novel_view: '新视角', useful: '实用',
  durable_claim: '持久判断', reinforces_existing: '强化已有', personal_relevance: '个人相关', low_signal: '低信号',
};
const DRAFT_LABEL: Record<string, string> = { pending: '待审核', approved: '已批准', rejected: '已驳回' };
const PHASE_LABEL: Record<string, string> = {
  starting: '启动中', ingesting: '扫描原文', drafting: '起草中', sleeping: '等待下一轮', paused: '已暂停', stopping: '停止中',
};

export function stateLabel(state: unknown): string {
  return typeof state === 'string' ? STATE_LABEL[state] ?? state : String(state);
}
function triageLabel(status: unknown): string {
  return typeof status === 'string' ? TRIAGE_LABEL[status] ?? status : String(status);
}
function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}
function draftLabel(status: unknown): string {
  return typeof status === 'string' ? DRAFT_LABEL[status] ?? status : String(status);
}
function phaseLabel(phase: unknown): string {
  return typeof phase === 'string' ? PHASE_LABEL[phase] ?? phase : String(phase);
}

export interface UsageTiles {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
}

export interface DashboardData {
  readonly mode?: 'mock' | 'cloud';
  readonly queue: readonly QueueItemV1[];
  readonly pending: readonly ReviewViewV1[];
  readonly counts: { readonly items: number; readonly queued: number; readonly committed: number; readonly deferred: number };
  readonly usage: UsageTiles;
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
  <div class="muted">${data.mode === 'cloud' ? '云模型模式' : 'mock 模型模式'} · 真实状态机 · 每次入库一次 git commit</div>

  <div class="row" style="margin-top:16px">
    <div class="stat"><b>${data.counts.items}</b><span>原文</span></div>
    <div class="stat"><b>${data.counts.queued}</b><span>待加工</span></div>
    <div class="stat"><b>${data.pending.length}</b><span>待审</span></div>
    <div class="stat"><b>${data.counts.committed}</b><span>已入库</span></div>
    <div class="stat"><b>${data.counts.deferred}</b><span>已延后</span></div>
  </div>

  <div class="row" style="margin-top:12px">
    <div class="stat"><b>${data.usage.calls}</b><span>今日模型调用</span></div>
    <div class="stat"><b>${data.usage.inputTokens.toLocaleString()}</b><span>今日输入 tokens</span></div>
    <div class="stat"><b>${data.usage.outputTokens.toLocaleString()}</b><span>今日输出 tokens</span></div>
    <div class="stat"><b>${data.usage.estimatedCost}</b><span>今日估算成本（价格未配置时为 0）</span></div>
    <div class="stat"><b><a href="/usage">用量明细 →</a></b><span>按天 / 按 profile</span></div>
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


export interface UsagePageData {
  readonly days: readonly { day: string; calls: number; cacheHits: number; inputTokens: number; outputTokens: number; estimatedCost: number }[];
  readonly byProfile: readonly { profileId: string; calls: number; inputTokens: number; outputTokens: number; estimatedCost: number }[];
  readonly totals: { calls: number; cacheHits: number; inputTokens: number; outputTokens: number; estimatedCost: number };
}

export function usagePage(data: UsagePageData): string {
  const dayRows = data.days.map((entry) => `<tr>
    <td>${esc(entry.day)}</td><td>${entry.calls}</td>
    <td>${entry.cacheHits}</td>
    <td>${entry.inputTokens.toLocaleString()}</td>
    <td>${entry.outputTokens.toLocaleString()}</td>
    <td>${entry.estimatedCost}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">还没有调用记录</td></tr>';

  const profileRows = data.byProfile.map((entry) => `<tr>
    <td>${esc(entry.profileId)}</td><td>${entry.calls}</td>
    <td>${entry.inputTokens.toLocaleString()}</td>
    <td>${entry.outputTokens.toLocaleString()}</td>
    <td>${entry.estimatedCost}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">还没有调用记录</td></tr>';

  return layout('用量', `
  <div class="row" style="justify-content:space-between"><h1>模型用量</h1><a class="btn" href="/">← 返回</a></div>
  <div class="muted">只计量、不拦截（ADR 0005 修订）。价格未配置时成本显示 0，tokens 仍然准确。</div>

  <div class="row" style="margin-top:16px">
    <div class="stat"><b>${data.totals.calls}</b><span>总调用</span></div>
    <div class="stat"><b>${data.totals.cacheHits}</b><span>缓存命中</span></div>
    <div class="stat"><b>${data.totals.inputTokens.toLocaleString()}</b><span>输入 tokens</span></div>
    <div class="stat"><b>${data.totals.outputTokens.toLocaleString()}</b><span>输出 tokens</span></div>
    <div class="stat"><b>${data.totals.estimatedCost}</b><span>估算成本</span></div>
  </div>

  <h2>按天</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>日期</th><th>调用</th><th>缓存命中</th><th>输入</th><th>输出</th><th>估算成本</th></tr>${dayRows}
  </table></div>

  <h2>按 profile</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>profile</th><th>调用</th><th>输入</th><th>输出</th><th>估算成本</th></tr>${profileRows}
  </table></div>`);
}

// ---------------------------------------------------------------------------
// 文章库 / 管理后台（2026-11-03）
// ---------------------------------------------------------------------------

function nav(): string {
  return `<div class="nav">
    <a href="/"><b>secondBrain</b></a>
    <a href="/">工作台</a><a href="/articles">文章库</a><a href="/review">审核</a>
    <a href="/claims">claims</a><a href="/operations">运维</a><a href="/exceptions">异常</a><a href="/usage">用量</a><a href="/search">搜索</a>
    <span style="flex:1"></span>
    <span id="worker-light" class="muted">worker: --</span>
    <span id="pending-badge" class="badge b-warn">待审 0</span>
  </div>`;
}

export interface ArticlesPageData {
  readonly items: readonly { rawPath: string; title: string; sourceKey: string; state: string; charCount: number; updatedAt: string; triage: { status: string; score: number; judgments: number } | null }[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly states: readonly string[];
  readonly state: string;
  readonly query: string;
  readonly group: string;
  readonly source: string;
  readonly days: number;
  readonly triage: string;
  readonly sort: string;
  readonly groupCounts: Readonly<Record<string, number>>;
  readonly sources: readonly string[];
}

export function articlesPage(data: ArticlesPageData): string {
  const GROUP_TABS: ReadonlyArray<[string, string]> = [
    ['all', '全部'], ['queue', '待处理'], ['review', '待审核'],
    ['committed', '已入库'], ['deferred', '已延后'], ['error', '异常'],
  ];
  const qs = (extra: Record<string, string | number>): string => {
    const params = new URLSearchParams({
      group: data.group, source: data.source, days: String(data.days),
      triage: data.triage, sort: data.sort, q: data.query, page: '1', ...extra,
    });
    for (const [key, value] of [...params.entries()]) {
      if (value === 'all' || value === '' || value === '0') params.delete(key);
    }
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  };

  const tabs = GROUP_TABS.map(([key, label]) =>
    `<a class="btn" style="${key === data.group ? 'background:#1f6feb;color:#fff' : ''}" href="/articles${qs({ group: key })}">${label} <span class="muted">${data.groupCounts[key] ?? 0}</span></a>`,
  ).join('');

  const sourceOptions = ['all', ...data.sources]
    .map((value) => `<option value="${esc(value)}"${value === data.source ? ' selected' : ''}>${value === 'all' ? '全部来源' : esc(value)}</option>`).join('');
  const dayOptions = [[0, '全部时间'], [1, '今天'], [7, '近 7 天'], [30, '近 30 天']]
    .map(([value, label]) => `<option value="${value}"${Number(value) === data.days ? ' selected' : ''}>${label}</option>`).join('');
  const triageOptions = [['all', '全部等级'], ['high', '高'], ['medium', '中'], ['low', '低']]
    .map(([value, label]) => `<option value="${value}"${value === data.triage ? ' selected' : ''}>${label}</option>`).join('');
  const sortOptions = [['updated', '最近更新'], ['judgments', '判断句数'], ['chars', '字数'], ['title', '标题']]
    .map(([value, label]) => `<option value="${value}"${value === data.sort ? ' selected' : ''}>按${label}</option>`).join('');

  const rows = data.items.map((item) => `<tr>
    <td><a href="/articles/${encodeURIComponent(item.rawPath)}">${esc(item.title)}</a></td>
    <td>${esc(item.sourceKey)}</td>
    <td><span class="badge">${esc(stateLabel(item.state))}</span></td>
    <td>${item.triage ? `${esc(triageLabel(item.triage.status))} · ${item.triage.judgments} 句` : '—'}</td>
    <td>${item.charCount.toLocaleString()}</td>
    <td class="muted">${esc(item.updatedAt.slice(0, 10))}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">没有匹配的文章</td></tr>';

  const prev = data.page > 1 ? `<a class="btn" href="/articles${qs({ page: data.page - 1 })}">← 上一页</a>` : '';
  const next = data.page < data.pages ? `<a class="btn" href="/articles${qs({ page: data.page + 1 })}">下一页 →</a>` : '';

  return layout('文章库', `${nav()}
  <div class="row" style="justify-content:space-between"><h1>文章库</h1><span class="muted">${data.total.toLocaleString()} 篇 · 第 ${data.page}/${data.pages} 页</span></div>
  <div class="row" style="gap:6px;margin:12px 0;flex-wrap:wrap">${tabs}</div>
  <form class="row" method="get" action="/articles" style="gap:8px;margin-bottom:12px;flex-wrap:wrap">
    <input type="hidden" name="group" value="${esc(data.group)}">
    <select name="source">${sourceOptions}</select>
    <select name="days">${dayOptions}</select>
    <select name="triage">${triageOptions}</select>
    <select name="sort">${sortOptions}</select>
    <input name="q" value="${esc(data.query)}" placeholder="搜索标题或路径">
    <button class="btn" type="submit">筛选</button>
    <a class="btn" href="/articles">重置</a>
  </form>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>标题</th><th>来源</th><th>状态</th><th>triage</th><th>字数</th><th>更新</th></tr>${rows}
  </table></div>
  <div class="row" style="justify-content:space-between;margin-top:12px">${prev}<span></span>${next}</div>`);
}

export interface ArticlePageData {
  readonly rawPath: string;
  readonly title: string;
  readonly sourceKey: string;
  readonly state: string;
  readonly charCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly triage: { status: string; score: number; judgments: number; reasons: readonly string[] } | null;
  readonly commitSha: string | null;
  readonly timeline: readonly { at: string; type: string }[];
  readonly draft: {
    id: string; status: string; tier: string; rationale: string; provider: string; model: string; promptVersion: number;
    claims: readonly { text: string; inference: boolean; source: string }[];
    nodes: readonly { name: string; nodeType: string; action: string; claimIndexes: readonly number[] }[];
    findings: readonly { code: string; severity: string; message: string }[];
  } | null;
}

export function articlePage(data: ArticlePageData): string {
  const claims = data.draft?.claims.map((claim) => `<li>${esc(claim.text)}${claim.inference ? ' <span class="badge b-warn">推断</span>' : ''}</li>`).join('') ?? '';
  const nodes = data.draft?.nodes.map((node) => `<tr><td>${esc(node.name)}</td><td>${esc(node.nodeType)}</td><td>${esc(node.action)}</td><td class="muted">[${node.claimIndexes.join(', ')}]</td></tr>`).join('') ?? '';
  const findings = data.draft?.findings.map((finding) => `<li>${findingBadge(finding.severity)} ${esc(finding.code)}：${esc(finding.message)}</li>`).join('') ?? '';
  const draftLink = data.draft && data.draft.status === 'pending'
    ? `<a class="btn" href="/review/${encodeURIComponent(data.draft.id)}">去审阅 →</a>` : '';

  return layout('文章详情', `${nav()}
  <div class="row" style="justify-content:space-between"><h1>${esc(data.title)}</h1><a class="btn" href="/articles">← 文章库</a></div>
  <div class="muted">${esc(data.rawPath)}</div>
  <div class="row" style="margin-top:12px">
    <div class="stat"><b>${esc(stateLabel(data.state))}</b><span>状态</span></div>
    <div class="stat"><b>${esc(data.sourceKey)}</b><span>来源</span></div>
    <div class="stat"><b>${data.charCount.toLocaleString()}</b><span>字符</span></div>
    <div class="stat"><b>${esc(data.updatedAt.slice(0, 10))}</b><span>更新时间</span></div>
    ${data.commitSha ? `<div class="stat"><b>${esc(data.commitSha.slice(0, 7))}</b><span>commit</span></div>` : ''}
  </div>

  <h2>triage</h2>
  <div class="card">${data.triage
    ? `<div>${esc(triageLabel(data.triage.status))} · 分数 ${data.triage.score} · ${data.triage.judgments} 条判断句</div>
       <div class="muted">${data.triage.reasons.map((reason) => esc(reasonLabel(reason))).join('、') || '无理由'}</div>`
    : '<span class="muted">无 triage 结果</span>'}</div>

  <h2>时间线</h2>
  <div class="card">${data.timeline.length === 0 ? '<span class="muted">暂无事件</span>' : `<table>${data.timeline.map((event) => `<tr><td class="muted">${esc(event.at.slice(0, 19))}</td><td>${esc(event.type)}</td></tr>`).join('')}</table>`}</div>

  ${data.draft ? `
  <h2>草稿 ${draftLink}</h2>
  <div class="card">
    <div>${esc(data.draft.tier)} · ${esc(draftLabel(data.draft.status))} · ${esc(data.draft.provider)}/${esc(data.draft.model)} · prompt v${data.draft.promptVersion}</div>
    <div class="muted">${esc(data.draft.rationale)}</div>
    ${findings ? `<ul>${findings}</ul>` : ''}
  </div>
  <h2>claims（${data.draft.claims.length}）</h2>
  <div class="card"><ol>${claims}</ol></div>
  <h2>节点</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>节点</th><th>类型</th><th>动作</th><th>支撑 claims</th></tr>${nodes || '<tr><td colspan="4" class="muted">无</td></tr>'}
  </table></div>` : '<h2>草稿</h2><div class="card muted">还没有草稿</div>'}
  `);
}

export interface WorkerStatusView {
  readonly phase: string;
  readonly updatedAt: string;
  readonly rawPath?: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly lastTickAt?: string;
  readonly lastTick?: { readonly ingested: number; readonly drafted: number; readonly failed: number; readonly queueLength: number };
  readonly stale: boolean;
}

export interface AdminPageData {
  readonly paused: boolean;
  readonly ops: readonly { action: string; at: string; ok: boolean; detail: string }[];
  readonly logs: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  readonly drafts: Readonly<Record<string, number>>;
  readonly queueRemaining: number;
  readonly today: {
    readonly day: string;
    readonly drafted: number;
    readonly committed: number;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost: number;
    readonly ratePerHour: number | null;
    readonly etaHours: number | null;
  };
  readonly usage: { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number };
  readonly env: { mode: string; dataDir: string; vaultRoot: string };
  readonly recentEvents: readonly { at: string; type: string; aggregateId: string }[];
  readonly worker: WorkerStatusView | null;
}

function fmtEta(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '待估算';
  if (hours < 1) return `约 ${Math.round(hours * 60)} 分钟`;
  return `约 ${hours.toFixed(1)} 小时`;
}

export function adminPage(data: AdminPageData): string {
  const stateRows = Object.entries(data.counts).sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `<tr><td>${esc(stateLabel(state))}</td><td>${count.toLocaleString()}</td></tr>`).join('');
  const events = data.recentEvents.map((event) => `<tr><td class="muted">${esc(event.at.slice(0, 19))}</td><td>${esc(event.type)}</td><td class="muted">${esc(event.aggregateId)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">暂无事件</td></tr>';

  const worker = data.worker;
  const elapsed = worker?.phase === 'drafting' && worker.startedAt
    ? Math.max(0, Math.round((Date.parse(worker.updatedAt) - Date.parse(worker.startedAt)) / 1000))
    : null;
  const workerBlock = worker
    ? `<div class="row">
         <div class="stat"><b>${esc(phaseLabel(worker.phase))}</b><span>worker 状态</span></div>
         <div class="stat"><b>${esc(worker.updatedAt.slice(11, 19))}</b><span>状态更新</span></div>
         ${worker.lastTick ? `<div class="stat"><b>${worker.lastTick.drafted} / ${worker.lastTick.failed}</b><span>上轮 起草 / 失败</span></div>` : ''}
         ${worker.lastTick ? `<div class="stat"><b>${worker.lastTick.queueLength.toLocaleString()}</b><span>上轮队列</span></div>` : ''}
       </div>
       ${worker.phase === 'drafting' && worker.title
         ? `<div class="card" style="margin-top:10px"><div><b>正在起草：</b>${esc(worker.title)}${elapsed !== null ? `（已 ${elapsed} 秒）` : ''}</div>
            <div class="muted">${esc(worker.rawPath ?? '')}</div></div>`
         : '<div class="card muted" style="margin-top:10px">当前没有正在起草的文章</div>'}
       ${worker.stale ? '<div class="card" style="margin-top:10px;border-color:#a33">⚠️ worker 状态超过 10 分钟未更新，可能未运行</div>' : ''}`
    : '<div class="card muted">没有 worker 状态（worker 可能未启动）</div>';

  return layout('运维中心', `${nav()}
  <div class="row" style="justify-content:space-between"><h1>运维中心</h1><span class="muted">${esc(data.env.mode)} 模式</span></div>

  <h2>运行状态</h2>
  ${data.paused
    ? `<div class="card" style="border-color:#e3b341;margin-bottom:10px"><b>已暂停</b>：当前任务处理完后不再开始新任务。
         <form method="post" action="/actions/worker/resume" style="display:inline;margin-left:8px"><button class="btn" type="submit">继续处理</button></form></div>`
    : `<div class="card" style="margin-bottom:10px">自动处理中。
         <form method="post" action="/actions/worker/pause" style="display:inline;margin-left:8px"><button class="btn" type="submit">暂停（完成当前任务后）</button></form></div>`}
  ${workerBlock}

  <h2>今日进度（${esc(data.today.day)}）</h2>
  <div class="row">
    <div class="stat"><b>${data.today.drafted.toLocaleString()}</b><span>今日起草</span></div>
    <div class="stat"><b>${data.today.committed.toLocaleString()}</b><span>今日入库</span></div>
    <div class="stat"><b>${data.today.calls.toLocaleString()}</b><span>今日调用</span></div>
    <div class="stat"><b>${data.today.inputTokens.toLocaleString()}</b><span>输入 tokens</span></div>
    <div class="stat"><b>${data.today.outputTokens.toLocaleString()}</b><span>输出 tokens</span></div>
    <div class="stat"><b>${data.today.estimatedCost}</b><span>估算成本（美元）</span></div>
    <div class="stat"><b>${data.today.ratePerHour ? data.today.ratePerHour.toFixed(1) : '—'}</b><span>速率（篇/小时）</span></div>
    <div class="stat"><b>${fmtEta(data.today.etaHours)}</b><span>预计跑完剩余队列</span></div>
  </div>

  <h2>队列与状态</h2>
  <div class="row">
    <div class="stat"><b>${data.total.toLocaleString()}</b><span>文章总数</span></div>
    <div class="stat"><b>${data.queueRemaining.toLocaleString()}</b><span>待处理</span></div>
    <div class="stat"><b>${(data.counts.draft_ready ?? 0).toLocaleString()}</b><span>待审核</span></div>
    <div class="stat"><b>${(data.counts.committed ?? 0).toLocaleString()}</b><span>已入库</span></div>
    <div class="stat"><b>${(data.drafts.pending ?? 0).toLocaleString()}</b><span>pending 草稿</span></div>
    <div class="stat"><b>${(data.drafts.rejected ?? 0).toLocaleString()}</b><span>已驳回草稿</span></div>
  </div>
  <div class="card" style="padding:4px 0;margin-top:10px"><table><tr><th>状态</th><th>数量</th></tr>${stateRows}</table></div>

  <h2>运维操作</h2>
  <div class="card"><div class="row" style="gap:8px;flex-wrap:wrap">
    <form method="post" action="/actions/ops/scan"><button class="btn" type="submit">立即扫描新原文</button></form>
    <form method="post" action="/actions/ops/sync"><button class="btn" type="submit">立即同步 git</button></form>
    <form method="post" action="/actions/ops/backup"><button class="btn" type="submit">立即备份状态库</button></form>
  </div>
  <table style="margin-top:10px"><tr><th>时间</th><th>动作</th><th>结果</th><th>详情</th></tr>
  ${data.ops.length === 0 ? '<tr><td colspan="4" class="muted">还没有执行记录</td></tr>' : data.ops.map((op) => `<tr><td class="muted">${esc(op.at.slice(0, 19))}</td><td>${esc(op.action)}</td><td>${op.ok ? '✅ 成功' : '❌ 失败'}</td><td class="muted">${esc(op.detail)}</td></tr>`).join('')}
  </table></div>

  <h2>worker 日志（最近 12 行）</h2>
  <div class="card"><pre>${data.logs.length === 0 ? '（无法读取日志，可能权限不足）' : data.logs.map((line) => esc(line)).join('\n')}</pre></div>

  <h2>快捷操作</h2>
  <div class="card"><div class="row">
    <form method="post" action="/actions/ingest"><button class="btn" type="submit">扫描 raw/ 并分档</button></form>
    <a class="btn" href="/articles?state=queued">看待处理</a>
    <a class="btn" href="/articles?state=draft_ready">看待审核</a>
    <a class="btn" href="/usage">用量明细</a>
    <a class="btn" href="/api/health">健康检查</a>
  </div></div>

  <h2>环境</h2>
  <div class="card"><pre>模式: ${esc(data.env.mode)}
数据目录: ${esc(data.env.dataDir)}
vault: ${esc(data.env.vaultRoot)}
今日累计调用: ${data.usage.calls.toLocaleString()}（总成本 $${data.usage.estimatedCost}）</pre></div>

  <h2>最近事件</h2>
  <div class="card" style="padding:4px 0"><table><tr><th>时间</th><th>事件</th><th>对象</th></tr>${events}</table></div>`);
}


export interface ReviewListPageData {
  readonly items: readonly { draftId: string; title: string; rawPath: string; tier: string; rationale: string; hasBlock: boolean; createdAt: string }[];
  readonly accepted: number;
  readonly failed: number;
}

export function reviewListPage(data: ReviewListPageData): string {
  const rows = data.items.map((item) => `<tr class="review-row">
    <td><input type="checkbox" name="draftId" value="${esc(item.draftId)}"></td>
    <td><a href="/review/${encodeURIComponent(item.draftId)}" class="review-link">${esc(item.title)}</a></td>
    <td>${esc(item.tier)}</td>
    <td>${item.hasBlock ? '<span class="badge b-block">阻断</span>' : '<span class="badge b-ok">可审</span>'}</td>
    <td class="muted">${esc(item.createdAt.slice(5, 16))}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">没有待审草稿</td></tr>';

  const flash = data.accepted > 0 || data.failed > 0
    ? `<div class="card" style="border-color:#3fb950">批量结果：成功 ${data.accepted} 篇${data.failed > 0 ? `，失败 ${data.failed} 篇（失败项仍在待审，见日志）` : ''}</div>` : '';

  return layout('审核中心', `${nav()}
  <div class="row" style="justify-content:space-between"><h1>审核中心</h1><span class="muted">${data.items.length} 篇待审</span></div>
  ${flash}
  <form method="post" action="/actions/review/bulk-accept" id="bulk-form">
    <div class="row" style="gap:8px;margin:12px 0">
      <button class="btn" type="button" onclick="document.querySelectorAll('input[name=draftId]').forEach(function(c){c.checked=true;})">全选本页</button>
      <button class="btn" type="button" onclick="document.querySelectorAll('input[name=draftId]').forEach(function(c){c.checked=false;})">取消全选</button>
      <button class="btn" type="submit" onclick="return confirm('将逐篇通过选中的草稿并写入 wiki，确定？')">批量通过</button>
      <span class="muted">键盘：j/k 移动，Enter 打开，a 勾选，r 取消</span>
    </div>
    <div class="card" style="padding:4px 0"><table>
      <tr><th></th><th>标题</th><th>tier</th><th>检查</th><th>创建</th></tr>${rows}
    </table></div>
  </form>
  <script>
  (function(){
    var rows=Array.prototype.slice.call(document.querySelectorAll('.review-row'));var i=-1;
    function focus(n){if(rows.length===0)return;if(n<0)n=0;if(n>=rows.length)n=rows.length-1;i=n;var link=rows[i].querySelector('.review-link');if(link)link.focus();}
    document.addEventListener('keydown',function(e){
      if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
      if(e.key==='j'){focus(i+1);e.preventDefault();}
      else if(e.key==='k'){focus(i-1);e.preventDefault();}
      else if(e.key==='a'||e.key==='r'){if(i>=0){var c=rows[i].querySelector('input');if(c){c.checked=e.key==='a';}e.preventDefault();}}
    });
  })();
  </script>`);
}


export function claimsPage(rows: readonly { draftId: string; text: string; inference: boolean; source: string }[]): string {
  const items = rows.map((row) => `<li>${esc(row.text)}${row.inference ? ' <span class="badge b-warn">推断</span>' : ''}
    <div class="muted">来源：${esc(row.source)} · 草稿 ${esc(row.draftId)}</div></li>`).join('')
    || '<li class="muted">还没有已入库的 claims</li>';
  return layout('claims', `${nav()}
  <h1>已入库 claims（${rows.length}）</h1>
  <div class="muted">来自已通过审核并入库的草稿。每个 claim 都带来源原文与所属草稿。</div>
  <div class="card"><ol>${items}</ol></div>`);
}

export function guidePage(): string {
  return layout('使用说明', `${nav()}
  <h1>产出如何使用</h1>
  <div class="card">
  <h2>1. 阅读（Obsidian / 文件）</h2>
  <p>所有知识都是 <code>vault/wiki/</code> 下的 Markdown 文件，直接用 Obsidian 打开即可；本地通过 <code>git pull</code> 获取服务器最新提交。</p>
  <h2>2. 检索</h2>
  <p>站内「搜索」走 wiki 索引；本地可用 Obsidian 搜索或 <code>grep</code>。每个节点内的「来源：[[raw/…]]」可追溯到原文。</p>
  <h2>3. 审核产出的来源</h2>
  <p>文章库（<a href="/articles">/articles</a>）按状态查看全部原文；文章详情可见 triage、草稿 claims 与节点；「claims」页可看已入库判断。</p>
  <h2>4. 接入其他工具</h2>
  <p>服务端 JSON API：<code>/api/health</code>、<code>/api/queue</code>、<code>/api/usage</code>、<code>/api/overview</code>、<code>/api/search?q=</code>。上游可直接读 <code>vault/wiki/</code> 文件或 git 历史。</p>
  <h2>5. 版本与回滚</h2>
  <p>每次 accept 一次 git commit；用 <code>git log</code> / <code>git revert</code> 回滚，服务器与本地通过私有仓库同步。</p>
  </div>`);
}
