/** 服务端渲染的审核台（无前端框架，手机可用）。 */
import type { DeAiStyle, QueueItemV1, ReviewViewV1, ScoredHit } from '@sb/contracts';
import { AI_FLAVOR_RULES, type AiFlavorReport } from '@sb/domain';
import {
  formatClock,
  formatDate,
  formatDateTime,
  KNOWLEDGE_HEALTH_ISSUE_LIMIT,
  type CitationAuditReport,
  type KnowledgeHealthReport,
  type QaChainV1,
  type QualityStatus,
  type TopicMapV1,
  type TopicRowV1,
  type WritingContractReport,
} from '@sb/app';
import { webRepoUrl, type RepoStatus } from './repos';

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LEVEL: Record<string, string> = { block: '阻断', warn: '注意', ok: '通过' };

/** 日志行里的 ISO 时间（worker JSON 日志的 at 字段）在展示时转成本地时间，保留其余内容。 */
function formatLogLine(line: string): string {
  return esc(line).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gu,
    (match) => esc(formatDateTime(match, { seconds: true })),
  );
}

const CSS = `
:root{
  --bg:#dde6ee;--paper:#edf2f6;--panel:#f7fafc;--ink:#0c1a26;--dim:#536878;--line:#b4c4d2;--line-soft:#d2dde6;
  --accent:#e25822;--accent-deep:#b84316;--blue:#1e4e7a;--ok:#1c6b4d;--warn:#8a5b13;--bad:#b0352c;
  --mono:"JetBrains Mono","SFMono-Regular",Menlo,"Cascadia Code",monospace;
  --display:"Bahnschrift","DIN Alternate","Avenir Next Condensed","PingFang SC","Noto Sans SC",sans-serif;
  --sans:"PingFang SC","Hiragino Sans GB","Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html{background-color:var(--bg);min-height:100%;background-image:
    linear-gradient(rgba(30,78,122,.055) 1px,transparent 1px),
    linear-gradient(90deg,rgba(30,78,122,.055) 1px,transparent 1px),
    linear-gradient(rgba(30,78,122,.032) 1px,transparent 1px),
    linear-gradient(90deg,rgba(30,78,122,.032) 1px,transparent 1px);
  background-size:28px 28px,28px 28px,140px 140px,140px 140px}
body{background:transparent;color:var(--ink);font:14.5px/1.68 var(--sans);margin:0;min-height:100vh;-webkit-font-smoothing:antialiased}
.wrap{margin:0 auto;max-width:1240px;padding:18px 28px 80px}
a{color:var(--blue);text-decoration:none;border-bottom:1px solid rgba(30,78,122,.28)}
a:hover{color:var(--accent);border-bottom-color:var(--accent)}
p{margin:8px 0}
::selection{background:rgba(226,88,34,.22);color:var(--ink)}

/* 顶栏：技术头，不是营销导航 */
.nav{display:flex;align-items:center;gap:16px;padding:10px 0;border-bottom:1px solid var(--ink);margin-bottom:22px;position:sticky;top:0;background:var(--paper);z-index:40}
.nav-brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);font:600 19px/1 var(--display);letter-spacing:.045em;border:0;padding:0;white-space:nowrap}
.nav-brand:hover{color:var(--ink)}
.seal{position:relative;display:inline-grid;place-items:center;width:28px;height:28px;border:1px solid var(--ink);background:var(--panel);color:var(--ink);font:600 10px/1 var(--mono);letter-spacing:.06em}
.seal::before{content:'';position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;background:var(--accent)}
.seal::after{content:'';position:absolute;left:4px;top:4px;width:6px;height:6px;border-left:1px solid var(--line);border-top:1px solid var(--line)}
.nav-groups{display:flex;align-items:center;gap:0;flex-wrap:wrap}
.nav-item{display:inline-flex;align-items:center;gap:4px;color:var(--dim);padding:6px 11px;border:0;border-left:1px solid var(--line-soft);background:none;font:500 13.5px/1.2 var(--sans);cursor:pointer;white-space:nowrap}
.nav-groups>.nav-group:first-child,.nav-groups>a:first-child{border-left:0}
.nav-item:hover{color:var(--ink);background:rgba(30,78,122,.05)}
.nav-item.active{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
.nav-group{position:relative}
.nav-group>summary{list-style:none}
.nav-group>summary::-webkit-details-marker{display:none}
.nav-group>summary::after{content:'+';font:10px var(--mono);color:var(--dim);margin-left:2px}
.nav-group[open]>summary{color:var(--ink);background:rgba(30,78,122,.05)}
.nav-group[open]>summary::after{content:'−'}
.nav-menu{position:absolute;top:calc(100% + 10px);left:0;min-width:184px;display:flex;flex-direction:column;gap:0;padding:4px;background:var(--panel);border:1px solid var(--ink);box-shadow:6px 6px 0 rgba(12,26,38,.12);z-index:50}
.nav-menu a{color:var(--dim);padding:7px 9px;font-size:13px;border:0;border-bottom:1px solid var(--line-soft);white-space:nowrap}
.nav-menu a:last-child{border-bottom:0}
.nav-menu a:hover{color:var(--ink);background:rgba(30,78,122,.06)}
.nav-menu a.active{color:var(--accent)}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:8px}
#worker-light{color:var(--dim);font:11px var(--mono);padding:0 4px;white-space:nowrap}
#pending-badge{background:var(--panel);border:1px solid var(--line);color:var(--ink);font:10.5px var(--mono);padding:2px 6px;margin:0 4px}
.refresh-bar{display:none;position:sticky;top:0;background:#fff3e3;color:var(--warn);border-bottom:1px solid var(--accent);padding:6px 16px;cursor:pointer;z-index:60;text-align:center;font:11.5px var(--mono)}

/* 标题：工程标注感 */
h1{font:600 30px/1.24 var(--display);letter-spacing:.01em;margin:0 0 8px;color:var(--ink)}
h1::before{content:'';display:inline-block;width:8px;height:8px;background:var(--accent);margin-right:10px;vertical-align:2px}
h2{position:relative;font:600 14.5px/1.4 var(--display);color:var(--ink);margin:32px 0 10px;padding:0 0 7px;border-bottom:1px solid var(--line);letter-spacing:.02em}
h2::before{content:'';position:absolute;left:0;bottom:-1px;width:26px;height:2px;background:var(--accent)}
h3{font:600 14px/1.4 var(--sans);margin:16px 0 6px}
.muted{color:var(--dim);font-size:12.5px}
.empty{padding:7px 0 9px;color:var(--dim);font-size:12.5px;border-bottom:1px dashed var(--line)}
.mono{font:12px/1.6 var(--mono);color:var(--dim)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;margin:0}
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--ink);padding-bottom:10px;margin-bottom:14px;position:relative}
.page-head::after{content:'';position:absolute;right:0;bottom:-1px;width:64px;height:2px;background:var(--accent)}
.page-head h1{margin:0}
.page-sub{color:var(--dim);font-size:12.5px;margin-top:4px;max-width:76ch}
.page-sub .mono{font-size:11.5px}

/* 统计读数条：仪器面板而不是卡片 */
.row:has(.stat){gap:0;border-top:1px solid var(--ink);border-bottom:1px solid var(--line);background:rgba(247,250,252,.72);margin:12px 0 18px;overflow:hidden}
.stat{flex:1 1 128px;padding:13px 16px 11px;border-right:1px solid var(--line);background:transparent;position:relative}
.row:has(.stat) .stat:last-child{border-right:0}
.stat::before{content:'';position:absolute;left:0;top:0;width:18px;height:2px;background:var(--accent);opacity:.65}
.stat b{display:block;font:600 27px/1.08 var(--display);letter-spacing:.01em;font-variant-numeric:tabular-nums}
.stat span{display:block;font:11px/1.4 var(--sans);color:var(--dim);margin-top:4px;letter-spacing:.04em}

/* 面板：直角 + 右上角刻角是签名细节 */
.card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:0;padding:15px 17px;margin:11px 0}
.card::before{content:'';position:absolute;top:-1px;right:-1px;border-top:10px solid var(--accent);border-left:10px solid transparent;opacity:.8}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font:500 10.5px/1.4 var(--mono);color:var(--dim);letter-spacing:.08em;text-align:left;padding:8px 9px;border-bottom:1px solid var(--ink);white-space:nowrap}
td{padding:8px 9px;font-size:13px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:hover td,tr:hover td{background:rgba(30,78,122,.045)}
tr:last-child td{border-bottom:0}
th:nth-child(n+3),td:nth-child(n+3){text-align:right}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dim);margin-right:7px;vertical-align:middle}
.bar{height:5px;border-radius:0;background:var(--line-soft);overflow:hidden;margin:8px 0}
.bar>i{display:block;height:100%;background:var(--accent)}
.throughput{display:flex;gap:3px;align-items:flex-end;height:62px;margin-top:8px}
.throughput .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px}
.throughput .v{background:var(--blue);width:100%;min-height:2px}
.throughput .d{font:10px/1 var(--mono);color:var(--dim)}

/* 标签：小方签，不做胶囊 */
.badge{display:inline-block;font:10.5px/1.5 var(--mono);padding:0 4px;border:1px solid var(--line);border-radius:0;color:var(--dim);background:var(--paper);white-space:nowrap}
.b-ok{color:var(--ok);border-color:rgba(28,107,77,.45)}
.b-warn{color:var(--warn);border-color:rgba(138,91,19,.45)}
.b-block{color:var(--bad);border-color:rgba(176,53,44,.45)}
.b-blue{color:var(--blue);border-color:rgba(30,78,122,.4)}
.btn{display:inline-block;background:var(--panel);border:1px solid var(--ink);color:var(--ink);padding:6px 12px;border-radius:0;font:500 13px/1.4 var(--sans);cursor:pointer;text-decoration:none}
.btn:hover{background:var(--ink);color:var(--paper);border-color:var(--ink);text-decoration:none}
.btn[disabled]{opacity:.35;cursor:not-allowed}
.btn[disabled]:hover{background:var(--panel);color:var(--ink)}
input,select,textarea{background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:0;padding:6px 9px;font:13.5px/1.5 var(--sans)}
input:focus,select:focus,textarea:focus,.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
pre{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0;padding:11px;overflow:auto;font:12px/1.7 var(--mono);color:var(--ink)}
ul,ol{margin:8px 0;padding-left:20px}li{margin:5px 0}
code{font:12px/1.4 var(--mono);color:var(--accent-deep)}
.prose{font-size:15px;line-height:1.85;max-width:74ch}
.prose h1{font-size:26px}
.prose h2{font-size:19px;border:0;padding:0;margin:24px 0 10px}
.prose h2::before,.prose h1::before{display:none}
.prose h3{font-size:16px;margin:18px 0 8px}
.prose p{margin:10px 0}
.prose ul{margin:8px 0;padding-left:22px}
.diff{font:12px/1.65 var(--mono)}
.diff th,.diff td{text-align:left!important;padding:3px 9px;white-space:pre-wrap;word-break:break-word;vertical-align:top}
.diff th{font-size:10px;color:var(--dim);letter-spacing:.06em}
.diff td:first-child{width:22px;text-align:center!important}
.diff td:nth-child(2),.diff td:nth-child(3){width:56px;color:var(--dim);text-align:right!important}
.diff-add{background:rgba(28,107,77,.10)}
.diff-add td:first-child,.diff-add td:last-child{color:#16543c}
.diff-del{background:rgba(176,53,44,.09)}
.diff-del td:first-child,.diff-del td:last-child{color:#8a2a22}
.diff-same td:last-child{color:var(--dim)}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1px;margin:14px 0;border:1px solid var(--line);background:var(--line)}
.feature{background:var(--panel);padding:14px 16px;border:0}
.feature h3{font:600 14px/1.4 var(--display);margin:0 0 5px;color:var(--ink)}
.feature p{margin:0;font-size:12.5px;color:var(--dim);line-height:1.7}
.feature .chip{display:inline-block;font:10px var(--mono);color:var(--dim);margin-bottom:6px;letter-spacing:.06em}
.feature a{font-size:12px}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;margin:14px 0;border:1px solid var(--line);background:var(--line)}
.step{position:relative;background:var(--panel);padding:13px 15px;border:0}
.step b{display:block;color:var(--ink);margin-bottom:4px;font-size:13px}
.step span{font-size:12px;color:var(--dim);line-height:1.65;display:block}
.step i{position:absolute;top:9px;right:11px;font:normal 10px var(--mono);color:var(--accent)}
.defs{margin:4px 0 0}
.defs>div{display:grid;grid-template-columns:180px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid var(--line-soft)}
.defs>div:last-child{border-bottom:0}
.defs b{font-size:13px;font-weight:600}
.defs span{font-size:12.5px;color:var(--dim);line-height:1.7}

/* 分页：方格页码 */
.pager{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:15px 0 4px}
.pager .btn{padding:4px 9px;font-size:12px}
.pager .btn[aria-disabled="true"]{opacity:.35;pointer-events:none}
.pager .pager-meta{color:var(--dim);font:11.5px var(--mono);margin-left:auto}
.pager .pager-pages{display:flex;gap:3px;flex-wrap:wrap}
.pager .pager-pages a,.pager .pager-pages span{display:inline-grid;place-items:center;min-width:25px;height:25px;padding:0 4px;border:1px solid var(--line);font:11.5px var(--mono);color:var(--dim)}
.pager .pager-pages a:hover{border-color:var(--ink);color:var(--ink)}
.pager .pager-pages .current{border-color:var(--accent);color:var(--accent-deep);background:rgba(226,88,34,.08)}
.pager .pager-pages .pager-gap{border:0;min-width:auto;color:var(--dim);padding:0 2px}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:11px 0;padding:8px 0;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft)}
.toolbar .spacer{flex:1}
details.disclosure{border:1px dashed var(--line);background:rgba(247,250,252,.6);padding:0;margin:10px 0}
details.disclosure>summary{cursor:pointer;padding:8px 11px;font:12px var(--mono);color:var(--dim);list-style:none}
details.disclosure>summary::-webkit-details-marker{display:none}
details.disclosure>summary::before{content:'[+] ';color:var(--accent)}
details.disclosure[open]>summary::before{content:'[−] '}
details.disclosure>summary:hover{color:var(--ink)}
details.disclosure>.disclosure-body{padding:0 11px 11px}
.job-panel{position:fixed;right:24px;bottom:24px;width:min(360px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--ink);padding:12px 14px;z-index:70;box-shadow:6px 6px 0 rgba(12,26,38,.14)}
.job-panel[hidden]{display:none}
.job-panel b{font:600 13px var(--display)}
.job-panel .bar{margin:9px 0 7px}
.job-panel.done{border-color:var(--ok)}
.review-row.is-queued{opacity:.45}
.review-row input:disabled{opacity:.35;cursor:not-allowed}
.review-row.is-queued td{background:rgba(226,88,34,.05)}

/* 一次性入场，不做满屏 hover 动画 */
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.wrap>*{animation:rise .48s cubic-bezier(.22,1,.36,1) both}
.wrap>:nth-child(2){animation-delay:.04s}.wrap>:nth-child(3){animation-delay:.08s}.wrap>:nth-child(4){animation-delay:.11s}
.wrap>:nth-child(5){animation-delay:.14s}.wrap>:nth-child(n+6){animation-delay:.16s}

@media(max-width:900px){
  .wrap{padding:12px 14px 60px}
  .nav{flex-wrap:wrap;gap:4px;position:static;padding:8px 0}
  .nav-brand{font-size:17px}
  .nav-groups{width:100%}
  .nav-item{padding:6px 8px;border-left:0}
  .nav-group{position:static}
  .nav-menu{position:static;margin:4px 0 6px;box-shadow:none;min-width:0}
  .nav-right{width:100%;margin-left:0}
  h1{font-size:24px}
  .row:has(.stat){display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat{flex:none;min-width:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
  .row:has(.stat) .stat:nth-child(2n){border-right:0}
  .stat b{font-size:22px;overflow-wrap:anywhere}
  .card table{display:block;overflow-x:auto;white-space:nowrap}
  .pager .pager-meta{margin-left:0}
  body{overflow-x:hidden}
  .row>*{min-width:0}
  .card{overflow-wrap:anywhere}
}
@media(prefers-reduced-motion:reduce){.wrap>*{animation:none!important}}
`;;;


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
    if(light&&d.workerPhase){var m={drafting:'起草中',ingesting:'扫描中',sleeping:'等待中',paused:'已暂停',starting:'启动中',stopping:'停止中'};var dot={'drafting':'#a33b2b','ingesting':'#9a6b1e','sleeping':'#8a8478','paused':'#9a6b1e','stopping':'#a33b2b'}[d.workerPhase]||'#6b7280';light.innerHTML='<span class="dot" style="background:'+dot+'"></span>worker: '+(m[d.workerPhase]||d.workerPhase);}
    var badge=document.getElementById('pending-badge');
    if(badge&&typeof d.pendingDrafts==='number'){badge.textContent='待审 '+d.pendingDrafts;}
  }
  function poll(){fetch('/api/overview',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    render(d);
    if(version===null){version=d.version;return;}
    if(d.version!==version&&document.activeElement&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){show('有更新（当前有输入，未自动刷新）· 点击刷新');return;}
    if(d.version!==version){version=d.version;show('有更新 · 点击刷新');}
  }).catch(function(){});}
  var navGroups=document.querySelectorAll('.nav-group');
  navGroups.forEach(function(group){
    group.addEventListener('toggle',function(){if(group.open){navGroups.forEach(function(other){if(other!==group)other.open=false;});}});
  });
  document.addEventListener('click',function(event){navGroups.forEach(function(group){if(group.open&&!group.contains(event.target))group.open=false;});});
  document.addEventListener('keydown',function(event){if(event.key==='Escape'){navGroups.forEach(function(group){group.open=false;});}});
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
  const pendingShown = data.pending.slice(0, 10);
  const queueShown = data.queue.slice(0, 15);
  const pendingRows = pendingShown.map((view) => {
    const level = view.actions.accept ? (view.findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok') : 'block';
    return `<tr>
      <td>${findingBadge(level)}</td>
      <td><a href="/audit/${esc(view.draftId)}">${esc(view.title)}</a>
        <div class="mono">${esc(view.rawPath)}</div></td>
      <td>${view.claims.length}</td><td>${esc(view.tier)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">没有待审草稿。先点「扫描并分档」，再对队列里的条目生成草稿。</td></tr>';

  const queueRows = queueShown.map((item) => `<tr>
      <td>${esc(item.title)}<div class="mono">${esc(item.rawPath)}</div></td>
      <td>${item.charCount.toLocaleString()} 字</td>
      <td><span class="badge b-blue">${esc(item.state)}</span></td>
      <td>${item.draftId
        ? `<a class="btn" href="/audit/${esc(item.draftId)}">去审阅</a>`
        : `<form method="post" action="/actions/digest" style="margin:0">
             <input type="hidden" name="rawPath" value="${esc(item.rawPath)}">
             <button class="btn" type="submit">生成草稿</button></form>`}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">队列为空。</td></tr>';

  return layout('审核台', `${nav('/')}
  ${pageHead('secondBrain 审核台', `${data.mode === 'cloud' ? '云模型模式' : 'mock 模型模式'} · 真实状态机 · 每次入库一次 git commit`, '<a class="btn" href="/usage">用量明细</a>')}

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

  <h2>待审草稿（人只在这里动手）· ${data.pending.length} 篇${data.pending.length > pendingShown.length ? `，显示前 ${pendingShown.length}` : ''}</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>预警</th><th>草稿</th><th>claims</th><th>档位</th></tr>${pendingRows}
  </table></div>
  ${data.pending.length > pendingShown.length ? `<div class="row" style="justify-content:flex-end;margin-top:6px"><a class="btn" href="/audit">查看全部 ${data.pending.length} 篇 →</a></div>` : ''}

  <h2>队列 · ${data.queue.length} 条${data.queue.length > queueShown.length ? `，显示前 ${queueShown.length}` : ''}</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>原文</th><th>字数</th><th>状态</th><th></th></tr>${queueRows}
  </table></div>`);
}

export function reviewPage(view: ReviewViewV1, hits: readonly ScoredHit[] = [], query = ''): string {
  const level = view.actions.accept ? (view.findings.some((f) => f.severity === 'warn') ? 'warn' : 'ok') : 'block';
  const findings = view.findings.map((finding) => `<div class="card" style="margin:6px 0;border-color:${
    finding.severity === 'block' ? 'var(--bad)' : finding.severity === 'warn' ? 'var(--warn)' : 'var(--ok)'}">
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
    <form method="post" action="/audit/${esc(view.draftId)}/accept" style="margin:0">
      <button class="btn primary" type="submit" ${view.actions.accept ? '' : 'disabled'}>通过并入库</button>
    </form>
    <form method="post" action="/audit/${esc(view.draftId)}/reject" class="row" style="margin:0">
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

  return layout('搜索', `${nav('/search')}
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

  return layout('用量', `${nav('/usage')}
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

interface NavGroup {
  readonly label: string;
  readonly href?: string;
  readonly children?: readonly { readonly href: string; readonly label: string }[];
}

/**
 * 信息架构：一级导航只保留 6 个入口（工作台 + 5 个分组），其余页面收进分组的二级菜单。
 * 分组原则：内容=生产流水线，知识=检索与知识资产，写作=主编台相关，运维=系统与用量，帮助=文档类。
 */
const NAV_GROUPS: readonly NavGroup[] = [
  { label: '工作台', href: '/' },
  {
    label: '内容',
    children: [
      { href: '/articles', label: '素材库' },
      { href: '/audit', label: '审核' },
      { href: '/exceptions', label: '异常' },
    ],
  },
  {
    label: '知识',
    children: [
      { href: '/nodes', label: '知识节点' },
      { href: '/topics', label: '主题' },
      { href: '/claims', label: 'claims' },
      { href: '/kb-health', label: '体检' },
      { href: '/search', label: '搜索' },
    ],
  },
  {
    label: '写作',
    children: [
      { href: '/compose', label: '主编台' },
      { href: '/deai', label: '去 AI 味' },
      { href: '/qa', label: '问答链' },
    ],
  },
  {
    label: '运维',
    children: [
      { href: '/operations', label: '运维中心' },
      { href: '/usage', label: '用量' },
    ],
  },
  {
    label: '帮助',
    children: [
      { href: '/guide', label: '使用说明' },
      { href: '/about', label: '关于本工作台' },
    ],
  },
];

function nav(active = ''): string {
  const isActive = (href: string): boolean => active === href || (href !== '/' && active.startsWith(`${href}/`));
  const groupActive = (group: NavGroup): boolean =>
    group.href !== undefined ? isActive(group.href) : (group.children ?? []).some((child) => isActive(child.href));
  const items = NAV_GROUPS.map((group) => {
    if (group.href !== undefined) {
      return `<a class="nav-item${groupActive(group) ? ' active' : ''}" href="${group.href}">${esc(group.label)}</a>`;
    }
    const children = (group.children ?? [])
      .map((child) => `<a href="${child.href}" class="${isActive(child.href) ? 'active' : ''}">${esc(child.label)}</a>`)
      .join('');
    return `<details class="nav-group"><summary class="nav-item${groupActive(group) ? ' active' : ''}">${esc(group.label)}</summary><div class="nav-menu">${children}</div></details>`;
  }).join('');
  return `<div class="nav">
    <a class="nav-brand" href="/"><span class="seal">SB</span>secondBrain</a>
    <div class="nav-groups">${items}</div>
    <span class="nav-right">
      <span id="worker-light" style="color:var(--dim);font-size:12px;white-space:nowrap">worker: --</span>
      <span id="pending-badge" class="badge b-warn" style="margin-left:8px">待审 0</span>
    </span>
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
    `<a class="btn" style="${key === data.group ? 'background:var(--ink);color:var(--paper)' : ''}" href="/articles${qs({ group: key })}">${label} <span class="muted">${data.groupCounts[key] ?? 0}</span></a>`,
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
    <td class="muted">${esc(formatDate(item.updatedAt))}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">没有匹配的文章</td></tr>';

  const pageSize = Math.max(1, Math.ceil(data.total / Math.max(1, data.pages)));

  return layout('素材库', `${nav('/articles')}
  ${pageHead('素材库', `按状态/来源/时间筛选原始素材；当前筛选 ${data.total.toLocaleString()} 篇，每页 ${pageSize} 篇。`, '<a class="btn" href="/audit">待审队列 →</a>')}
  <div class="toolbar">${tabs}</div>
  <form class="toolbar" method="get" action="/articles" style="gap:8px">
    <input type="hidden" name="group" value="${esc(data.group)}">
    <select name="source">${sourceOptions}</select>
    <select name="days">${dayOptions}</select>
    <select name="triage">${triageOptions}</select>
    <select name="sort">${sortOptions}</select>
    <input name="q" value="${esc(data.query)}" placeholder="搜索标题或路径">
    <button class="btn" type="submit">筛选</button>
    <a class="btn" href="/articles">重置</a>
  </form>
  <div class="card table-wrap"><table>
    <tr><th>标题</th><th>来源</th><th>状态</th><th>triage</th><th>字数</th><th>更新</th></tr>${rows}
  </table></div>
  ${pager('/articles', data.page, data.pages, data.total, pageSize, { group: data.group, source: data.source, days: data.days, triage: data.triage, sort: data.sort, q: data.query })}`);
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
    ? `<a class="btn" href="/audit/${encodeURIComponent(data.draft.id)}">去审阅 →</a>` : '';

  return layout('文章详情', `${nav('/articles')}
  <div class="row" style="justify-content:space-between"><h1>${esc(data.title)}</h1><a class="btn" href="/articles">← 文章库</a></div>
  <div class="muted">${esc(data.rawPath)}</div>
  <div class="row" style="margin-top:12px">
    <div class="stat"><b>${esc(stateLabel(data.state))}</b><span>状态</span></div>
    <div class="stat"><b>${esc(data.sourceKey)}</b><span>来源</span></div>
    <div class="stat"><b>${data.charCount.toLocaleString()}</b><span>字符</span></div>
    <div class="stat"><b>${esc(formatDate(data.updatedAt))}</b><span>更新时间</span></div>
    ${data.commitSha ? `<div class="stat"><b>${esc(data.commitSha.slice(0, 7))}</b><span>commit</span></div>` : ''}
  </div>

  <h2>triage</h2>
  <div class="card">${data.triage
    ? `<div>${esc(triageLabel(data.triage.status))} · 分数 ${data.triage.score} · ${data.triage.judgments} 条判断句</div>
       <div class="muted">${data.triage.reasons.map((reason) => esc(reasonLabel(reason))).join('、') || '无理由'}</div>`
    : '<span class="muted">无 triage 结果</span>'}</div>

  <h2>时间线</h2>
  <div class="card">${data.timeline.length === 0 ? '<span class="muted">暂无事件</span>' : `<table>${data.timeline.map((event) => `<tr><td class="muted">${esc(formatDateTime(event.at, { seconds: true }))}</td><td>${esc(event.type)}</td></tr>`).join('')}</table>`}</div>

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
  readonly pendingLimit: number;
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
  readonly progress: { readonly done: number; readonly total: number };
  readonly throughput: readonly { readonly day: string; readonly count: number }[];
  /** 项目依赖的 GitHub 仓库（代码 / vault / raw）及其实时同步状态。 */
  readonly repos: readonly RepoStatus[];
  /** 本次加载是否执行了 git fetch（页面会显示"远端状态为刚检查"）。 */
  readonly reposFetched: boolean;
}

function fmtEta(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '待估算';
  if (hours < 1) return `约 ${Math.round(hours * 60)} 分钟`;
  return `约 ${hours.toFixed(1)} 小时`;
}

export function adminPage(data: AdminPageData): string {
  const codeRepo = data.repos.find((repo) => repo.key === 'code');
  const codeWebUrl = codeRepo?.remote ? webRepoUrl(codeRepo.remote) : null;
  const maintainerDocUrl = codeWebUrl ? `${codeWebUrl}/blob/main/docs/MAINTAINERS.md` : null;
  const repoCards = data.repos.map((repo) => {
    const remoteLine = repo.remote
      ? (/^(https?:|ssh:)/.test(repo.remote)
        ? `<a href="${esc(repo.remote.replace(/\.git$/, ''))}" target="_blank" rel="noreferrer">${esc(repo.remote)}</a>`
        : `<code>${esc(repo.remote)}</code>`)
      : '<span class="muted">未配置远端</span>';
    const syncBadge = repo.ahead === null
      ? '<span class="badge">同步状态未知（点「检查远端」）</span>'
      : repo.ahead === 0 && repo.behind === 0
        ? '<span class="badge b-ok">已同步</span>'
        : repo.ahead !== null && repo.ahead > 0 && repo.behind === 0
          ? `<span class="badge b-warn">领先 ${repo.ahead} 未推送（点「推送此仓库」备份）</span>`
          : `<span class="badge b-warn">领先 ${repo.ahead} / 落后 ${repo.behind}</span>`;
    const stateBadge = repo.error !== null
      ? `<span class="badge b-block">${esc(repo.error)}</span>`
      : repo.dirtyCount > 0
        ? `<span class="badge b-warn">${repo.dirtyCount} 处未提交</span>`
        : '<span class="badge b-ok">工作区干净</span>';
    const headLine = repo.head
      ? `<code>${esc(repo.head.sha)}</code> ${esc(cut(repo.head.subject, 44))}
         <div class="muted">${esc(formatDateTime(repo.head.date))} · ${esc(repo.head.author)}</div>`
      : '<span class="muted">—</span>';
    const fetchNote = repo.fetchError !== null
      ? `<div class="muted" style="color:var(--bad)">fetch 失败：${esc(repo.fetchError)}</div>`
      : '';
    return `<div class="card" style="margin:8px 0">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div><b>${esc(repo.label)}</b> ${syncBadge} ${stateBadge}</div>
        <div class="muted" style="font-size:12.5px"><code>${esc(repo.path)}</code></div>
      </div>
      <div style="margin:8px 0 6px">远端：${remoteLine}</div>
      <div style="margin-bottom:6px">分支：<code>${esc(repo.branch ?? '—')}</code> · HEAD：${headLine}</div>
      ${fetchNote}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <form method="post" action="/actions/ops/repo/pull"><input type="hidden" name="key" value="${esc(repo.key)}"><button class="btn" type="submit"${repo.error !== null ? ' disabled' : ''}>更新此仓库</button></form>
        <form method="post" action="/actions/ops/repo/push" onsubmit="return confirm('把本地提交推送到 GitHub 备份？')"><input type="hidden" name="key" value="${esc(repo.key)}"><button class="btn" type="submit"${repo.error !== null ? ' disabled' : ''}>推送此仓库</button></form>
        <form method="post" action="/actions/ops/repo/remote" class="row" style="gap:6px;align-items:center;flex:1;min-width:280px">
          <input type="hidden" name="key" value="${esc(repo.key)}">
          <input name="remote" value="${esc(repo.remote ?? '')}" placeholder="https://github.com/<owner>/<repo>.git" style="flex:1;min-width:220px">
          <button class="btn" type="submit">修改远端</button>
        </form>
      </div>
    </div>`;
  }).join('');
  const repoRefreshLine = data.reposFetched
    ? '<span class="muted">远端状态：已在本页加载时 fetch</span>'
    : '<span class="muted">远端状态以最近一次 fetch 为准；点「检查远端」可强制刷新</span>';
  const stateRows = Object.entries(data.counts).sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `<tr><td>${esc(stateLabel(state))}</td><td>${count.toLocaleString()}</td></tr>`).join('');
  const events = data.recentEvents.map((event) => `<tr><td class="muted">${esc(formatDateTime(event.at, { seconds: true }))}</td><td>${esc(event.type)}</td><td class="muted">${esc(event.aggregateId)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">暂无事件</td></tr>';

  const worker = data.worker;
  const elapsed = worker?.phase === 'drafting' && worker.startedAt
    ? Math.max(0, Math.round((Date.parse(worker.updatedAt) - Date.parse(worker.startedAt)) / 1000))
    : null;
  const workerBlock = worker
    ? `<div class="row">
         <div class="stat"><b>${esc(phaseLabel(worker.phase))}</b><span>worker 状态</span></div>
         <div class="stat"><b>${esc(formatClock(worker.updatedAt))}</b><span>状态更新</span></div>
         ${worker.lastTick ? `<div class="stat"><b>${worker.lastTick.drafted} / ${worker.lastTick.failed}</b><span>上轮 起草 / 失败</span></div>` : ''}
         ${worker.lastTick ? `<div class="stat"><b>${worker.lastTick.queueLength.toLocaleString()}</b><span>上轮队列</span></div>` : ''}
       </div>
       ${worker.phase === 'drafting' && worker.title
         ? `<div class="card" style="margin-top:10px"><div><b>正在起草：</b>${esc(worker.title)}${elapsed !== null ? `（已 ${elapsed} 秒）` : ''}</div>
            <div class="muted">${esc(worker.rawPath ?? '')}</div></div>`
         : '<div class="card muted" style="margin-top:10px">当前没有正在起草的文章</div>'}
       ${worker.stale ? '<div class="card" style="margin-top:10px;border-color:var(--bad)">⚠️ worker 状态超过 10 分钟未更新，可能未运行</div>' : ''}`
    : '<div class="card muted">没有 worker 状态（worker 可能未启动）</div>';

  return layout('运维中心', `${nav('/operations')}
  <div class="row" style="justify-content:space-between"><h1>运维中心</h1><span class="muted">${esc(data.env.mode)} 模式</span></div>

  <h2>运行状态</h2>
  ${(data.drafts.pending ?? 0) >= data.pendingLimit ? `<div class="card" style="border-color:var(--warn);margin-bottom:10px"><b>已触发背压</b>：待审草稿 ${data.drafts.pending ?? 0} / 上限 ${data.pendingLimit}，worker 已停止起草。请先审核（<a href="/audit">审核中心</a>）。</div>` : `<div class="muted" style="margin-bottom:10px">待审草稿 ${data.drafts.pending ?? 0} / 上限 ${data.pendingLimit}（达到上限自动停止起草）</div>`}
  ${data.paused
    ? `<div class="card" style="border-color:var(--warn);margin-bottom:10px"><b>已暂停</b>：当前任务处理完后不再开始新任务。
         <form method="post" action="/actions/worker/resume" style="display:inline;margin-left:8px"><button class="btn" type="submit">继续处理</button></form></div>`
    : `<div class="card" style="margin-bottom:10px">自动处理中。
         <form method="post" action="/actions/worker/pause" style="display:inline;margin-left:8px"><button class="btn" type="submit">暂停（完成当前任务后）</button></form></div>`}
  ${workerBlock}

  <h2>整体进度</h2>
  <div class="card">
    <div class="muted">已入库 ${data.progress.done.toLocaleString()} / 全部 ${data.progress.total.toLocaleString()}（${data.progress.total > 0 ? Math.round((data.progress.done / data.progress.total) * 100) : 0}%）</div>
    <div class="bar"><i style="width:${data.progress.total > 0 ? (data.progress.done / data.progress.total) * 100 : 0}%"></i></div>
    <div class="throughput">${data.throughput.map((entry) => {
      const max = Math.max(1, ...data.throughput.map((item) => item.count));
      return `<div class="col"><span class="d">${entry.count}</span><div class="v" style="height:${Math.max(3, (entry.count / max) * 48)}px"></div><span class="d">${entry.day.slice(5)}</span></div>`;
    }).join('')}</div>
    <div class="muted" style="margin-top:6px">最近 7 天每天生成的草稿数（吞吐）</div>
  </div>

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

  <h2>生产配置</h2>
  <div class="card"><form method="post" action="/actions/ops/config" class="row" style="gap:8px;align-items:center">
    待审上限：<input name="pendingLimit" type="number" min="1" value="${data.pendingLimit}" style="width:100px">
    <button class="btn" type="submit">保存</button>
    <span class="muted">达到该数量时 worker 自动停止起草（下一轮生效）</span>
  </form></div>

  <h2>运维操作</h2>
  <div class="card"><div class="row" style="gap:8px;flex-wrap:wrap">
    <form method="post" action="/actions/ops/scan"><button class="btn" type="submit">立即扫描新原文</button></form>
    <form method="post" action="/actions/ops/sync"><button class="btn" type="submit">立即同步 git</button></form>
    <form method="post" action="/actions/ops/backup"><button class="btn" type="submit">立即备份状态库</button></form>
  </div>
  <table style="margin-top:10px"><tr><th>时间</th><th>动作</th><th>结果</th><th>详情</th></tr>
  ${data.ops.length === 0 ? '<tr><td colspan="4" class="muted">还没有执行记录</td></tr>' : data.ops.map((op) => `<tr><td class="muted">${esc(formatDateTime(op.at, { seconds: true }))}</td><td>${esc(op.action)}</td><td>${op.ok ? '✅ 成功' : '❌ 失败'}</td><td class="muted">${esc(op.detail)}</td></tr>`).join('')}
  </table></div>

  <h2>GitHub 仓库与维护</h2>
  <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0">
    <form method="post" action="/actions/ops/repo/all"><button class="btn" type="submit">全部更新</button></form>
    <a class="btn" href="/operations?fetch=1">检查远端</a>
    ${repoRefreshLine}
  </div>
  ${repoCards}
  <div class="card" style="margin-top:10px">
    <div class="muted" style="line-height:1.8">
      <b>可维护性说明</b>：项目运行只依赖「这台服务器 + GitHub 仓库」，不依赖任何个人电脑或账号在线；
      代码、知识库、原文分别由上面的仓库托管，服务器是唯一写者。<br>
      vault/raw 由 sync timer 每 15 分钟自动 fast-forward，vault 的本地提交（审核入库）同时会推回 GitHub 备份；代码仓库更新后需要重启服务（<code>systemctl restart secondbrain-server secondbrain-worker</code>）。
      每日 03:17 自动快照 <code>state.db</code>（备份目录见「环境」）。<br>
      换机器、换 GitHub 账号/组织、轮换密钥、恢复数据：见 ${maintainerDocUrl !== null ? `<a href="${esc(maintainerDocUrl)}" target="_blank" rel="noreferrer">维护与所有权手册（docs/MAINTAINERS.md）</a>` : '<code>docs/MAINTAINERS.md</code>（代码仓库内）'}。
    </div>
  </div>

  <h2>worker 日志（最近 12 行）</h2>
  <div class="card"><pre>${data.logs.length === 0 ? '（无法读取日志，可能权限不足）' : data.logs.map((line) => formatLogLine(line)).join('\n')}</pre></div>

  <h2>快捷操作</h2>
  <div class="card"><div class="row">
    <form method="post" action="/actions/ingest"><button class="btn" type="submit">扫描 raw/ 并分档</button></form>
    <a class="btn" href="/articles?state=queued">看待处理素材</a>
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
  readonly items: readonly { draftId: string; title: string; rawPath: string; tier: string; rationale: string; hasBlock: boolean; blockReason: string | null; createdAt: string }[];
  readonly accepted: number;
  readonly failed: number;
  readonly jobId: string;
  readonly repair?: { readonly examined: number; readonly repaired: number; readonly stillBlocked: number } | null;
  readonly rejected?: number | null;
}

export function reviewListPage(data: ReviewListPageData, page = 1): string {
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(data.items.length / pageSize));
  const current = Math.min(pages, Math.max(1, Math.trunc(page)));
  const pageItems = data.items.slice((current - 1) * pageSize, current * pageSize);
  const rows = pageItems.map((item) => `<tr class="review-row">
    <td><input type="checkbox" name="draftId" value="${esc(item.draftId)}"${item.hasBlock ? ` disabled title="${esc(item.blockReason ?? '存在阻断级预警')}"` : ''}></td>
    <td><a href="/audit/${encodeURIComponent(item.draftId)}" class="review-link">${esc(item.title)}</a></td>
    <td>${esc(item.tier)}</td>
    <td>${item.hasBlock ? '<span class="badge b-block">阻断</span>' : '<span class="badge b-ok">可审</span>'}</td>
    <td class="muted">${esc(formatDateTime(item.createdAt).slice(5))}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">没有待审草稿</td></tr>';

  const flash = data.accepted > 0 || data.failed > 0
    ? `<div class="card" style="border-color:var(--ok)">批量结果：成功 ${data.accepted} 篇${data.failed > 0 ? `，失败 ${data.failed} 篇（失败项仍在待审，见日志）` : ''}</div>` : '';
  const rejectFlash = data.rejected !== null && data.rejected !== undefined
    ? `<div class="card" style="border-color:var(--warn)">已驳回 ${data.rejected} 篇阻断草稿，不再出现在审核列表。</div>`
    : '';
  const repairFlash = data.repair
    ? `<div class="card" style="border-color:var(--ok)">修复完成：检查 ${data.repair.examined} 篇，修复 ${data.repair.repaired} 篇，仍有 ${data.repair.stillBlocked} 篇阻断（来源缺失/重复等无法自动修复，需人工驳回或重新生成）。</div>`
    : '';

  return layout('审核中心', `${nav('/audit')}
  ${pageHead('审核中心', `待审 ${data.items.length.toLocaleString()} 篇，可批量 ${(data.items.length - data.items.filter((item) => item.hasBlock).length).toLocaleString()} 篇、阻断 ${data.items.filter((item) => item.hasBlock).length.toLocaleString()} 篇；每页 ${pageSize} 篇，勾选只作用当前页。`, '<a class="btn" href="/articles?group=pending">去素材库 →</a>')}
  ${flash}
  ${rejectFlash}
  ${repairFlash}
  ${data.jobId ? `<div class="card" id="job-progress">批量处理中… <span id="job-text"></span></div><script>(function(){var id=${JSON.stringify(data.jobId)};var t=setInterval(function(){fetch("/api/jobs/"+id).then(function(r){return r.json()}).then(function(d){document.getElementById("job-text").textContent=d.done+"/"+d.total+"（成功 "+d.ok+"，失败 "+d.failed+"）";if(d.status==="done"){clearInterval(t);document.getElementById("job-progress").textContent="完成："+d.ok+" 成功 / "+d.failed+" 失败，刷新中…";setTimeout(function(){location.href="/audit";},800);}});},1000);})();</script>` : ""}
  <form method="post" action="/actions/review/bulk-accept" id="bulk-form">
    <div class="row" style="gap:8px;margin:12px 0;align-items:center">
      <button class="btn" type="button" id="select-all">全选本页</button>
      <button class="btn" type="button" id="clear-all">取消全选</button>
      <button class="btn" type="submit" id="bulk-submit" disabled>批量通过</button>
      <span class="mono" id="sel-count">已选 0 项</span>
      <span class="muted">键盘：j/k 移动，Enter 打开，a 勾选，r 取消</span>
    </div>
    <div class="card table-wrap" style="padding:4px 0"><table>
      <tr><th></th><th>标题</th><th>tier</th><th>检查</th><th>创建</th></tr>${rows}
    </table></div>
    <div class="muted" style="margin-top:6px">阻断项不可勾选：勾选框灰色、鼠标悬停可看到具体规则；点标题进入单篇审阅，可驳回或后续重新生成。</div>
    ${pager('/audit', current, pages, data.items.length, pageSize)}
  </form>
  <div class="row" style="gap:8px;margin:10px 0;align-items:center">
    <form method="post" action="/actions/review/repair" onsubmit="return confirm('按当前节点与配额重算阻断草稿；不会修改 claims 内容。继续？')">
      <button class="btn" type="submit">修复可修复阻断</button>
    </form>
    <form method="post" action="/actions/review/reject-blocked" onsubmit="return confirm('把全部阻断草稿驳回？驳回后不再出现在审核列表，且不会写入 wiki。')">
      <button class="btn" type="submit">驳回全部阻断项</button>
    </form>
    <span class="muted">修复只处理节点动作/配额；来源缺失、重复入库等无法自动修复，可直接驳回。</span>
  </div>
  <div class="job-panel" id="job-panel" hidden>
    <div class="row" style="justify-content:space-between;align-items:center">
      <b>批量通过处理中</b><span class="mono" id="job-text">0/0</span>
    </div>
    <div class="bar"><i id="job-bar" style="width:0"></i></div>
    <div class="muted" id="job-hint">后台逐篇入库；目标节点已变化时按追加式合并（保留现有内容）。页面可以继续滚动/勾选，完成后自动刷新。</div>
    <div class="mono" id="job-failures" style="margin-top:6px;white-space:pre-wrap;max-height:140px;overflow:auto" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" type="button" id="job-refresh" hidden>刷新列表</button></div>
  </div>
  <script>
  (function(){
    var form=document.getElementById('bulk-form');
    if(!form)return;
    var boxes=function(){return Array.prototype.slice.call(document.querySelectorAll('input[name=draftId]'));};
    var count=document.getElementById('sel-count');
    var submit=document.getElementById('bulk-submit');
    var panel=document.getElementById('job-panel');
    var jobText=document.getElementById('job-text');
    var jobBar=document.getElementById('job-bar');
    var timer=null;
    function selected(){return boxes().filter(function(c){return c.checked;});}
    function refresh(){
      var n=selected().length;
      count.textContent='已选 '+n+' 项';
      submit.textContent=n===0?'批量通过':'批量通过（'+n+'）';
      submit.disabled=n===0 || submit.dataset.busy==='1';
    }
    document.addEventListener('change',function(e){if(e.target && e.target.name==='draftId')refresh();});
    document.getElementById('select-all').addEventListener('click',function(){boxes().forEach(function(c){if(!c.disabled)c.checked=true;});refresh();});
    document.getElementById('clear-all').addEventListener('click',function(){boxes().forEach(function(c){c.checked=false;});refresh();});
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var ids=selected().map(function(c){return c.value;});
      if(ids.length===0)return;
      submit.dataset.busy='1';submit.disabled=true;submit.textContent='提交中…';
      var body=new URLSearchParams();
      ids.forEach(function(id){body.append('draftId',id);});
      fetch('/actions/review/bulk-accept',{method:'POST',body:body.toString(),headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'}})
        .then(function(r){return r.json();})
        .then(function(job){
          if(!job.ok)throw new Error(job.error&&job.error.message?job.error.message:'提交失败');
          panel.hidden=false;
          jobText.textContent='0/'+job.total;
          boxes().forEach(function(c){c.disabled=true;var tr=c.closest('tr');if(tr)tr.classList.add('is-queued');});
          timer=setInterval(function(){
            fetch('/api/jobs/'+job.jobId).then(function(r){return r.json();}).then(function(d){
              var pct=d.total?Math.round(d.done/d.total*100):100;
              jobBar.style.width=pct+'%';
              jobText.textContent=d.done+'/'+d.total+'（成功 '+d.ok+'，失败 '+d.failed+'）';
              if(d.status==='done'){
                clearInterval(timer);
                panel.classList.add('done');
                jobText.textContent='完成：成功 '+d.ok+' / 失败 '+d.failed;
                var fails=(d.failures||[]);
                var failureBox=document.getElementById('job-failures');
                var hint=document.getElementById('job-hint');
                var refreshBtn=document.getElementById('job-refresh');
                if(fails.length>0){
                  failureBox.hidden=false;
                  failureBox.textContent=fails.slice(0,8).map(function(f){return f.draftId+'：'+f.reason;}).join('\\n');
                  hint.textContent='失败项仍在待审；常见原因是存在阻断级预警，或草稿数据本身不完整。';
                  refreshBtn.hidden=false;
                } else {
                  hint.textContent='全部成功，刷新中…';
                  setTimeout(function(){location.href='/audit?ok='+d.ok+'&failed='+d.failed;},600);
                }
              }
            });
          },800);
        })
        .catch(function(err){
          submit.dataset.busy='';submit.disabled=false;refresh();
          window.alert('提交失败：'+err.message);
        });
    });
    var refreshBtnInit=document.getElementById('job-refresh');
    if(refreshBtnInit)refreshBtnInit.addEventListener('click',function(){location.href='/audit';});
    refresh();
  })();
  </script>
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


export function claimsPage(
  rows: readonly { draftId: string; text: string; inference: boolean; source: string }[],
  options: { readonly page?: number; readonly q?: string } = {},
): string {
  const pageSize = 25;
  const q = (options.q ?? '').trim();
  const needle = q.toLowerCase();
  const filtered = needle === ''
    ? rows
    : rows.filter((row) => row.text.toLowerCase().includes(needle) || row.source.toLowerCase().includes(needle) || row.draftId.toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(options.page ?? 1)));
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
  const items = slice.map((row) => `<li>${esc(row.text)}${row.inference ? ' <span class="badge b-warn">推断</span>' : ''}
    <div class="muted">来源：${esc(row.source)} · 草稿 ${esc(row.draftId)}</div></li>`).join('')
    || '<li class="muted">没有匹配的 claims</li>';
  return layout('claims', `${nav('/claims')}
  ${pageHead('已入库 claims', `来自已通过审核并入库的草稿；每个 claim 都带来源原文与所属草稿。当前筛选 ${filtered.length.toLocaleString()} 条（全量 ${rows.length.toLocaleString()} 条，来自搜索索引；用筛选缩小范围）。`)}
  <form class="toolbar" method="get" action="/claims">
    <input type="text" name="q" value="${esc(q)}" placeholder="筛选判断句 / 来源 / 草稿" style="min-width:320px">
    <button class="btn" type="submit">筛选</button>
    ${q === '' ? '' : '<a class="btn" href="/claims">清除</a>'}
  </form>
  <div class="card"><ol>${items}</ol></div>
  ${pager('/claims', page, pages, filtered.length, pageSize, q === '' ? {} : { q })}`);
}

export function guidePage(): string {
  return layout('使用说明', `${nav('/guide')}
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


export function nodesPage(rows: readonly { name: string; file: string; nodeType: string; claimedCount?: never; claimCount: number; sourceCount: number; aliases: readonly string[] }[], type: string, query: string, counts: Record<string, number>, stats: { total: number; totalClaims: number; bins: readonly { label: string; count: number }[]; byType: readonly { type: string; count: number; claims: number }[] }, top: number, page = 1): string {
  const tabs = ([['all', '全部'], ['concept', '概念'], ['topic', '主题'], ['person', '人物']] as const)
    .map(([key, label]) => `<a class="btn" style="${key === type ? 'background:var(--ink);color:var(--paper)' : ''}" href="/nodes?type=${key}&q=${encodeURIComponent(query)}">${label} <span class="muted">${counts[key] ?? 0}</span></a>`).join('');
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(pages, Math.max(1, Math.trunc(page)));
  const offset = (current - 1) * pageSize;
  const listRows = rows.slice(offset, offset + pageSize);
  const maxListClaims = Math.max(1, ...listRows.map((row) => row.claimCount));
  const rowsHtml = listRows.map((row, index) => `<div style="display:grid;grid-template-columns:34px minmax(0,1fr) minmax(50px,72px) 52px;gap:10px;align-items:center;padding:7px 2px;border-bottom:1px solid var(--line-soft)">
    <span class="muted mono" style="text-align:right">${offset + index + 1}</span>
    <span style="min-width:0"><a href="/nodes/${encodeURIComponent(row.file)}">${esc(row.name)}</a>${row.aliases.length > 0 ? ` <span class="muted">（${row.aliases.map((a) => esc(a)).join('、')}）</span>` : ''}</span>
    <span style="display:flex;align-items:center;gap:8px"><span style="flex:1;height:3px;background:var(--line-soft);overflow:hidden"><i style="display:block;height:100%;width:${(row.claimCount / maxListClaims) * 100}%;background:rgba(30,78,122,.55)"></i></span></span>
    <span class="mono" style="text-align:right;font-variant-numeric:tabular-nums">${row.claimCount}</span>
  </div>`).join('') || '<div class="muted">没有匹配的节点</div>';
  const maxBubbles = Math.min(200, rows.length);
  const hubs = rows.slice(0, maxBubbles);
  const visibleTop = Math.min(top, hubs.length);
  const tail = rows.length - hubs.length;
  const W = 880; const H = 430;
  const maxClaims = Math.max(1, ...hubs.map((row) => row.claimCount));
  const radiusOf = (claims: number): number => 5 + Math.sqrt(Math.max(1, claims) / maxClaims) * 50;
  const placed: Array<{ x: number; y: number; r: number; row: typeof hubs[number]; index: number }> = [];
  const cx = W / 2; const cy = H / 2;
  for (const [index, row] of hubs.entries()) {
    const r = radiusOf(row.claimCount);
    let angle = index * 2.399963;
    let distance = 0;
    let x = cx; let y = cy; let ok = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      x = cx + Math.cos(angle) * distance;
      y = cy + Math.sin(angle) * distance * 0.72;
      if (x - r < 4 || x + r > W - 4 || y - r < 4 || y + r > H - 4) { angle += 0.35; distance += 1.5; continue; }
      ok = placed.every((other) => Math.hypot(other.x - x, other.y - y) > other.r + r + 3);
      if (ok) break;
      angle += 0.35;
      distance += 1.9;
    }
    if (ok) placed.push({ x, y, r, row, index });
  }
  const COLORS: Record<string, string> = { concept: '#1e4e7a', topic: '#e25822', person: '#4b6b57' };
  const bubbles = placed.map((bubble) => {
    const color = COLORS[bubble.row.nodeType] ?? '#1e4e7a';
    const fontSize = bubble.r >= 16 ? 11 : bubble.r >= 10 ? 9 : 8;
    const maxChars = Math.max(1, Math.floor((bubble.r * 1.5) / fontSize));
    const label = bubble.row.name.slice(0, maxChars);
    return `<a href="/nodes/${encodeURIComponent(bubble.row.file)}" class="node-bubble" data-index="${bubble.index}" style="${bubble.index >= visibleTop ? 'display:none' : ''}"><title>${esc(bubble.row.name)} · ${bubble.row.claimCount} claims</title>
      <circle cx="${bubble.x.toFixed(1)}" cy="${bubble.y.toFixed(1)}" r="${bubble.r.toFixed(1)}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.65"></circle>
      <text x="${bubble.x.toFixed(1)}" y="${(bubble.y + fontSize * 0.36).toFixed(1)}" text-anchor="middle" font-size="${fontSize}" fill="var(--ink)">${esc(label)}</text>
    </a>`;
  }).join('');
  const chart = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="知识枢纽气泡图">${bubbles}</svg>
    <div class="row" style="align-items:center;gap:12px;margin-top:10px">
      <span class="muted">Top <b id="top-count" style="color:var(--ink)">${visibleTop}</b></span>
      <input id="top-range" type="range" min="20" max="${maxBubbles}" step="10" value="${visibleTop}" style="flex:1;max-width:420px">
      <span class="muted">拖动即时调整（不刷新页面）；其余 ${tail.toLocaleString()} 个节点隐藏</span>
    </div>
    <script>
    (function(){
      var range=document.getElementById('top-range');
      var label=document.getElementById('top-count');
      if(!range)return;
      range.addEventListener('input',function(){
        var n=Number(range.value);
        label.textContent=String(n);
        document.querySelectorAll('.node-bubble').forEach(function(el){
          var index=Number(el.getAttribute('data-index'));
          el.style.display=index<n?'inline':'none';
        });
      });
    })();
    </script>`;

  return layout('知识节点', `${nav('/nodes')}
  ${pageHead(`知识节点`, `共 ${stats.total.toLocaleString()} 个节点 · ${stats.totalClaims.toLocaleString()} 条 claims。列表按 claims 数排序，每页 ${pageSize} 个；枢纽图是同一批节点的另一种看法。`)}
  ${disclosure(`展开知识枢纽图（气泡图，当前 Top ${visibleTop} / ${hubs.length}）`, `<div class="card">${chart}<div class="row" style="gap:18px;margin-top:12px">${stats.byType.map((entry) => `<span class="muted">${esc(entry.type)}：${entry.count} 节点 · ${entry.claims} claims</span>`).join('')}</div></div>`)}
  <div class="toolbar">${tabs}<span class="spacer"></span>
    <form method="get" action="/nodes" class="row" style="gap:6px;align-items:center">
      <input type="hidden" name="type" value="${esc(type)}"><input name="q" value="${esc(query)}" placeholder="搜索节点名">
      <button class="btn" type="submit">筛选</button>
    </form>
  </div>
  <h2>节点清单（${rows.length.toLocaleString()} 个）</h2>
  <div class="card" style="padding:6px 10px">${rowsHtml}</div>
  ${pager('/nodes', current, pages, rows.length, pageSize, { type, q: query })}
  `);
}

export function nodePage(node: { name: string; file: string; nodeType: string; aliases: readonly string[]; definition: string; claims: readonly { text: string; source: string }[]; related: readonly string[] }, options: { readonly page?: number } = {}): string {
  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(node.claims.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(options.page ?? 1)));
  const slice = node.claims.slice((page - 1) * pageSize, page * pageSize);
  const claims = slice.map((claim) => `<li>${esc(claim.text)}<div class="muted">来源：<a href="/articles/${encodeURIComponent(claim.source)}">${esc(claim.source)}</a></div></li>`).join('') || '<li class="muted">暂无 claims</li>';
  const related = node.related.map((name) => `<span class="badge">${esc(name)}</span>`).join(' ') || '<span class="muted">无</span>';
  const meta = `${esc(node.file)} · ${esc(node.nodeType)}${node.aliases.length > 0 ? ` · 别名：${node.aliases.map((a) => esc(a)).join('、')}` : ''}`;
  return layout(node.name, `${nav('/nodes')}
  ${pageHead(node.name, meta, `<a class="btn" href="/qa?source=topic:${encodeURIComponent(node.name)}">问答链</a><a class="btn" href="/nodes">← 节点</a>`)}
  <h2>定义</h2>
  <div class="card">${esc(node.definition) || '<span class="muted">无定义</span>'}</div>
  <h2>观点（${node.claims.length} 条 claims）</h2>
  <div class="card"><ol>${claims}</ol></div>
  ${pager(`/nodes/${encodeURIComponent(node.file)}`, page, pages, node.claims.length, pageSize)}
  <h2>相关概念</h2><div class="card">${related}</div>`);
}

export function composePage(data: { articles: readonly { id: string; title: string; theme: string; nodeIds: readonly string[]; status: string; outline: string | null; updatedAt: string }[]; nodes: readonly { name: string; claimCount: number }[] }): string {
  const list = data.articles.map((article) => `<tr><td><a href="/compose/${encodeURIComponent(article.id)}">${esc(article.title)}</a></td><td>${esc(article.theme || '—')}</td><td>${article.nodeIds.length}</td><td>${esc(article.status)}</td><td class="muted">${article.outline ? '有大纲' : '未生成'}</td><td class="muted">${esc(formatDate(article.updatedAt))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">还没有文章，先创建一篇</td></tr>';
  const nodeOptions = data.nodes.map((node) => `<label class="muted" style="display:inline-flex;gap:6px;align-items:center;margin:2px 10px 2px 0"><input type="checkbox" name="node" value="${esc(node.name)}">${esc(node.name)} <span style="opacity:.6">${node.claimCount}</span></label>`).join('');
  return layout('主编台', `${nav('/compose')}
  <h1>主编台</h1>
  <div class="muted">主编台：选择知识节点，由模型生成大纲与正文；文中每个判断都带 raw 原文引用，可点开核对</div>
  <div class="card" style="margin-top:12px"><form method="post" action="/actions/compose/create">
    标题：<input name="title" placeholder="文章标题" style="width:280px">
    主题：<input name="theme" placeholder="主题（可选）" style="width:200px">
    <div style="margin:10px 0;max-height:150px;overflow:auto">${nodeOptions || '<span class="muted">暂无节点</span>'}</div>
    <button class="btn" type="submit">创建文章</button>
  </form></div>
  <h2>我的文章</h2>
  <div class="card" style="padding:4px 0"><table><tr><th>标题</th><th>主题</th><th>节点</th><th>状态</th><th>大纲</th><th>更新</th></tr>${list}</table></div>`);
}




/** 主编台正文的最小 Markdown 渲染：先转义再排版，只支持标题/列表/段落/加粗/引用链接。 */
function renderArticleMarkdown(markdown: string): string {
  const inline = (text: string): string =>
    esc(text)
      .replace(/\[\[(raw\/[^\]\n]+)\]\]/g, (_match, source: string) => {
        const label = esc(source.split('/').pop() ?? source);
        return `<a href="/articles/${encodeURIComponent(source)}">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const html: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) { html.push('</ul>'); inList = false; }
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') { closeList(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(4, (heading[1] as string).length + 1);
      html.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inline(item[1] as string)}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join('\n');
}

const ARTICLE_STATUS_LABEL: Record<string, string> = { draft: '草稿', review: '待主编审', final: '已定稿' };
const ARTICLE_SOURCE_LABEL: Record<string, string> = {
  ai_initial: 'AI 初稿', ai_refine: 'AI 改稿', deai: '去 AI 味', manual_edit: '手工编辑', restore: '回滚',
};

/** 截断长文本用于表格单元格（保留标题提示完整内容）。 */
function cut(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

export function composeArticlePage(data: {
  id: string;
  title: string;
  theme: string;
  status: string;
  outline: string | null;
  updatedAt: string;
  nodes: readonly { name: string; nodeType: string; claimCount: number; claims: readonly { text: string; source: string }[] }[];
  versions: readonly {
    id: string; versionNo: number; source: string; provider: string | null; model: string | null;
    inputTokens: number | null; outputTokens: number | null; cost: number | null; chars: number;
    instruction: string | null; note: string | null; createdAt: string;
  }[];
  current: { versionNo: number; contentMd: string; createdAt: string } | null;
  /** 写作契约检查（当前版本；无正文时为 null）。 */
  readonly contract: WritingContractReport | null;
  /** 审引清单（当前版本；无正文时为 null）。 */
  readonly citationAudit: CitationAuditReport | null;
}): string {
  const nodes = data.nodes.map((node) => `<div class="card" style="margin:8px 0">
    <div><b>${esc(node.name)}</b> <span class="badge">${esc(node.nodeType)}</span> <span class="muted">${node.claimCount} claims</span></div>
    <ul style="margin:8px 0 0;padding-left:18px">${node.claims.map((claim) => `<li>${esc(claim.text)}<div class="muted">${esc(claim.source)}</div></li>`).join('') || '<li class="muted">无 claims</li>'}</ul>
  </div>`).join('');
  const statusLabel = ARTICLE_STATUS_LABEL[data.status] ?? data.status;
  const currentVersion = data.versions.find((version) => version.versionNo === data.current?.versionNo) ?? null;
  const previousVersion = currentVersion
    ? data.versions.find((version) => version.versionNo < currentVersion.versionNo) ?? null
    : null;
  const hasOutline = (data.outline ?? '').trim().length > 0;
  const nextVersionNo = (data.versions[0]?.versionNo ?? 0) + 1;
  const articleHref = encodeURIComponent(data.id);

  const versionRows = data.versions.map((version) => {
    const diffHref = currentVersion && version.versionNo !== currentVersion.versionNo
      ? `/compose/${articleHref}/diff?from=${encodeURIComponent(version.id)}&to=${encodeURIComponent(currentVersion.id)}`
      : previousVersion && currentVersion
        ? `/compose/${articleHref}/diff?from=${encodeURIComponent(previousVersion.id)}&to=${encodeURIComponent(currentVersion.id)}`
        : '';
    const actions = diffHref
      ? `<a href="${diffHref}">${version.versionNo === currentVersion?.versionNo ? '对比上一版' : '对比当前'}</a>`
      : '';
    const restore = currentVersion && version.versionNo !== currentVersion.versionNo
      ? `<form method="post" action="/actions/compose/restore" style="display:inline;margin-left:10px" onsubmit="return confirm('把 v${version.versionNo} 的内容恢复为新版本？旧版本会保留。')"><input type="hidden" name="id" value="${esc(data.id)}"><input type="hidden" name="versionId" value="${esc(version.id)}"><button class="btn" type="submit" style="padding:2px 8px;font-size:12px">恢复此版</button></form>`
      : '';
    const note = version.instruction
      ? `<span title="${esc(version.instruction)}">${esc(cut(version.instruction, 36))}</span>`
      : version.note
        ? esc(version.note)
        : '—';
    return `<tr><td>v${version.versionNo}${version.versionNo === currentVersion?.versionNo ? ' <span class="badge b-ok">当前</span>' : ''}</td><td>${esc(ARTICLE_SOURCE_LABEL[version.source] ?? version.source)}</td><td class="muted">${note}</td><td class="muted">${esc(version.model ?? '—')}</td><td>${version.chars}</td><td class="muted">${version.inputTokens ?? 0} / ${version.outputTokens ?? 0}</td><td class="muted">${version.cost === null ? '—' : `$${version.cost.toFixed(4)}`}</td><td class="muted">${esc(formatDateTime(version.createdAt))}</td><td>${actions}${restore}</td></tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">还没有正文版本</td></tr>';

  const body = data.current
    ? `<div class="card prose">${renderArticleMarkdown(data.current.contentMd)}</div>
    <div class="muted">当前正文 v${data.current.versionNo}，生成于 ${esc(formatDateTime(data.current.createdAt))}；引用可点开原文核对。</div>`
    : '<div class="card muted">还没有正文。先确认大纲，再生成 v1。</div>';

  const actions = [
    data.current
      ? `<a class="btn" href="/compose/${articleHref}/export.md">导出 Markdown</a>`
      : '',
    data.current
      ? `<form method="post" action="/actions/compose/deai" style="display:inline" onsubmit="return confirm('对当前正文做去 AI 味改写并生成新版本？会调用模型，可能产生费用。')"><input type="hidden" name="id" value="${esc(data.id)}"><button class="btn" type="submit">去 AI 味</button></form>`
      : '',
    data.current && data.status !== 'final'
      ? `<form method="post" action="/actions/compose/finalize" style="display:inline"><input type="hidden" name="id" value="${esc(data.id)}"><button class="btn" type="submit">定稿</button></form>`
      : '',
    data.status === 'final'
      ? `<form method="post" action="/actions/compose/reopen" style="display:inline"><input type="hidden" name="id" value="${esc(data.id)}"><button class="btn" type="submit">重新打开</button></form>`
      : '',
  ].filter((entry) => entry !== '').join(' ');

  const qualityPanels = data.current
    ? `<h2>写作契约（v${data.current.versionNo}）</h2>
  <div class="card" style="padding:4px 0"><table><tr><th style="width:260px">检查项</th><th style="width:80px">状态</th><th>说明</th></tr>${qualityRows(data.contract?.checks ?? [])}</table></div>
  <div class="muted">通过 ${data.contract?.passCount ?? 0} · 注意 ${data.contract?.warnCount ?? 0} · 不通过 ${data.contract?.failCount ?? 0}（只做提示，不阻断保存）</div>
  <h2>审引清单</h2>
  <div class="card" style="padding:4px 0"><table><tr><th style="width:260px">检查项</th><th style="width:80px">状态</th><th>说明</th></tr>${qualityRows(data.citationAudit?.checks ?? [])}</table></div>
  <div class="muted">${data.citationAudit !== null ? `引用标记 ${data.citationAudit.markerCount} 处 / 去重来源 ${data.citationAudit.uniqueSources} 个 · ${data.citationAudit.passed ? '审引通过' : '审引存在阻断项'}` : '还没有正文，无法审引'}；引用可点开原文核对，导出前建议逐条确认。</div>`
    : '<div class="card muted">生成正文后，这里会显示「写作契约」与「审引清单」检查结果。</div>';

  return layout('主编台 · 文章', `${nav('/compose')}
  <div class="row" style="justify-content:space-between;align-items:center"><h1>${esc(data.title)}</h1><div class="row" style="gap:8px;align-items:center"><a class="btn" href="/qa?source=article:${encodeURIComponent(data.id)}">问答链</a><a class="btn" href="/compose">← 主编台</a>${actions}</div></div>
  <div class="muted">${esc(data.theme || '未设主题')} · <span class="badge${data.status === 'final' ? ' b-ok' : ''}">${esc(statusLabel)}</span> · 更新 ${esc(formatDateTime(data.updatedAt))}</div>

  <h2>大纲</h2>
  <div class="card"><form method="post" action="/actions/compose/outline/generate" onsubmit="return confirm('调用模型生成大纲，可能产生费用。继续？')"><input type="hidden" name="id" value="${esc(data.id)}">
    <button class="btn" type="submit">AI 生成大纲</button><span class="muted" style="margin-left:10px">基于 ${data.nodes.length} 个节点与 claims，生成后可编辑</span></form></div>
  <div class="card"><form method="post" action="/actions/compose/outline">
    <input type="hidden" name="id" value="${esc(data.id)}">
    <textarea name="outline" rows="12" style="width:100%;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:10px;font:inherit">${esc(data.outline ?? '')}</textarea>
    <div style="margin-top:8px"><button class="btn" type="submit">保存大纲</button>
    <span class="muted">大纲是正文的结构依据；保存后即可生成正文</span></div>
  </form></div>

  <h2>正文</h2>
  <div class="card"><form method="post" action="/actions/compose/body/generate" onsubmit="return confirm('调用模型生成正文 v${nextVersionNo}，可能产生费用。继续？')"><input type="hidden" name="id" value="${esc(data.id)}">
    <button class="btn" type="submit"${hasOutline ? '' : ' disabled'}>生成正文 v${nextVersionNo}</button>
    <span class="muted" style="margin-left:10px">${hasOutline ? '基于已确认大纲与 claims 生成，文中每个判断都带来源引用' : '请先填写或生成大纲'}</span></form></div>
  ${body}

  ${qualityPanels}

  <h2>改稿</h2>
  <div class="card"><form method="post" action="/actions/compose/refine" onsubmit="return confirm('按指令生成 v${nextVersionNo}，可能产生费用。继续？')">
    <input type="hidden" name="id" value="${esc(data.id)}">
    <textarea name="instruction" rows="3" placeholder="例如：语气更克制，减少形容词；第二小节补一个反例；结尾给出可执行建议" style="width:100%;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:10px;font:inherit"></textarea>
    <div style="margin-top:8px"><button class="btn" type="submit"${data.current ? '' : ' disabled'}>按指令生成 v${nextVersionNo}</button>
    <span class="muted">基于当前正文与指令生成新版本；旧版本保留，可对比与恢复</span></div>
  </form></div>

  <h2>版本历史（${data.versions.length}）</h2>
  <div class="card" style="padding:4px 0"><table><tr><th>版本</th><th>来源</th><th>指令 / 备注</th><th>模型</th><th>字数</th><th>tokens</th><th>成本</th><th>时间</th><th>操作</th></tr>${versionRows}</table></div>

  <h2>节点与 claims（${data.nodes.length} 个节点）</h2>${nodes}`);
}

/** 版本对比页：行级 diff，新增绿 / 删除红。 */
export function composeDiffPage(data: {
  articleId: string;
  title: string;
  from: { versionNo: number; source: string; createdAt: string };
  to: { versionNo: number; source: string; createdAt: string };
  stats: { added: number; removed: number; same: number };
  lines: readonly { kind: 'same' | 'add' | 'del'; text: string; fromNo: number | null; toNo: number | null }[];
}): string {
  const rows = data.lines.map((line) => {
    const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
    const fromNo = line.fromNo === null ? '' : String(line.fromNo);
    const toNo = line.toNo === null ? '' : String(line.toNo);
    return `<tr class="diff-${line.kind}"><td>${mark}</td><td>${fromNo}</td><td>${toNo}</td><td>${esc(line.text) || '&nbsp;'}</td></tr>`;
  }).join('');
  return layout('版本对比', `${nav('/compose')}
  <div class="row" style="justify-content:space-between"><h1>版本对比</h1><a class="btn" href="/compose/${encodeURIComponent(data.articleId)}">← 回到文章</a></div>
  <div class="muted">${esc(data.title)} · v${data.from.versionNo}（${esc(ARTICLE_SOURCE_LABEL[data.from.source] ?? data.from.source)}）→ v${data.to.versionNo}（${esc(ARTICLE_SOURCE_LABEL[data.to.source] ?? data.to.source)}）</div>
  <div class="row" style="gap:10px;margin:14px 0"><span class="badge b-ok">新增 ${data.stats.added}</span><span class="badge b-block">删除 ${data.stats.removed}</span><span class="badge">未变 ${data.stats.same}</span></div>
  <div class="card" style="padding:4px 0"><table class="diff"><tr><th></th><th>旧 v${data.from.versionNo}</th><th>新 v${data.to.versionNo}</th><th>内容</th></tr>${rows}</table></div>
  <div class="muted">行级 diff（LCS）：绿色为新增行，红色为删除行，灰色为未变行。</div>`);
}

export interface AboutStats {
  readonly rawTotal: number;
  readonly committed: number;
  readonly queued: number;
  readonly deferred: number;
  readonly pendingDrafts: number;
  readonly nodes: number;
  readonly claims: number;
  readonly articles: number;
  readonly calls: number;
  readonly estimatedCost: number;
}

export interface AboutPageData {
  readonly mode: string;
  readonly head: string;
  readonly dataDir: string;
  readonly vaultRoot: string;
  readonly workerPhase: string;
  readonly generatedAt: string;
  readonly stats: AboutStats;
}

/** 关于页：整个工作台的功能地图 + 实时数据概览（独立页面，便于向人介绍这套系统）。 */
export function aboutPage(data: AboutPageData): string {
  const stat = (value: string, label: string): string => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  const n = (value: number): string => value.toLocaleString('zh-CN');

  const features: readonly { title: string; href: string; group: string; body: string }[] = [
    { title: '工作台', href: '/', group: '工作台', body: '今日进度、队列与待办、快捷操作（扫描 / 起草）、最近动态。回答"今天该做什么"。' },
    { title: '素材库', href: '/articles', group: '内容', body: '全部原文（含 4k+ 条 legacy）：6 个分组、来源/时间/triage 筛选、排序、分页；详情含 triage 理由、草稿 claims、来源与事件时间线。' },
    { title: '审核中心', href: '/audit', group: '内容', body: 'AI 草稿在这里过人审：逐篇预览 claims/节点/finding，键盘 j/k/a/r 操作，支持勾选批量通过（异步提交、后台逐篇校验入库、进度与失败回显，不阻塞页面）。' },
    { title: '主编台', href: '/compose', group: '写作', body: '把知识节点写成文章：选节点 → AI 大纲 → 大纲可编辑 → 生成正文 → 改稿指令生成 vN+1 → 行级 diff → 恢复旧版 → 定稿 → 导出 Markdown。版本只增不改。' },
    { title: '问答链', href: '/qa', group: '写作', body: '把主题 claims 或文章正文抽成 Q-A 链（Q 切要害；A 四段：结论/形式化/论证步/边界），用于选题与审稿，不写文章版本。' },
    { title: '去 AI 味', href: '/deai', group: '写作', body: '独立能力：先用规则做 AI 味体检（框架词/黑话/对仗/宏大叙事/句长均匀/标点痕迹，加权评分），再由模型按命中清单改写；保留事实、数字与引用，主编台正文可一键生成新版本。' },
    { title: '知识节点', href: '/nodes', group: '知识', body: '已入库知识的结构化视图：Top N 枢纽气泡图（面积 ∝ claims 数）、类型筛选、搜索；节点详情含定义、claims、来源原文与相关概念。' },
    { title: '主题地图', href: '/topics', group: '知识', body: '把 118 个 topic 节点（一句话定义、收录边界、核心判断、相关概念/人物、来源）汇总成 MOC 索引：主题 claims 数、入链、文章覆盖、有料未成文与无 claims 缺口。' },
    { title: 'claims', href: '/claims', group: '知识', body: '已入库草稿的全部判断句与来源，用来抽查"知识到底沉淀了什么"、追溯每句话的原文出处。' },
    { title: '知识体检', href: '/kb-health', group: '知识', body: '知识库健康度只读检查：断链、孤立节点、无 claims/无定义节点、无来源判断、重复节点/claims、raw 来源缺失与陈旧节点。' },
    { title: '搜索', href: '/search', group: '知识', body: '站内检索知识库（节点名 / 别名 / 正文），结果可直接打开节点。' },
    { title: '异常', href: '/exceptions', group: '内容', body: '集中查看 failed / blocked / rolled_back / quarantined 等异常原文，按分组筛选，便于排查或重跑。' },
    { title: '运维中心', href: '/operations', group: '运维', body: '系统运行态：今日进度、worker 心跳/阶段、暂停与继续、立即扫描/同步/备份、待审背压配置、吞吐图、最近事件与 worker 日志；以及三个 GitHub 仓库（代码/vault/raw）的地址、HEAD、落后状态与一键更新/切换远端。' },
    { title: '用量', href: '/usage', group: '运维', body: '模型调用账本：每日调用数、输入/输出 tokens、估算成本、按 profile 汇总、cache 命中与速率/ETA。' },
    { title: '使用说明', href: '/guide', group: '帮助', body: '产出怎么用：Obsidian 阅读、检索、审核追溯、JSON API、git 回滚。' },
  ];
  const featureCards = features.map((feature) => `<div class="feature">
    <span class="chip">${esc(feature.group)}</span>
    <h3>${esc(feature.title)}</h3>
    <p>${esc(feature.body)}</p>
    <p style="margin-top:8px"><a href="${feature.href}">打开 ${esc(feature.href)} →</a></p>
  </div>`).join('');

  const steps: readonly { title: string; body: string }[] = [
    { title: '扫描原文', body: 'worker 扫描 vault/raw 的新文件，写入状态库并做 triage 分档。' },
    { title: 'AI 起草', body: '模型把原文提炼成 claims + 节点变更（JSON 契约校验、预算与重试），产出草稿。' },
    { title: '人工审核', body: '人在审核台判断。阻断级 finding 不允许通过；通过才会入库。' },
    { title: '入库 wiki', body: '应用层写 Markdown 节点并 git commit；每次入库都可回滚。' },
    { title: '主编成文', body: '主编台基于节点 claims 生成大纲与正文，写改稿指令迭代，对比版本、恢复旧版。' },
    { title: '定稿导出', body: '定稿后导出 Markdown（带引用来源清单），交给 Obsidian / 外部渠道发布。' },
  ];
  const stepCards = steps.map((step, index) => `<div class="step"><i>${String(index + 1).padStart(2, '0')}</i><b>${esc(step.title)}</b><span>${esc(step.body)}</span></div>`).join('');

  const defs: readonly { term: string; body: string }[] = [
    { term: 'raw/ 原文', body: '只读原文（剪藏 / 播客转录 / 课程笔记），按来源分类；状态机 18 态，扫描后立即分档。' },
    { term: '草稿 draft', body: '模型"提议"的产物：claims + 要 patch / new 的节点。草稿不写 wiki，必须人工通过。' },
    { term: 'claims', body: '可长期复用的判断句，每句都带 raw 来源路径；知识节点由 claims 支撑，正文引用同样回溯到 raw。' },
    { term: 'wiki 节点', body: '概念 / 主题 / 人物，Markdown + git 版本化，跨文章长期累积。' },
    { term: '文章 / 版本链', body: '主编台文章独立于 wiki；每次生成/改稿/恢复都追加一个版本（ai_initial / ai_refine / restore），只增不改。' },
    { term: '人工闸门', body: '模型只做提议：草稿必须人工通过才会入库，文章必须人工定稿才算可发布。' },
  ];
  const defRows = defs.map((item) => `<div><b>${esc(item.term)}</b><span>${esc(item.body)}</span></div>`).join('');

  const capabilityCards: readonly { title: string; body: string }[] = [
    { title: '自动化流水线', body: 'server 与 worker 双进程由 systemd 托管；worker 每 2 分钟一轮：ingest 新原文 → 取队列前 8 篇起草 → 写心跳 → 休眠。失败单篇重试，崩溃后幂等恢复。' },
    { title: '节奏控制', body: '运维页可暂停/继续 worker；待审草稿达到上限（默认 300）自动触发背压停止起草，防止审核跟不上时持续烧模型费用。' },
    { title: '模型与成本', body: 'DeepSeek（OpenAI 兼容端点）：digest 用 JSON 模式、主编台用 text 模式；路由 / 预算 / 重试 / 降级 / 缓存 / 契约校验统一在 agent-runtime；成本按 tokens 估算并记账。' },
    { title: '数据与安全', body: 'state.db 是服务端唯一写者，文章版本与事件同事务；wiki 在 vault 里由 git 版本化；API key 只在服务端环境变量；UI 目前仅本机 / SSH 隧道访问。' },
    { title: '同步与备份', body: 'sync timer 每 15 分钟 pull vault 与 raw；backup timer 每日 03:17 生成 state.db 快照；运维页可手动触发一次。' },
    { title: '工程约束', body: '依赖方向由边界检查强制；状态机/规则有穷举测试；模型调用全部可离线测（MockAgent / MockComposer）；文档按 ADR + PROGRESS 纪律维护。' },
  ];
  const capabilityCardsHtml = capabilityCards.map((card) => `<div class="feature"><h3>${esc(card.title)}</h3><p>${esc(card.body)}</p></div>`).join('');

  const workerPhaseLabel = data.workerPhase === 'drafting' ? '起草中'
    : data.workerPhase === 'ingesting' ? '扫描原文'
      : data.workerPhase === 'paused' ? '已暂停'
        : data.workerPhase === 'sleeping' ? '等待下一轮'
          : data.workerPhase;

  return layout('关于本工作台', `${nav('/about')}
  <h1>关于本工作台</h1>
  <div class="muted" style="max-width:860px">secondBrain 是一个"把原文变成可复用知识，再把知识写成文章"的个人知识工作台。
  模型负责提炼与起草，人负责审核与定稿；知识以 Markdown + git 保存，文章在主编台里按版本迭代。本页汇总所有功能与当前数据概览。</div>

  <div class="row" style="margin:18px 0">
    ${stat(n(data.stats.rawTotal), '原文总数')}
    ${stat(n(data.stats.committed), '已入库')}
    ${stat(n(data.stats.pendingDrafts), '待审草稿')}
    ${stat(n(data.stats.nodes), '知识节点')}
    ${stat(n(data.stats.claims), 'claims')}
    ${stat(n(data.stats.articles), '主编台文章')}
    ${stat(n(data.stats.calls), '今日模型调用')}
    ${stat(`$${data.stats.estimatedCost.toFixed(3)}`, '今日估算成本')}
  </div>

  <h2>工作流</h2>
  <div class="steps">${stepCards}</div>

  <h2>功能地图</h2>
  <div class="feature-grid">${featureCards}</div>

  <h2>核心概念</h2>
  <div class="card"><div class="defs">${defRows}</div></div>

  <h2>系统能力</h2>
  <div class="feature-grid">${capabilityCardsHtml}</div>

  <h2>运行信息</h2>
  <div class="card" style="padding:4px 0"><table>
    <tr><th style="width:180px">模式</th><td><span class="badge ${data.mode === 'cloud' ? 'b-ok' : ''}">${data.mode === 'cloud' ? '云端模型' : 'mock 模式'}</span>${data.mode === 'mock' ? ' <span class="muted">（未配置 MODEL_BASE_URL，使用 MockAgent / MockComposer）</span>' : ''}</td></tr>
    <tr><th>worker 阶段</th><td>${esc(workerPhaseLabel)}</td></tr>
    <tr><th>vault HEAD</th><td class="muted"><code>${esc(data.head.slice(0, 12))}</code></td></tr>
    <tr><th>数据目录</th><td class="muted">${esc(data.dataDir)}</td></tr>
    <tr><th>vault 根目录</th><td class="muted">${esc(data.vaultRoot)}</td></tr>
    <tr><th>页面生成时间</th><td class="muted">${esc(formatDateTime(data.generatedAt, { seconds: true }))}</td></tr>
  </table></div>

  <div class="muted" style="margin-top:18px">快捷入口：<a href="/">工作台</a> · <a href="/articles">素材库</a> · <a href="/audit">审核</a> · <a href="/compose">主编台</a> · <a href="/operations">运维</a> · <a href="/guide">使用说明</a></div>`);
}

const AI_FLAVOR_LEVEL_LABEL: Record<string, string> = { low: '轻度', medium: '中度', high: '重度' };
const AI_FLAVOR_LEVEL_CLASS: Record<string, string> = { low: 'b-ok', medium: 'b-warn', high: 'b-block' };
const AI_FLAVOR_CATEGORY_LABEL: Record<string, string> = {
  content: '内容', language: '语言', structure: '结构', format: '格式',
};

function aiFlavorReportCard(report: AiFlavorReport, label: string): string {
  const levelLabel = AI_FLAVOR_LEVEL_LABEL[report.level] ?? report.level;
  const levelClass = AI_FLAVOR_LEVEL_CLASS[report.level] ?? '';
  const color = report.level === 'low' ? 'var(--ok)' : report.level === 'medium' ? 'var(--warn)' : 'var(--bad)';
  const findings = report.findings.map((finding) => `<tr>
    <td>${esc(finding.label)} <span class="muted">×${finding.count}</span></td>
    <td class="muted">${esc(finding.examples.join(' / ') || '—')}</td>
    <td class="muted">${esc(finding.advice)}</td>
  </tr>`).join('') || '<tr><td colspan="3" class="muted">未命中明显 AI 味模式</td></tr>';
  const highlights = report.highlights.length > 0
    ? report.highlights.map((highlight) => `<span class="badge b-ok" style="margin:0 6px 6px 0">✓ ${esc(highlight.label)}</span>`).join('')
    : '<span class="muted">没找到明显的人味信号；改写时注意别把原文里仅有的具体信息改没了。</span>';
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div><b>${esc(label)}</b> <span class="badge ${levelClass}">${esc(levelLabel)}</span></div>
      <div style="font-size:26px;font-weight:650;font-variant-numeric:tabular-nums">${report.score}<span class="muted" style="font-size:13px"> / 100</span></div>
    </div>
    <div class="bar"><i style="width:${Math.max(2, report.score)}%;background:${color}"></i></div>
    <div class="muted" style="margin-bottom:10px">分数越高越像 AI 生成；看聚簇不看孤例。</div>
    <table><tr><th style="width:190px">命中项</th><th>原文示例</th><th style="width:220px">建议</th></tr>${findings}</table>
    <div class="muted" style="margin-top:12px">指标：${report.metrics.chars} 字 · ${report.metrics.sentences} 句 · 平均 ${report.metrics.avgSentenceChars} 字/句 · 句长变异 ${report.metrics.sentenceVariation} · 段落变异 ${report.metrics.paragraphVariation} · 用词变化 ${report.metrics.uniqueBigramRatio} · 口语密度 ${report.metrics.colloquialRatio}/百字 · 具体信息点 ${report.metrics.concreteSignalCount}</div>
    <div style="margin-top:12px">${highlights}</div>
    <div class="muted" style="margin-top:8px">${esc(report.genreNote)}</div>
  </div>`;
}

export interface DeAiPageData {
  readonly mode: string;
  readonly text: string;
  readonly title: string;
  readonly instruction: string;
  readonly style: DeAiStyle;
  readonly before: AiFlavorReport | null;
  readonly after: AiFlavorReport | null;
  readonly rewritten: string | null;
  readonly model: string | null;
  readonly cost: number | null;
  readonly error: string | null;
}

/** 去 AI 味：独立能力页。先确定性体检，再让模型按命中项改写（保留事实与引用）。 */
export function deAiPage(data: DeAiPageData): string {
  const styleOptions = ([
    ['auto', '自动（按内容判断）'],
    ['casual', '更口语 / 更像聊天'],
    ['formal', '更书面 / 接近正式发表'],
    ['opinion', '允许明确立场与判断'],
  ] as const).map(([value, label]) => `<option value="${value}"${data.style === value ? ' selected' : ''}>${label}</option>`).join('');

  const errorCard = data.error
    ? `<div class="card" style="border-color:var(--bad)"><b style="color:var(--bad)">处理失败：</b>${esc(data.error)}</div>`
    : '';

  const before = data.before ? aiFlavorReportCard(data.before, 'AI 味体检') : '';
  const after = data.after && data.rewritten
    ? `<h2>改写后</h2>${data.after ? aiFlavorReportCard(data.after, '改写后体检') : ''}
       <div class="card" style="border-color:var(--ok)">
         <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
           <b>改写结果</b>
           <span class="muted">模型：${esc(data.model ?? '—')} · 成本：${data.cost === null ? '—' : `$${data.cost.toFixed(4)}`}</span>
         </div>
         <textarea name="rewritten" rows="14" readonly style="width:100%;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:10px;font:inherit;line-height:1.8">${esc(data.rewritten)}</textarea>
         <div class="muted" style="margin-top:8px">可直接复制使用；主编台文章可在详情页点「去 AI 味」生成新版本（旧版本保留，可对比/恢复）。</div>
       </div>`
    : '';

  const rules = AI_FLAVOR_RULES.map((rule) => `<tr>
    <td>${esc(rule.label)}</td>
    <td class="muted">${esc(AI_FLAVOR_CATEGORY_LABEL[rule.category] ?? rule.category)}</td>
    <td class="muted">${rule.weight}</td>
    <td class="muted">${esc(rule.advice)}</td>
  </tr>`).join('');

  return layout('去 AI 味', `${nav('/deai')}
  <h1>去 AI 味</h1>
  <div class="muted" style="max-width:860px">独立写作工具：先用确定性规则给文本做「AI 味体检」（框架路标词、互联网黑话、否定二分与排比、宏大叙事、套话结尾、句长均匀、标点格式痕迹），再由模型**按命中清单**逐项改写。
  改写硬约束：保留事实、数字、观点归属与 <code>（来源：[[raw/...]]）</code> 引用；不编造第一人称经历，不越改越长。方法参考
  <a href="https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing" target="_blank" rel="noreferrer">Wikipedia:Signs of AI writing</a>、
  <a href="https://github.com/Warm1hear/humanizer-chinese" target="_blank" rel="noreferrer">humanizer-chinese</a> 与 CCL 2023 的量化研究。</div>

  ${errorCard}

  <h2>待处理文本</h2>
  <div class="card"><form method="post" action="/actions/deai/analyze">
    <div class="row" style="gap:10px;margin-bottom:8px">
      <input name="title" value="${esc(data.title)}" placeholder="标题（可选）" style="width:280px">
      <select name="style">${styleOptions}</select>
    </div>
    <textarea name="text" rows="10" placeholder="粘贴一段 AI 味重的文本（≥80 字）……" style="width:100%;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:10px;font:inherit;line-height:1.8">${esc(data.text)}</textarea>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn" type="submit" formaction="/actions/deai/analyze">先做体检</button>
      <button class="btn" type="submit" formaction="/actions/deai/rewrite">去 AI 味改写</button>
      <span class="muted">体检不需要模型；改写会调用模型并产生费用（${esc(data.mode === 'cloud' ? '当前为云端模型' : '当前为 mock 模式')}）。</span>
    </div>
  </form></div>

  ${before}
  ${after}

  <h2>检测项与权重</h2>
  <div class="card" style="padding:4px 0"><table><tr><th>规则</th><th>类别</th><th>权重</th><th>改写建议</th></tr>${rules}</table></div>
  <div class="muted" style="margin-top:14px">说明：这是"降 AI 味"的写作辅助，不承诺通过任何 AI 检测工具；引用、专名、被讨论的词一律不改。</div>`);
}

const QUALITY_STATUS: Record<QualityStatus, { readonly label: string; readonly cls: string }> = {
  pass: { label: '通过', cls: 'b-ok' },
  warn: { label: '注意', cls: 'b-warn' },
  fail: { label: '不通过', cls: 'b-block' },
};

function qualityRows(checks: readonly { readonly label: string; readonly status: QualityStatus; readonly detail: string }[]): string {
  return checks.map((item) => {
    const style = QUALITY_STATUS[item.status];
    return `<tr><td>${esc(item.label)}</td><td><span class="badge ${style.cls}">${style.label}</span></td><td class="muted">${esc(item.detail)}</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">暂无检查项</td></tr>';
}

function healthList(items: readonly string[]): string {
  if (items.length === 0) return '<span class="muted">无</span>';
  const visible = items.slice(0, 12).map((item) => `<span class="badge" style="margin:0 6px 6px 0">${esc(item)}</span>`).join('');
  const rest = items.slice(12);
  if (rest.length === 0) return visible;
  return `${visible}${disclosure(`查看其余 ${rest.length} 个`, rest.map((item) => `<span class="badge" style="margin:0 6px 6px 0">${esc(item)}</span>`).join(''))}`;
}

/** 知识库体检页（只读）：统计 + 问题列表 + 处理建议。 */
export function healthPage(data: KnowledgeHealthReport): string {
  const stat = (value: string, label: string): string => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  const issueTable = (rows: readonly string[], headers: readonly string[], empty: string): string => {
    if (rows.length === 0) return `<div class="empty">${esc(empty)}</div>`;
    const table = (subset: readonly string[]): string =>
      `<table><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr>${subset.join('')}</table>`;
    const rest = rows.slice(5);
    return `<div class="card" style="padding:4px 0">${table(rows.slice(0, 5))}</div>${rest.length === 0 ? '' : disclosure(`展开其余 ${rest.length} 条`, table(rest))}`;
  };
  const limitHint = (count: number): string =>
    count > KNOWLEDGE_HEALTH_ISSUE_LIMIT ? `<div class="muted">仅显示前 ${KNOWLEDGE_HEALTH_ISSUE_LIMIT} 条（共 ${count} 条）。</div>` : '';

  const brokenLinkRows = data.issues.brokenLinks.map((item) => `<tr><td>${esc(item.node)}</td><td class="muted">[[${esc(item.target)}]]</td></tr>`);
  const missingRawRows = data.issues.missingRawLinks.map((item) => `<tr><td>${esc(item.node)}</td><td class="muted">${esc(item.source)}</td></tr>`);
  const malformedRows = data.issues.claimsWithoutSource.map((item) => `<tr><td>${esc(item.node)}</td><td class="muted">${esc(item.text)}</td></tr>`);
  const duplicateClaimRows = data.issues.duplicateClaims.map((item) => `<tr><td class="muted">${esc(item.text)}</td><td>${item.nodes.map((node) => esc(node)).join('<br>')}</td></tr>`);
  const duplicateNodeRows = data.issues.duplicateNodeGroups.map((item) => `<tr><td>${item.names.map((name) => esc(name)).join(' / ')}</td><td class="muted">${item.files.map((file) => esc(file)).join('<br>')}</td></tr>`);
  const staleRows = data.issues.staleNodes.map((item) => `<tr><td>${esc(item.node)}</td><td class="muted">${esc(formatDate(item.updatedAt))}</td></tr>`);

  return layout('知识库体检', `${nav('/kb-health')}
  ${pageHead('知识库体检', `只读检查，不会修改知识库；参考 llm-wiki 的 lint、SciCrucible 的健康检查与我们的数据模型（claims / 节点 / raw 来源 / 文章）。生成于 ${esc(formatDateTime(data.generatedAt, { seconds: true }))}。`, '<a class="btn" href="/nodes">去节点页 →</a>')}

  <div class="row" style="margin:18px 0">
    ${stat(data.nodes.toLocaleString(), '知识节点')}
    ${stat(data.claims.toLocaleString(), 'claims')}
    ${stat(data.brokenLinks.toLocaleString(), '节点断链')}
    ${stat(data.missingRawLinks.toLocaleString(), 'raw 来源缺失')}
    ${stat(data.orphanNodes.toLocaleString(), '孤立节点')}
    ${stat(data.duplicateClaims.toLocaleString(), '重复 claims')}
    ${stat(data.duplicateNodeGroups.toLocaleString(), '重复节点组')}
    ${stat(data.staleNodes.toLocaleString(), '陈旧节点')}
  </div>

  <h2>链接健康</h2>
  <div class="muted">节点断链（<code>[[目标]]</code> 指向不存在的节点）：</div>
  ${issueTable(brokenLinkRows, ['节点', '目标'], '没有发现节点断链')}
  ${limitHint(data.brokenLinks)}
  <div class="muted" style="margin-top:12px">raw 来源缺失（claims/来源里引用了 raw/ 中不存在的文件）：</div>
  ${issueTable(missingRawRows, ['节点', '来源'], '没有发现 raw 来源缺失')}
  ${limitHint(data.missingRawLinks)}

  <h2>节点完整性</h2>
  <div class="row" style="align-items:flex-start;gap:16px">
    <div class="card" style="flex:1;min-width:260px"><b>无 claims 节点（${data.nodesWithoutClaims}）</b><div style="margin-top:8px">${healthList(data.issues.nodesWithoutClaims)}</div></div>
    <div class="card" style="flex:1;min-width:260px"><b>无定义节点（${data.nodesWithoutDefinition}）</b><div style="margin-top:8px">${healthList(data.issues.nodesWithoutDefinition)}</div></div>
    <div class="card" style="flex:1;min-width:260px"><b>孤立节点（${data.orphanNodes}）</b><div style="margin-top:8px">${healthList(data.issues.orphanNodes)}</div></div>
  </div>
  <div class="muted" style="margin-top:12px">重复节点（同名/别名指向多个文件）：</div>
  ${issueTable(duplicateNodeRows, ['名称', '文件'], '没有发现重复节点')}
  ${limitHint(data.duplicateNodeGroups)}
  <div class="muted" style="margin-top:12px">陈旧节点（超过 180 天未更新）：</div>
  ${issueTable(staleRows, ['节点', '最近更新'], '没有发现陈旧节点')}
  ${data.nodesMissingUpdatedAt > 0 ? `<div class="muted">另有 ${data.nodesMissingUpdatedAt} 个节点缺少 updated_at 字段。</div>` : ''}

  <h2>claims 健康</h2>
  <div class="muted">没有来源标记的判断句（应补 <code>（来源：[[raw/...]]）</code>）：</div>
  ${issueTable(malformedRows, ['节点', '文本'], '没有发现无来源判断')}
  ${limitHint(data.claimsWithoutSource)}
  <div class="muted" style="margin-top:12px">重复 claims（同一判断出现在多个节点）：</div>
  ${issueTable(duplicateClaimRows, ['判断句', '出现节点'], '没有发现重复 claims')}
  ${limitHint(data.duplicateClaims)}

  <h2>处理建议</h2>
  <div class="card">
    <ol>
      <li>先处理 <b>raw 来源缺失</b>：引用不存在意味着无法回溯，优先补文件或删除该判断。</li>
      <li>再处理 <b>节点断链</b>：补对应节点，或修正链接到正确名称/别名。</li>
      <li><b>无 claims / 无定义</b>的节点通常是导入残留，合并到相近节点或补充内容。</li>
      <li><b>重复节点/claims</b> 优先合并，避免同一判断在多处漂移。</li>
      <li>孤立节点检查是否漏挂到主题地图，或本来就该删除/归档。</li>
      <li>体检是只读建议；改动仍走审核/编辑流程，不要直接改状态库。</li>
    </ol>
  </div>`);
}

/** 主题地图（MOC）页：把 node_type=topic 的主题节点汇总成可导航索引。 */
export function topicsPage(data: TopicMapV1, options: { readonly page?: number } = {}): string {
  const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
  const nodeHref = (file: string): string => `/nodes/${encodeURIComponent(file)}`;

  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(data.topics.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(options.page ?? 1)));
  const pageRows = data.topics.slice((page - 1) * pageSize, page * pageSize);
  const topicRows = pageRows.map((row) => {
    const articleLinks = row.articles.length === 0
      ? '<span class="muted">—</span>'
      : row.articles.map((article) => `<a class="badge b-blue" href="/compose/${esc(article.id)}">${esc(truncate(article.title, 18))}</a>`).join(' ');
    return `<tr>
      <td><a href="${nodeHref(row.file)}"><b>${esc(row.name)}</b></a> <a class="muted" href="/qa?source=topic:${encodeURIComponent(row.name)}" title="生成问答链">问答</a></td>
      <td class="muted" style="max-width:420px">${esc(truncate(row.definition || '（暂无定义）', 90))}</td>
      <td>${row.claims > 0 ? `<span class="badge b-ok">${row.claims}</span>` : '<span class="badge b-warn">0</span>'}</td>
      <td class="muted">${row.relatedConcepts.length}</td>
      <td class="muted">${row.relatedPeople.length}</td>
      <td class="muted">${row.inbound}</td>
      <td>${articleLinks}</td>
      <td class="muted">${esc(formatDate(row.updatedAt))}</td>
    </tr>`;
  }).join('');

  const articleRows = data.articles.map((article) => `<tr>
    <td><a href="/compose/${esc(article.id)}">${esc(truncate(article.title, 32))}</a></td>
    <td class="muted">${esc(article.theme || '—')}</td>
    <td>${article.topics.length === 0 ? '<span class="muted">—</span>' : article.topics.map((topic) => `<span class="badge" style="margin:0 4px 4px 0">${esc(topic)}</span>`).join('')}</td>
    <td class="muted">${article.claims}</td>
    <td>${article.hasTopic ? '<span class="badge b-ok">已挂主题</span>' : '<span class="badge b-warn">未挂主题</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted">还没有文章</td></tr>';

  const unwritten = data.topics.filter((row) => row.articles.length === 0).slice(0, 24);
  const emptyTopics = data.topics.filter((row) => row.claims === 0);
  const sourceless = data.topics.filter((row) => row.sourceCount === 0);
  const chipList = (rows: readonly TopicRowV1[], max: number): string =>
    rows.length === 0
      ? '<span class="muted">无</span>'
      : rows.slice(0, max).map((row) => `<span class="badge" style="margin:0 6px 6px 0">${esc(row.name)}${row.claims > 0 ? ` · ${row.claims}` : ''}</span>`).join('') + (rows.length > max ? `<span class="muted">…等 ${rows.length} 个</span>` : '');

  return layout('主题地图', `${nav('/topics')}
  ${pageHead('主题地图', `MOC（Map of Content）：把 vault 中 node_type: topic 的主题节点汇总成索引；每个主题页负责“入口 + 边界 + 判断 + 相关概念/人物”。只做导航与缺口统计，不修改知识库。生成于 ${esc(formatDateTime(data.generatedAt, { seconds: true }))}。`, '<a class="btn" href="/kb-health">看知识体检 →</a>')}

  <form method="get" action="/topics" class="row" style="margin:14px 0;gap:8px">
    <input type="text" name="q" value="${esc(data.q)}" placeholder="筛选主题：名称 / 定义 / 相关概念" style="max-width:360px">
    <button class="btn" type="submit">筛选</button>
    ${data.q === '' ? '' : '<a class="btn" href="/topics">清除</a>'}
    <span class="muted">显示 ${data.topics.length} / ${data.totalTopics} 个主题</span>
  </form>

  <div class="row" style="margin:18px 0">
    <div class="stat"><b>${data.totals.topics}</b><span>主题节点</span></div>
    <div class="stat"><b>${data.totals.topicClaims.toLocaleString()}</b><span>主题 claims</span></div>
    <div class="stat"><b>${data.totals.withArticles}</b><span>已被文章覆盖</span></div>
    <div class="stat"><b>${data.totals.withoutArticles}</b><span>未成文主题</span></div>
    <div class="stat"><b>${data.totals.withoutClaims}</b><span>无 claims 主题</span></div>
    <div class="stat"><b>${data.totals.articlesWithoutTopics}</b><span>未挂主题文章</span></div>
  </div>

  <h2>主题清单</h2>
  <div class="card table-wrap"><table>
    <tr><th>主题</th><th>一句话定义</th><th>claims</th><th>概念</th><th>人物</th><th>入链</th><th>文章</th><th>更新</th></tr>
    ${topicRows || '<tr><td colspan="8" class="muted">没有匹配的主题</td></tr>'}
  </table></div>
  ${pager('/topics', page, pages, data.topics.length, pageSize, data.q === '' ? {} : { q: data.q })}

  <h2>文章覆盖</h2>
  <div class="muted">文章通过 nodeIds 挂到主题节点；「未挂主题」的文章说明它还没有进入任何 MOC 入口。</div>
  <div class="card" style="padding:4px 0"><table>
    <tr><th>文章</th><th>theme</th><th>主题</th><th>主题 claims</th><th>状态</th></tr>
    ${articleRows}
  </table></div>

  <h2>缺口提示</h2>
  <div class="row" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
    <div class="card" style="flex:1;min-width:280px">
      <b>有料但未成文（${data.totals.withoutArticles}）</b>
      <div class="muted" style="margin:6px 0">claims 已积累、但还没有文章引用；通常是最值得先写的主题。括号内为 claims 数。</div>
      ${chipList(unwritten, 16)}
    </div>
    <div class="card" style="flex:1;min-width:280px">
      <b>无 claims 主题（${data.totals.withoutClaims}）</b>
      <div class="muted" style="margin:6px 0">只有入口、没有判断；可能是占位或需要补内容。</div>
      ${chipList(emptyTopics, 16)}
    </div>
    <div class="card" style="flex:1;min-width:280px">
      <b>无来源主题（${sourceless.length}）</b>
      <div class="muted" style="margin:6px 0">「来源」小节为空；主题页里的判断将缺少可回溯证据。</div>
      ${chipList(sourceless, 16)}
    </div>
  </div>

  <h2>使用建议</h2>
  <div class="card">
    <ol>
      <li>先看「有料但未成文」：claims 多、文章为 0 的主题通常已经可以起稿，去主编台选这些节点即可。</li>
      <li>「未挂主题文章」：在文章页把 nodeIds 补上对应主题，地图才会显示覆盖关系。</li>
      <li>「无 claims 主题」：判断是占位（补内容）还是误建（合并/归档）。</li>
      <li>点击主题名进入主题页，那里有定义、收录边界、核心判断、相关概念/人物和来源，适合作为写作前的选题入口。</li>
      <li>本页只读；增删主题与合并节点仍走审核/编辑流程。</li>
    </ol>
  </div>`);
}

export interface QaPageData {
  readonly topics: readonly { readonly name: string; readonly claims: number }[];
  readonly articles: readonly { readonly id: string; readonly title: string }[];
  readonly result: QaChainV1 | null;
  readonly error: string | null;
  readonly selected: string;
  readonly focus: string;
  readonly count: number;
}

/** 问答链页（只读工具）：选主题/文章 → 模型生成 Q-A 链，不写文章版本。 */
export function qaPage(data: QaPageData): string {
  const topicOptions = data.topics
    .map((topic) => `<option value="topic:${esc(topic.name)}"${data.selected === `topic:${topic.name}` ? ' selected' : ''}>${esc(topic.name)}（${topic.claims} claims）</option>`)
    .join('');
  const articleOptions = data.articles
    .map((article) => `<option value="article:${esc(article.id)}"${data.selected === `article:${article.id}` ? ' selected' : ''}>${esc(article.title)}</option>`)
    .join('');
  const countOptions = [4, 6, 8, 10]
    .map((value) => `<option value="${value}"${data.count === value ? ' selected' : ''}>${value} 个问题</option>`)
    .join('');

  const errorCard = data.error
    ? `<div class="card" style="border-color:var(--bad)"><b style="color:var(--bad)">生成失败：</b>${esc(data.error)}</div>`
    : '';
  const resultCard = data.result
    ? `<h2>问答链 ·《${esc(data.result.sourceTitle)}》</h2>
  <div class="muted">来源：${data.result.sourceKind === 'topic' ? '主题节点' : '文章正文'} · ${data.result.questionCount} 个问题 · 材料 claims ${data.result.materialClaims} 个 · 模型 ${esc(data.result.provenance.model)} · 成本 $${data.result.cost.toFixed(4)} · 生成于 ${esc(formatDateTime(data.result.generatedAt))}</div>
  <div class="card" style="line-height:1.9">${renderArticleMarkdown(data.result.markdown)}</div>
  <div class="muted" style="margin-top:8px">问答链只用于选题/审稿，不会修改文章或知识库；提示词参考 ljg-qa（Q 切要害、A 四段：结论/形式化/论证步/边界）。</div>`
    : '';

  return layout('问答链', `${nav('/qa')}
  <div class="row" style="justify-content:space-between"><h1>问答链</h1><a class="btn" href="/compose">去主编台 →</a></div>
  <div class="muted" style="max-width:900px">把主题节点的 claims 或文章正文抽成 Q-A 链：问题要切要害（为什么成立、代价、边界），每个回答必须落到「结论 / 形式化 / 论证步 / 边界」四段。
  这是选题与审稿工具，不写入文章版本，也不改知识库。</div>
  ${errorCard}
  <div class="card">
    <form method="post" action="/actions/qa">
      <div class="row" style="gap:12px;flex-wrap:wrap;align-items:center">
        <label>来源 <select name="source" style="max-width:420px">
          ${topicOptions === '' ? '' : `<optgroup label="主题节点">${topicOptions}</optgroup>`}
          ${articleOptions === '' ? '' : `<optgroup label="文章正文">${articleOptions}</optgroup>`}
        </select></label>
        <label>数量 <select name="count">${countOptions}</select></label>
        <label style="flex:1;min-width:260px">聚焦（可选）<input type="text" name="focus" value="${esc(data.focus)}" placeholder="例如：只问代价和边界" style="width:100%"></label>
        <button class="btn" type="submit" onclick="return confirm('调用模型生成问答链，可能产生费用。继续？')">生成问答链</button>
      </div>
    </form>
  </div>
  ${resultCard}`);
}

/** 统一页头：标题 + 说明 + 右侧操作。 */
function pageHead(title: string, subtitle: string, actions = ''): string {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${subtitle === '' ? '' : `<div class="page-sub">${subtitle}</div>`}</div>${actions === '' ? '' : `<div class="row" style="gap:8px;align-items:center">${actions}</div>`}</div>`;
}

/** 统一分页条：保留筛选参数，只改 page；页数窗口为当前 ±2。 */
function pager(
  path: string,
  page: number,
  pages: number,
  total: number,
  pageSize: number,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  const safePages = Math.max(1, Math.trunc(pages));
  const href = (target: number): string => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (String(value) !== '') query.set(key, String(value));
    }
    query.set('page', String(target));
    return `${path}?${query.toString()}`;
  };
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(total, safePage * pageSize);
  const windowStart = Math.max(1, safePage - 2);
  const windowEnd = Math.min(safePages, safePage + 2);
  const numbers: string[] = [];
  const pageLink = (index: number): string => index === safePage
    ? `<span class="current" aria-current="page">${index}</span>`
    : `<a href="${esc(href(index))}">${index}</a>`;
  if (windowStart > 1) {
    numbers.push(pageLink(1));
    if (windowStart > 2) numbers.push('<span class="pager-gap">…</span>');
  }
  for (let index = windowStart; index <= windowEnd; index += 1) numbers.push(pageLink(index));
  if (windowEnd < safePages) {
    if (windowEnd < safePages - 1) numbers.push('<span class="pager-gap">…</span>');
    numbers.push(pageLink(safePages));
  }
  const prev = safePage > 1 ? `<a class="btn" href="${esc(href(safePage - 1))}">← 上一页</a>` : '<span class="btn" aria-disabled="true">← 上一页</span>';
  const next = safePage < safePages ? `<a class="btn" href="${esc(href(safePage + 1))}">下一页 →</a>` : '<span class="btn" aria-disabled="true">下一页 →</span>';
  return `<div class="pager">${prev}<div class="pager-pages">${numbers.join('')}</div>${next}<span class="pager-meta">第 ${from}–${to} 条 / 共 ${total.toLocaleString()} 条 · 第 ${safePage}/${safePages} 页</span></div>`;
}

/** 折叠块：用于次要列表，避免页面一次铺开。 */
function disclosure(summary: string, body: string): string {
  return `<details class="disclosure"><summary>${esc(summary)}</summary><div class="disclosure-body">${body}</div></details>`;
}
