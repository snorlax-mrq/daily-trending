// 每日榜單 — 靜態站產生器
// 讀 data/snapshots/*.json（唯一真相）→ 產出 index / d/ / board/ / archive
// 用法: bun run build.ts [--date YYYY-MM-DD] [--out dist]
import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot, formatZh, type Snapshot, type Board, type Item } from "./src/lib.ts";

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i > 0 ? join(ROOT, process.argv[i + 1]!) : join(ROOT, "dist");
})();
const SITE_NAME = "每日榜單";
const SITE_TAG = "DAILY TRENDING";
const SITE_DESC = "三個來源的每日快照：HuggingFace 模型熱度、GitHub 專案熱度、Artificial Analysis 模型評測。";

// ── 讀入所有快照 ──
const dates = listSnapshots().map((f) => f.replace(/\.json$/, ""));
if (!dates.length) {
  console.error("data/snapshots 是空的，先跑 src/collect.ts");
  process.exit(1);
}
const snaps = new Map<string, Snapshot>();
for (const d of dates) {
  const s = await readSnapshot(d);
  if (s) snaps.set(d, s);
}
const targetArg = (() => {
  const i = process.argv.indexOf("--date");
  return i > 0 ? process.argv[i + 1] : undefined;
})();
const today = targetArg ?? dates[dates.length - 1]!;

/** board key → item id → date → rank（只從有該榜的快照取） */
const history = new Map<string, Map<string, Map<string, number>>>();
for (const d of dates) {
  const s = snaps.get(d)!;
  for (const [key, board] of Object.entries(s.boards)) {
    if (!board?.items?.length) continue;
    if (!history.has(key)) history.set(key, new Map());
    const h = history.get(key)!;
    for (const it of board.items) {
      if (!h.has(it.id)) h.set(it.id, new Map());
      h.get(it.id)!.set(d, it.rank);
    }
  }
}

const boardKeys = (s: Snapshot) => Object.keys(s.boards);
const fmtNum = (n: number | null | undefined, d = 1) => (typeof n === "number" ? n.toFixed(d) : "—");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 取某 item 在 upto 之前（含）連續 N 個有紀錄日的名次序列 */
function series(boardKey: string, id: string, upto: string, n = 9): { dates: string[]; ranks: (number | null)[] } {
  const ds = dates.filter((d) => d <= upto && snaps.get(d)!.boards[boardKey]?.items?.length).slice(-n);
  const h = history.get(boardKey)?.get(id);
  return { dates: ds, ranks: ds.map((d) => h?.get(d) ?? null) };
}

/** 連續在榜天數（含當日） */
function streak(boardKey: string, id: string, upto: string): number {
  const ds = dates.filter((d) => d <= upto && snaps.get(d)!.boards[boardKey]?.items?.length);
  let n = 0;
  for (let i = ds.length - 1; i >= 0; i--) {
    if (history.get(boardKey)?.get(id)?.has(ds[i]!)) n++;
    else break;
  }
  return n;
}

/** 前一個有該榜的日期 */
function prevDate(boardKey: string, upto: string): string | null {
  const ds = dates.filter((d) => d < upto && snaps.get(d)!.boards[boardKey]?.items?.length);
  return ds.length ? ds[ds.length - 1]! : null;
}

/** 名次走勢線：y 上緣 = 第 1 名 */
function sparkline(ranks: (number | null)[], maxRank: number, w = 100, h = 26): string {
  const vals = ranks.filter((r): r is number => r !== null);
  if (!vals.length) return "";
  if (vals.length === 1) return `<span class="first-day">首日</span>`;
  const step = ranks.length > 1 ? w / (ranks.length - 1) : 0;
  const y = (r: number) => (maxRank > 1 ? ((r - 1) / (maxRank - 1)) * (h - 3) + 1.5 : h / 2);
  let d = "";
  let pen = false;
  ranks.forEach((r, i) => {
    if (r === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${(i * step).toFixed(1)} ${y(r).toFixed(1)} `;
    pen = true;
  });
  const firstIdx = ranks.findIndex((r) => r !== null);
  const lastIdx = ranks.length - 1 - [...ranks].reverse().findIndex((r) => r !== null);
  const dot = (i: number, cls: string) =>
    ranks[i] === null ? "" : `<circle class="dot ${cls}" cx="${(i * step).toFixed(1)}" cy="${y(ranks[i]!).toFixed(1)}" r="1.6"/>`;
  const single = firstIdx === lastIdx;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="名次走勢">
<path class="axis" d="M0 ${(h - 1).toFixed(1)} H${w}" vector-effect="non-scaling-stroke"/>
<path class="axis-top" d="M0 1 H${w}" vector-effect="non-scaling-stroke"/>
${single ? `<path class="line" d="M${w * 0.72} ${y(ranks[firstIdx]!).toFixed(1)} h${(w * 0.28).toFixed(1)}" vector-effect="non-scaling-stroke"/>` : `<path class="line" d="${d.trim()}" vector-effect="non-scaling-stroke"/>`}
${dot(firstIdx, "first")}${single ? "" : dot(lastIdx, "now")}
</svg>`;
}

const METRIC_LABEL: Record<string, string> = { hf: "熱度", gh: "今日 stars", aa: "II 分數" };
const ORD = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ"];
const KEY_LABEL: Record<string, string> = { hf: "1", gh: "2", aa: "3" };

// ── 導讀 ──
type Lead = { lead?: string[]; by?: string };
async function readLead(date: string): Promise<Lead | null> {
  const p = join(ROOT, "data", "headlines", `${date}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(await Bun.file(p).text()) as Lead;
}
function autoLead(d: string, s: Snapshot): string[] {
  const parts: string[] = [];
  for (const [key, b] of Object.entries(s.boards)) {
    if (!b.items.length) continue;
    const top = b.items[0]!;
    parts.push(`${b.label} 由 <span class="em">${esc(top.name)}</span> 居首`);
  }
  const totalNew = Object.entries(s.boards).reduce((acc, [key, b]) => {
    const p = prevDate(key, d);
    if (!p) return acc;
    const before = new Set(snaps.get(p)!.boards[key]!.items.map((i) => i.id));
    return acc + b.items.filter((i) => !before.has(i.id)).length;
  }, 0);
  const line = parts.join("，") + "。";
  return [totalNew ? `${line}今日三個榜單合計有新進榜 ${totalNew} 筆。` : line];
}

// ── 版面元件 ──
function themeScript(): string {
  return `<script>(function(){try{var t=localStorage.getItem('dt-theme');if(t!=='dark'&&t!=='light'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()</script>`;
}

function sizeScript(): string {
  return `<script>(function(){try{var v=localStorage.getItem('dt-size');if(v==='lg'||v==='xl'){document.documentElement.dataset.size=v}}catch(e){}})()</script>`;
}

function shell(opts: { rel: string; title: string; desc: string; body: string }): string {
  const { rel, title, desc, body } = opts;
  return `<!doctype html>
<html lang="zh-Hant-TW" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${rel}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rel}assets/site.css">
${themeScript()}
${sizeScript()}
</head>
<body>
${body}
<script>(function(){var S=['','lg','xl'],N=['標準','大','特大'],sb=document.querySelector('.size-btn');if(sb){var lab=sb.querySelector('b');function cur(){var v=document.documentElement.dataset.size||'';var i=S.indexOf(v);return i<0?0:i}function draw(){var i=cur();lab.textContent=N[i];sb.setAttribute('aria-label','目前字級：'+N[i]+'，點一下切換')}draw();sb.addEventListener('click',function(){var i=(cur()+1)%3,n=S[i];if(n){document.documentElement.dataset.size=n}else{delete document.documentElement.dataset.size}try{if(n){localStorage.setItem('dt-size',n)}else{localStorage.removeItem('dt-size')}}catch(e){}draw()})}})();(function(){var b=document.querySelector('.theme-btn');if(!b)return;b.addEventListener('click',function(){var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('dt-theme',n)}catch(e){}});var m=window.matchMedia('(prefers-color-scheme: dark)');m.addEventListener('change',function(e){try{if(localStorage.getItem('dt-theme'))return}catch(x){}document.documentElement.dataset.theme=e.matches?'dark':'light'})})()</script>
</body>
</html>`;
}

function masthead(date: string, issue: number, rel: string, opts: { home?: boolean } = {}): string {
  const [y, m, d] = date.split("-");
  return `<header class="masthead wrap">
  <div class="mast-top">
    <div class="mast-left">
      <a href="${rel}index.html" class="mast-title">${SITE_NAME}</a>
      <p class="mast-tag"><span>${SITE_TAG}</span><span class="sep">／</span><span>三個來源的每日快照</span></p>
    </div>
    <div class="mast-right">
      <p class="mast-date"><span class="num">${m}.${d}</span><small class="num">${y}</small></p>
      <p class="mast-meta">第 ${issue} 期 · ${formatZh(date).split("·")[1]?.trim() ?? ""}</p>
    </div>
  </div>
  <div class="mast-rule"></div>
  <nav class="rail">
    <span class="issue">台北時間 · 每日自動記錄</span>
    <span class="rail-sep">／</span>
    <a href="${rel}archive.html">存檔</a>
    <span class="rail-spacer"></span>
    ${opts.home === false ? `<a href="${rel}index.html">← 最新一期</a>` : ""}
    <span class="rail-tools">
      <button class="size-btn" type="button" aria-label="切換字級（標準／大／特大）">字級 <b>標準</b></button>
      <button class="theme-btn" type="button" aria-label="切換深淺色">深／淺</button>
    </span>
  </nav>
</header>`;
}

function statusBar(s: Snapshot): string {
  const t = new Date(s.generatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
  const cells = Object.entries(s.boards).map(([, b]) => {
    if (b.error) return `<span><span class="dot">✕</span>${esc(b.label)} <span class="bad">抓取失敗</span></span>`;
    return `<span><span class="dot">●</span>${esc(b.label)} <b>${b.items.length}</b> 筆</span>`;
  });
  return `<div class="status wrap">${cells.join("")}<span class="when">抓取 ${t} 台北時間</span></div>`;
}

function deltaCell(key: string, id: string, rank: number, date: string): string {
  const p = prevDate(key, date);
  if (!p) return `<td class="c-delta r flat">—</td>`;
  const before = history.get(key)?.get(id)?.get(p);
  if (before === undefined) return `<td class="c-delta r"><span class="debut">新</span></td>`;
  const d = before - rank;
  if (d > 0) return `<td class="c-delta r up"><span class="arw">▲</span>${d}</td>`;
  if (d < 0) return `<td class="c-delta r down"><span class="arw">▼</span>${-d}</td>`;
  return `<td class="c-delta r flat">＝</td>`;
}

function valueCell(it: Item): string {
  if (it.metric === null) return `<td class="c-value r">—</td>`;
  const v = it.metric >= 1000 ? Math.round(it.metric).toLocaleString("en-US") : fmtNum(it.metric, it.metric < 100 ? 1 : 0);
  return `<td class="c-value r">${v}</td>`;
}

function boardPoints(key: string, b: Board, date: string): { id: string; name: string; series: (number | null)[] }[] {
  return b.items.map((it) => ({ id: it.id, name: it.name, series: series(key, it.id, date, 9).ranks }));
}

function renderBoard(key: string, b: Board, date: string, idx: number, rel: string): string {
  const slabel = METRIC_LABEL[key] ?? "指標";
  const maxRank = Math.max(...b.items.map((i) => i.rank), 2);
  const seriesLen = Math.min(9, dates.filter((d) => d <= date).length);
  const p = prevDate(key, date);
  const notes = [...(b.notes ?? [])];
  if (!p) notes.unshift(`本站自 ${date} 起記錄 ${b.label}，今日僅有單日資料，明日起才會出現漲跌與名次走勢。`);

  const withHistory = p !== null;
  const head = `<header class="board-head">
  <span class="b-numeral">${String(idx + 1).padStart(2, "0")}</span>
  <h2 class="b-name">${esc(b.label)}</h2>
  <p class="b-question">${esc(b.question)}</p>
  <div class="b-meta"><span>${b.items.length} 筆</span><a href="${rel}board/${key}.html">時序 →</a></div>
</header>`;

  if (b.error) {
    return `<section class="board" id="${key}">${head}
<div class="caveat"><b>今日未取得資料。</b>${esc(b.error)}　其餘榜單不受影響；這是本站的抓取問題，不是該站當天真實的熱度。</div>
</section>`;
  }

  const rows = b.items
    .map((it) => {
      const sr = series(key, it.id, date, 9).ranks;
      const sp = sparkline(sr, maxRank);
      const form = `<span class="form">${sr.map((r) => `<i class="${r === null ? "miss" : r <= 3 ? "top" : ""}">${r ?? "·"}</i>`).join("")}</span>`;
      return `<tr>
  <td class="c-rank">${String(it.rank).padStart(2, "0")}</td>
  <td class="c-name"><a href="${it.url}">${esc(it.name)}</a><span class="c-kind">${esc(it.kicker)}</span></td>
  ${valueCell(it)}
  ${withHistory ? deltaCell(key, it.id, it.rank, date) : ""}
  ${withHistory ? `<td class="c-spark" data-label="近 ${seriesLen} 日名次">${sp}${form}</td>` : ""}
  <td class="c-note"><span class="clamp2">${esc(it.note)}</span></td>
</tr>`;
    })
    .join("\n");

  const uniqEvents = (b.events ?? []).filter((e, i, arr) => arr.findIndex((x) => x.kind === e.kind && x.text.slice(0, 22) === e.text.slice(0, 22)) === i);
  const events = uniqEvents.length
    ? `<div class="events"><h3>今日異動</h3><ul>${uniqEvents
        .map((e: { kind: string; text: string; url?: string }) => `<li><span class="k">${esc(e.kind)}</span><span>${e.url ? `<a href="${e.url}">${esc(e.text)}</a>` : esc(e.text)}</span></li>`)
        .join("")}</ul></div>`
    : "";

  const caveat = notes.length ? `<p class="caveat">${notes.map((n) => esc(n)).join("<br>")}</p>` : "";
  const legend = withHistory && seriesLen > 1
    ? `<p class="legend">走勢：近 ${seriesLen} 個紀錄日的名次，虛線為第 1 名、實線為第 ${maxRank} 名；只有一天紀錄的項目以單點表示。</p>`
    : "";

  return `<section class="board" id="${key}">${head}
<table class="quotes">
  <colgroup><col class="col-rank"><col class="col-name"><col class="col-value">${withHistory ? '<col class="col-delta"><col class="col-spark">' : ""}<col class="col-note"></colgroup>
  <thead><tr><th>名次</th><th>名稱</th><th class="r">${slabel}</th>${withHistory ? `<th class="r">漲跌</th><th class="th-spark">近 ${seriesLen} 日名次</th>` : ""}<th>備註</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${legend}
${caveat}
${events}
</section>`;
}

/** 漲跌家數：台灣行情版每天都會印的那一行 */
function tally(s: Snapshot, date: string): string {
  let up = 0, down = 0, flat = 0, fresh = 0, total = 0;
  for (const [key, b] of Object.entries(s.boards)) {
    const p = prevDate(key, date);
    for (const it of b.items) {
      total++;
      const before = p ? history.get(key)?.get(it.id)?.get(p) : undefined;
      if (before === undefined) fresh++;
      else if (before > it.rank) up++;
      else if (before < it.rank) down++;
      else flat++;
    }
  }
  const cells: string[] = [];
  if (up) cells.push(`<span class="t up">上漲 <b>${up}</b></span>`);
  if (down) cells.push(`<span class="t down">下跌 <b>${down}</b></span>`);
  if (flat) cells.push(`<span class="t">平盤 <b>${flat}</b></span>`);
  if (fresh) cells.push(`<span class="t">新進 <b>${fresh}</b></span>`);
  return `<div class="tally wrap"><span class="micro">今日合計 ${total} 筆</span>${cells.join('<span class="tdot">·</span>')}</div>`;
}

function leadBlock(lead: Lead | null, date: string): string {
  const paras = lead?.lead?.length ? lead.lead : [];
  if (!paras.length) return "";
  return `<section class="lead wrap">
  <div class="lead-kicker"><span class="tag">導讀</span><span class="attr">編輯</span></div>
  <div class="lead-body">${paras.map((p) => `<p>${p}</p>`).join("")}</div>
</section>`;
}

function footBlock(date: string, rel: string): string {
  return `<footer class="foot wrap">
  <div>
    <h4>資料來源</h4>
    <ul>
      <li><a href="https://huggingface.co/models?sort=trending">HuggingFace</a> · 官方 trendingScore</li>
      <li><a href="https://github.com/trending">GitHub Trending</a> · HTML 解析，非官方 API</li>
      <li><a href="https://artificialanalysis.ai/leaderboards/models">Artificial Analysis</a> · Intelligence Index</li>
    </ul>
  </div>
  <div>
    <h4>怎麼讀</h4>
    <p>名次為各榜單原始排序。漲跌比較前一個有紀錄的日期；走勢為近九日名次，線在上方代表名次較好。「新」表示本站紀錄中首次出現，不代表該項目當天才發布。</p>
  </div>
  <div>
    <h4>存檔</h4>
    <p><a href="${rel}d/${date}.html">本期永久連結</a>　<a href="${rel}archive.html">全部期數</a></p>
    <p>每日台北時間自動更新；同一天的網址永遠代表同一天的紀錄。</p>
  </div>
</footer>`;
}

// ── 產生每日頁 ──
mkdirSync(join(OUT, "d"), { recursive: true });
mkdirSync(join(OUT, "board"), { recursive: true });

for (const [i, date] of dates.entries()) {
  const s = snaps.get(date)!;
  const rel = "../";
  const lead = await readLead(date);
  const leadData: Lead = lead ?? { lead: autoLead(date, s) };
  const body = `<div class="wrap">
${masthead(date, i + 1, rel, { home: date === today })}
${statusBar(s)}
${tally(s, date)}
${leadBlock(leadData, date)}
${boardKeys(s).map((k, idx) => renderBoard(k, s.boards[k]!, date, idx, rel)).join("\n")}
${footBlock(date, rel)}
</div>`;
  const title = `${SITE_NAME} ${date.replace(/-/g, ".")} · HuggingFace／GitHub／Artificial Analysis`;
  await Bun.write(join(OUT, "d", `${date}.html`), shell({ rel, title, desc: `${formatZh(date)}。${SITE_DESC}`, body }));
  // 最新一期 = index.html（用相對路徑 ./ 而非 ../）
  if (date === today) {
    const homeBody = body.replaceAll('href="../', 'href="').replaceAll('src="../', 'src="');
    await Bun.write(join(OUT, "index.html"), shell({ rel: "", title, desc: SITE_DESC, body: homeBody }));
  }
}

// ── 存檔頁 ──
const archiveRows = [...dates]
  .reverse()
  .map((date, i) => {
    const s = snaps.get(date)!;
    const keys = boardKeys(s).filter((k) => s.boards[k]!.items.length);
    const leads = keys
      .map((k) => `<span class="a-board"><b>${k.toUpperCase().slice(0, 2)}</b> ${esc(s.boards[k]!.items[0]!.name)}</span>`)
      .join("");
    const fresh = keys.reduce((acc, k) => {
      const p = prevDate(k, date);
      if (!p) return acc;
      const before = new Set(snaps.get(p)!.boards[k]!.items.map((x) => x.id));
      return acc + s.boards[k]!.items.filter((x) => !before.has(x.id)).length;
    }, 0);
    const issue = dates.length - i;
    return `<li><a href="d/${date}.html">
    <span class="d">${date.replace(/-/g, ".")}</span>
    <span class="s"><span class="a-leads">${leads}</span></span>
    <span class="n">${fresh ? `新進 ${fresh} · ` : ""}第 ${issue} 期</span></a></li>`;
  })
  .join("\n");

const archiveBody = `<div class="wrap">
${masthead(today, dates.length, "", { home: true })}
<div class="page-head">
  <h1>存檔</h1>
  <p>每天一份快照，共 ${dates.length} 期。每一期的網址固定，內容不隨時間改變。</p>
</div>
<ul class="days">
${archiveRows}
</ul>
${footBlock(today, "")}
</div>`;
await Bun.write(join(OUT, "archive.html"), shell({ rel: "", title: `存檔 · ${SITE_NAME}`, desc: `${SITE_DESC} 共 ${dates.length} 期存檔。`, body: archiveBody }));

// ── 時序頁 ──
const allKeys = [...new Set(dates.flatMap((d) => boardKeys(snaps.get(d)!)))];
for (const key of allKeys) {
  const boardDates = dates.filter((d) => snaps.get(d)!.boards[key]?.items?.length);
  const lastDate = boardDates[boardDates.length - 1]!;
  const sample = snaps.get(lastDate)!.boards[key]!;
  const h = history.get(key) ?? new Map<string, Map<string, number>>();
  const entries = [...h.entries()]
    .map(([id, m]) => {
      const ds = [...m.keys()].sort();
      const best = Math.min(...m.values());
      const latest = ds[ds.length - 1]!;
      return { id, best, days: ds.length, first: ds[0]!, latest, latestRank: m.get(latest)!, streakNow: streak(key, id, lastDate) };
    })
    .sort((a, b) => b.days - a.days || a.best - b.best);

  const strip = (id: string) => {
    const rr = series(key, id, lastDate, 9).ranks;
    return `<div class="rank-strip">${rr
      .map((r) => `<span class="${r === null ? "miss" : r <= 3 ? "top" : ""}">${r ?? "·"}</span>`)
      .join("")}</div>`;
  };

  const rows = entries
    .map(
      (e) => `<tr>
  <td class="c-name"><a href="https://${key === "hf" ? "huggingface.co/" : key === "gh" ? "github.com/" : "artificialanalysis.ai/models/"}${e.id}">${esc(e.id)}</a></td>
  <td class="c-value r">${e.best}</td>
  <td class="c-value r">${e.days}</td>
  <td class="c-value r">${e.latestRank}</td>
  <td class="c-value r">${e.first.replace(/-/g, "/")}</td>
  <td>${strip(e.id)}</td>
</tr>`,
    )
    .join("\n");

  const body = `<div class="wrap">
${masthead(today, dates.length, "../", { home: false })}
<div class="page-head">
  <h1>${esc(sample.label)} · 時序</h1>
  <p>${esc(sample.question)}。本站自 ${boardDates[0]!.replace(/-/g, "/")} 起記錄，累計 ${boardDates.length} 天、${entries.length} 個曾上榜的項目。名次序列由左至右為最近九天，紅色代表前三名。</p>
</div>
<table class="quotes quotes-series">
  <colgroup><col class="col-name"><col class="col-value"><col class="col-value"><col class="col-value"><col class="col-value"><col class="col-spark"></colgroup>
  <thead><tr><th>名稱</th><th class="r">最佳</th><th class="r">在榜天數</th><th class="r">最近名次</th><th class="r">首次記錄</th><th class="th-spark">近九日名次</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${footBlock(today, "../")}
</div>`;
  await Bun.write(join(OUT, "board", `${key}.html`), shell({ rel: "../", title: `${sample.label} 時序 · ${SITE_NAME}`, desc: `${sample.label}：${sample.question}。`, body }));
}

// ── favicon ──
mkdirSync(join(OUT, "assets"), { recursive: true });
await Bun.write(
  join(OUT, "assets", "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#1A1C19"/><rect x="5" y="7" width="22" height="2" fill="#E5E5DC"/><rect x="5" y="13" width="22" height="1" fill="#E5E5DC"/><rect x="5" y="18" width="22" height="1" fill="#E5E5DC"/><rect x="5" y="23" width="22" height="1" fill="#E5E5DC"/><rect x="20" y="20" width="7" height="7" fill="#A6210F"/></svg>`,
);

// 複製靜態資產
for (const f of ["site.css"]) {
  await Bun.write(join(OUT, "assets", f), Bun.file(join(ROOT, "assets", f)));
}
mkdirSync(join(OUT, "assets", "fonts"), { recursive: true });
for (const f of readdirSync(join(ROOT, "assets", "fonts"))) {
  await Bun.write(join(OUT, "assets", "fonts", f), Bun.file(join(ROOT, "assets", "fonts", f)));
}

await Bun.write(join(OUT, ".nojekyll"), "");
console.log(`🏗  產生 ${dates.length} 期 → ${OUT}`);
console.log(`   index.html · archive.html · ${allKeys.length} 個時序頁`);