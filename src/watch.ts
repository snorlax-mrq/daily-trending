// 自行量測 star 增量：watchlist → 每日總星數 → 差分 → 增速榜與健檢
//
// 為什麼不用 trending 的「stars today」：那是滾動窗估計值（同一天會下降）、與榜單排序無關
// （實測 Spearman −0.07 ~ −0.68），而且每天只收 15 席。詳見 reports/star-increment-vs-trending.md。
//
// 用法：
//   bun run src/watch.ts                  # 每日：更新 watchlist → 抓總星數 → 算增速（預設）
//   bun run src/watch.ts --date 2026-11-03
//   bun run src/watch.ts --backfill       # 從既有 snapshots 的 stats.stars 回填歷史
//   bun run src/watch.ts --discover       # Search API 找 7 日內新秀，加進 watchlist
//   bun run src/watch.ts --seed           # 一次性：建立大型專案基底宇宙
//   bun run src/watch.ts --report         # 只印報告（不抓網路）
//   --offline / --dry-run  不寫檔
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot, today, type Snapshot } from "./lib.ts";

const DATA = join(ROOT, "data");
const WATCH_PATH = join(DATA, "watchlist.json");
const HIST_PATH = join(DATA, "star-history.jsonl");
const GROWTH_DIR = join(DATA, "growth");

const TOKEN = process.env.GITHUB_TOKEN ?? "";
const KEEP_DAYS = 30; // 最後一次出現後保留幾天
const MIN_STARS_MEASURED = 300; // 進「已測增速」榜的最低星數，避免 +1 星雜訊
const MIN_STARS_NASCENT = 1000; // 新秀榜門檻：300-600 星的小專案除以 3 天也是「100/日」，但那不是訊號
const TOP_N = 12;
const NASCENT_MAX_AGE = 45; // 幾天內算「新秀」
const MIN_FORKS = 2; // 0–1 個 fork 的高星數專案多半是刷 SEO 的空殼，不進榜
/** 「穩定增速」門檻：實際經過 ≥2 日才算，避免一次跨夜的樣本被當成日均 */
const MIN_SPAN_DAYS = 2;
const CONCURRENCY = 8;

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const argOf = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

type Src = "trending" | "search" | "seed";
type WatchEntry = { first: string; last: string; src: Src; created?: string | null };
type Watch = { updated: string; repos: Record<string, WatchEntry> };
type HistRow = { d: string; id: string; s: number; f?: number; t?: string };

// ── 日期 ──────────────────────────────────────────
const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const daysBetween = (a: string, b: string) => Math.round(dayNum(a) - dayNum(b));
const shift = (d: string, n: number) => new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10);

const date = argOf("--date") ?? today();
const dry = flag("--dry-run");
const offline = flag("--offline");

// ── 檔案 ──────────────────────────────────────────
async function loadWatch(): Promise<Watch> {
  if (!existsSync(WATCH_PATH)) return { updated: date, repos: {} };
  const raw = JSON.parse(await Bun.file(WATCH_PATH).text()) as Watch;
  raw.repos ??= {};
  return raw;
}

async function saveWatch(w: Watch, forDate = date): Promise<void> {
  w.updated = forDate;
  const repos = Object.fromEntries(Object.entries(w.repos).sort(([a], [b]) => a.localeCompare(b)));
  await Bun.write(WATCH_PATH, JSON.stringify({ updated: w.updated, repos }, null, 1) + "\n");
}

async function loadHist(): Promise<HistRow[]> {
  if (!existsSync(HIST_PATH)) return [];
  const txt = await Bun.file(HIST_PATH).text();
  const out: HistRow[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HistRow;
      if (r.d && r.id && typeof r.s === "number") out.push(r);
    } catch {
      /* 壞行跳過 */
    }
  }
  return out;
}

/** 同 (d,id) 後寫蓋前寫；輸出依日期、id 排序 */
async function saveHist(rows: HistRow[]): Promise<void> {
  const map = new Map<string, HistRow>();
  for (const r of rows) map.set(`${r.d}\u0000${r.id}`, r);
  const all = [...map.values()].sort((a, b) => (a.d === b.d ? a.id.localeCompare(b.id) : a.d.localeCompare(b.d)));
  await Bun.write(HIST_PATH, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// ── GitHub API ────────────────────────────────────
let remaining = Number.MAX_SAFE_INTEGER;

async function api<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "daily-trending-watch",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    // 只追蹤 core 額度；search 的額度是另一條（30/min），混在一起會誤判
    const left = res.headers.get("x-ratelimit-remaining");
    if (left !== null && !path.startsWith("/search")) remaining = Math.min(remaining, Number(left));
    if (res.ok) return (await res.json()) as T;
    if (process.env.WATCH_DEBUG) console.error(`  ${res.status} ${path}`);
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      await Bun.sleep(1200 * (attempt + 1));
      continue;
    }
    return null; // 404 等：直接放棄這一筆
  }
  return null;
}

type Repo = { full_name: string; stargazers_count: number; forks_count: number; created_at: string; pushed_at: string; archived: boolean; description: string | null; language: string | null; topics?: string[] };

/** 有上限的並行 map */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ── watchlist 維護 ────────────────────────────────
/** 把某日快照的 GitHub 榜全部納入 watchlist */
function addFromSnapshot(w: Watch, snap: Snapshot, d: string): number {
  let added = 0;
  for (const it of snap.boards?.gh?.items ?? []) {
    const e = w.repos[it.id];
    if (e) {
      if (d > e.last) e.last = d;
      continue;
    }
    w.repos[it.id] = { first: d, last: d, src: "trending" };
    added++;
  }
  return added;
}

function pruneWatch(w: Watch, forDate = date): number {
  const cutoff = shift(forDate, -KEEP_DAYS);
  let removed = 0;
  for (const [id, e] of Object.entries(w.repos)) {
    if (e.last < cutoff) {
      delete w.repos[id];
      removed++;
    }
  }
  return removed;
}

/** Search API 這次真正新增的數量（found 會含已在 watchlist 的） */
export let discoveredNew = 0;

/** Search API：7 日內建立、已破 MIN_STARS 的新 repo（這就是 trending 完全收不到的一群） */
async function discover(w: Watch, forDate = date, minStars = 300, days = 7): Promise<string[]> {
  const since = shift(forDate, -days);
  const found: string[] = [];
  let added = 0;
  for (const page of [1, 2, 3]) {
    const r = await api<{ items: Repo[]; total_count: number }>(
      `/search/repositories?q=${encodeURIComponent(`created:>${since} stars:>=${minStars}`)}&sort=stars&order=desc&per_page=50&page=${page}`,
    );
    if (!r?.items?.length) break;
    for (const it of r.items) {
      const id = it.full_name;
      if (!found.includes(id)) found.push(id);
      const e = w.repos[id];
      if (e) {
        e.created = e.created ?? it.created_at;
        continue;
      }
      w.repos[id] = { first: forDate, last: forDate, src: "search", created: it.created_at };
      added++;
    }
    if (r.items.length < 50) break;
  }
  discoveredNew = added;
  return found;
}

/** 一次性：大型專案的基底宇宙，讓「老 repo 的增速」也有得比 */
async function seed(w: Watch, forDate = date, pages = 3): Promise<number> {
  let added = 0;
  for (const page of [1, 2, 3].slice(0, pages)) {
    const r = await api<{ items: Repo[] }>(`/search/repositories?q=${encodeURIComponent("stars:>=20000")}&sort=stars&order=desc&per_page=100&page=${page}`);
    if (!r?.items?.length) break;
    for (const it of r.items) {
      if (w.repos[it.full_name]) continue;
      w.repos[it.full_name] = { first: forDate, last: forDate, src: "seed", created: it.created_at };
      added++;
    }
  }
  return added;
}

// ── 抓總星數 ──────────────────────────────────────
async function sync(w: Watch, forDate = date): Promise<{ ok: number; fail: string[]; rows: HistRow[] }> {
  const ids = Object.keys(w.repos);
  const fail: string[] = [];
  let ok = 0;
  const rows = await pool(ids, CONCURRENCY, async (id) => {
    if (remaining < 10) {
      fail.push(id);
      return null;
    }
    const r = await api<Repo>(`/repos/${id}`);
    if (!r) {
      fail.push(id);
      return null;
    }
    ok++;
    const e = w.repos[id]!;
    e.created = e.created ?? r.created_at;
    if (forDate > e.last) e.last = forDate;
    return { d: forDate, id, s: r.stargazers_count, f: r.forks_count } satisfies HistRow;
  });
  return { ok, fail, rows: rows.filter((x): x is HistRow => !!x) };
}

// ── 增速計算 ──────────────────────────────────────
export type GrowthItem = {
  id: string;
  stars: number;
  forks?: number;
  /** 窗口內增量（預設 7 日） */
  delta: number | null;
  /** 每日均速 */
  perDay: number | null;
  /** 實際樣本天數（可能小於 7） */
  span: number;
  trending: boolean;
  created: string | null;
  ageDays: number | null;
  note: string;
};
export type Growth = {
  date: string;
  /** 產生這份報告的時間（僅供顯示） */
  at: string;
  /** 這一天實際量測總星數的時間（算經過時間用，不可用 at 代替） */
  measuredAt: string;
  window: { from: string; to: string; days: number };
  /** 實際最長樣本天數（回填起點不足 7 日時會小於 window.days） */
  spanDays: number;
  /** 穩定增速：實際經過 ≥2 日 */
  measured: GrowthItem[];
  /** 只有 1 次跨夜樣本（<2 日），單獨一區免得和穩定組比大小 */
  recent: GrowthItem[];
  /** 樣本不足、以「總星數 ÷ 年齡」估的新秀 */
  nascent: GrowthItem[];
  /** 健檢：真的在長、但不在今日 trending */
  alerts: { id: string; kind: "measured" | "recent" | "nascent"; perDay: number; delta: number | null; stars: number; span: number }[];
  notes: string[];
  watching: number;
};

/**
 * 增量一律用「實際經過時間」算，不用日期差。
 * 快照有時在 00:00Z 抓、有時在 06:30Z 抓，日期差 1 天、實際只過 0.76 天，
 * 用日期差會把日均高估 30% 以上。
 */
function elapsedDays(a?: string, b?: string, fallback = 0): number {
  if (!a || !b) return fallback;
  const ms = Date.parse(b) - Date.parse(a);
  return ms > 0 ? ms / 86_400_000 : fallback;
}

function buildGrowth(dateStr: string, w: Watch, hist: HistRow[], trendingIds: Set<string>, measuredAt: string): Growth {
  const byRepo = new Map<string, HistRow[]>();
  for (const r of hist) {
    if (r.d > dateStr) continue;
    if (!byRepo.has(r.id)) byRepo.set(r.id, []);
    byRepo.get(r.id)!.push(r);
  }
  const measured: GrowthItem[] = [];
  const recent: GrowthItem[] = [];
  const nascent: GrowthItem[] = [];

  for (const [id, series] of byRepo) {
    series.sort((a, b) => a.d.localeCompare(b.d));
    const last = series[series.length - 1]!;
    if (last.d !== dateStr) continue; // 今天沒抓到就不列入（不拿舊值冒充）
    const e = w.repos[id];
    if (e && dateStr > e.last) e.last = dateStr;

    const ageDays = e?.created ? Math.max(1, daysBetween(dateStr, e.created.slice(0, 10))) : null;
    const inWindow = series.filter((r) => daysBetween(dateStr, r.d) <= 7);
    const first = inWindow[0]!;
    const span = elapsedDays(first.t ?? first.d, last.t ?? last.d, daysBetween(dateStr, first.d));
    const delta = span > 0 ? last.s - first.s : null;
    const perDay = span > 0 ? Math.round((delta! / span) * 10) / 10 : null;
    if ((last.f ?? 0) < MIN_FORKS) continue; // 過濾刷星空殼（0 fork 卻數百星）
    const base = {
      id,
      stars: last.s,
      forks: last.f,
      delta,
      perDay,
      span: Math.round(span * 10) / 10,
      trending: trendingIds.has(id),
      created: e?.created ?? null,
      ageDays,
    };

    if (span > 0) {
      if (last.s < MIN_STARS_MEASURED) continue;
      const item: GrowthItem = { ...base, note: `實測 ${base.span} 日（起 ${first.d.replace(/-/g, "/")}）` };
      if (span >= MIN_SPAN_DAYS) measured.push(item);
      else recent.push(item); // 只有一次跨夜樣本：數字是「這段時間的均速」，不是日均
    } else if (ageDays !== null && ageDays <= NASCENT_MAX_AGE && last.s >= MIN_STARS_NASCENT) {
      const rate = Math.round((last.s / ageDays) * 10) / 10;
      nascent.push({ ...base, perDay: rate, note: `建立 ${ageDays} 天，尚無歷史可差分，以總星數÷年齡估` });
    }
  }

  const byRate = (a: GrowthItem, b: GrowthItem) => (b.perDay ?? 0) - (a.perDay ?? 0) || b.stars - a.stars;
  measured.sort(byRate);
  recent.sort(byRate);
  nascent.sort(byRate);

  // 健檢：三種形狀各自取前段班，再排除今天已經在 trending 的
  const picks: { kind: "measured" | "recent" | "nascent"; list: GrowthItem[] }[] = [
    { kind: "measured", list: measured.slice(0, 10) },
    { kind: "recent", list: recent.filter((x) => (x.delta ?? 0) >= 500).slice(0, 5) },
    { kind: "nascent", list: nascent.filter((x) => x.stars >= 1000).slice(0, 5) },
  ];
  const seen = new Set<string>();
  const alerts: Growth["alerts"] = [];
  for (const { kind, list } of picks) {
    for (const x of list) {
      if (x.trending || seen.has(x.id)) continue;
      seen.add(x.id);
      alerts.push({ id: x.id, kind, perDay: x.perDay ?? 0, delta: x.delta, stars: x.stars, span: x.span });
    }
  }

  return {
    date: dateStr,
    at: new Date().toISOString(),
    measuredAt,
    window: { from: shift(dateStr, -7), to: dateStr, days: 7 },
    spanDays: measured.reduce((m, x) => Math.max(m, x.span), 0),
    measured: measured.slice(0, TOP_N),
    recent: recent.slice(0, TOP_N),
    nascent: nascent.slice(0, TOP_N),
    alerts,
    notes: [
      `本站自己量：對 watchlist 內每個專案每天抓一次總星數，以「實際經過時間」的存量差算增量，不採用 GitHub Trending 顯示的 stars today。`,
      `今日追蹤 ${Object.keys(w.repos).length} 個；${measured.length} 個有 ${MIN_SPAN_DAYS} 日以上實測（穩定增速）、${recent.length} 個只有 1 次跨夜樣本、${nascent.length} 個尚無歷史（以總星數 ÷ 建立天數估）。三個分區的數字不能互相比大小。`,
      `Trending 每天只收 11–17 席，且名次與 stars today 無關（實測 Spearman −0.07 ~ −0.68）；「不在 trending」不代表沒在長。`,
    ],
    watching: Object.keys(w.repos).length,
  };
}

// ── 主流程（collect.ts 也會呼叫，所以包成函式）────────
/** 每個觀測日的實際量測時間：growth 的 measuredAt 優先，其次快照的 generatedAt（絕不用報告產生時間） */
async function buildTimes(): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const f of listSnapshots()) {
    const d = f.replace(/\.json$/, "");
    const s = await readSnapshot(d);
    if (s?.generatedAt) times.set(d, Date.parse(s.generatedAt));
  }
  const gp = join(GROWTH_DIR);
  if (existsSync(gp)) {
    for (const f of readdirSync(gp)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      try {
        const g = JSON.parse(await Bun.file(join(gp, f)).text()) as { measuredAt?: string };
        if (g.measuredAt) times.set(m[1]!, Date.parse(g.measuredAt));
      } catch {
        /* 壞檔跳過 */
      }
    }
  }
  return times;
}

export type WatchOpts = {
  date?: string;
  mode?: "sync" | "backfill" | "discover" | "report" | "rebuild";
  seed?: boolean;
  dryRun?: boolean;
  offline?: boolean;
  quiet?: boolean;
};

export async function runWatch(opts: WatchOpts = {}): Promise<{ growth: Growth; ok: number; fail: number; added: number }> {
  const runDate = opts.date ?? date;
  const mode =
    opts.mode ??
    (flag("--backfill") ? "backfill" : flag("--report") ? "report" : flag("--rebuild") ? "rebuild" : flag("--discover") ? "discover" : "sync");
  const isDry = opts.dryRun || dry;
  const isOffline = opts.offline || offline;
  const quiet = opts.quiet ?? false;
  const log = (s: string) => {
    if (!quiet) console.log(s);
  };

  const w = await loadWatch();

  // 1) watchlist：近 30 天所有上過榜的專案
  for (const f of listSnapshots()) {
    const d = f.replace(/\.json$/, "");
    if (daysBetween(runDate, d) > KEEP_DAYS) continue;
    const s = await readSnapshot(d);
    if (s) addFromSnapshot(w, s, d);
  }
  const pruned = pruneWatch(w, runDate);

  // 2) 今日 trending 名單（健檢要用）
  const todaySnap = await readSnapshot(runDate);
  const trendingIds = new Set((todaySnap?.boards?.gh?.items ?? []).map((i) => i.id));

  let hist = await loadHist();
  let discovered: string[] = [];
  let seeded = 0;

  // 校正每筆的「實際抓取時間」t。
  // 規則：值與當日快照相同 → 該筆來自快照（時間＝快照 generatedAt）；
  //       否則來自當天的直接 API 讀取（時間＝當日 growth.at）。
  // 沒有 t 的舊資料就是靠這條規則補出來的，之後 sync 會自己寫入精確時間。
  const times = await buildTimes();
  const snapTimes = new Map<string, number>();
  const snapStars = new Map<string, Map<string, number>>();
  for (const f of listSnapshots()) {
    const d = f.replace(/\.json$/, "");
    const s = await readSnapshot(d);
    if (!s) continue;
    if (s.generatedAt) snapTimes.set(d, Date.parse(s.generatedAt));
    const m = new Map<string, number>();
    for (const it of s.boards?.gh?.items ?? []) {
      const v = Number(it.stats?.stars ?? 0);
      if (v) m.set(it.id, v);
    }
    snapStars.set(d, m);
  }
  let fixed = 0;
  for (const r of hist) {
    if (r.t) continue; // 已有實測時間就不動（history 是 t 的唯一真相）
    const snapVal = snapStars.get(r.d)?.get(r.id);
    const want = snapVal !== undefined && snapVal === r.s ? snapTimes.get(r.d) : times.get(r.d);
    if (!want) continue;
    r.t = new Date(want).toISOString();
    fixed++;
  }
  if (fixed && !isDry) {
    await saveHist(hist);
    hist = await loadHist();
    log(`🕒 校正 ${fixed} 筆抓取時間（每日均值改用實際經過時間計算）`);
  }

  if (mode === "backfill") {
    const before = hist.length;
    for (const f of listSnapshots()) {
      const d = f.replace(/\.json$/, "");
      const s = await readSnapshot(d);
      if (!s) continue;
      const at = snapTimes.get(d) ?? times.get(d);
      for (const it of s.boards?.gh?.items ?? []) {
        const stars = Number(it.stats?.stars ?? 0);
        if (!stars) continue;
        hist.push({ d, id: it.id, s: stars, f: Number(it.stats?.forks ?? 0) || undefined, t: at ? new Date(at).toISOString() : undefined });
      }
    }
    if (!isDry) await saveHist(hist);
    hist = await loadHist();
    log(`↩︎ 回填 ${hist.length - before} 筆歷史（來自 ${listSnapshots().length} 份快照）`);
  } else if (mode === "rebuild") {
    log(`🛠  重算增速（不連網，依既有 ${hist.length} 筆歷史）`);
  } else if (mode !== "report" && !isOffline) {
    if (opts.seed ?? flag("--seed")) seeded = await seed(w, runDate);
    discovered = await discover(w, runDate);
    if (discovered.length) log(`🔎 找到 ${discovered.length} 個 7 日內 ≥300★ 的新 repo（新增 ${discoveredNew} 個）`);
  }

  // 3) 抓當日總星數
  let ok = 0;
  let fail = 0;
  if (mode !== "report" && mode !== "rebuild" && !isOffline) {
    const res = await sync(w, runDate);
    hist.push(...res.rows);
    ok = res.ok;
    fail = res.fail.length;
    if (!isDry) {
      await saveHist(hist);
      hist = await loadHist();
    }
    log(`📈 抓取 ${ok} 筆總星數${fail ? `，失敗 ${fail} 筆` : ""}${TOKEN ? "" : "（未帶 GITHUB_TOKEN，額度很低）"}`);
  }

  // 4) 算增速 + 健檢
  // 這一天的量測時間＝今天 sync 的完成時間；回填／重建時用當日快照時間
  const measuredAt = ok > 0 ? new Date().toISOString() : (snapTimes.get(runDate) ? new Date(snapTimes.get(runDate)!).toISOString() : new Date().toISOString());
  const growth = buildGrowth(runDate, w, hist, trendingIds, measuredAt);
  // 回填／重建模式：每一份快照日的增速也重算一次（時序頁才有歷史）
  if ((mode === "backfill" || mode === "rebuild") && !isDry) {
    mkdirSync(GROWTH_DIR, { recursive: true });
    let emitted = 0;
    for (const f of listSnapshots()) {
      const d = f.replace(/\.json$/, "");
      if (d >= runDate) continue;
      const snap = await readSnapshot(d);
      if (!snap) continue;
      const ids = new Set((snap.boards?.gh?.items ?? []).map((i) => i.id));
      let at = snapTimes.get(d);
      const gp = join(GROWTH_DIR, `${d}.json`);
      if (existsSync(gp)) {
        try {
          const prev = JSON.parse(await Bun.file(gp).text()) as { measuredAt?: string };
          if (prev.measuredAt) at = Date.parse(prev.measuredAt);
        } catch {
          /* 壞檔就用快照時間 */
        }
      }
      const g = buildGrowth(d, w, hist, ids, at ? new Date(at).toISOString() : new Date().toISOString());
      if (!g.measured.length && !g.recent.length && !g.nascent.length) continue;
      await Bun.write(join(GROWTH_DIR, `${d}.json`), JSON.stringify(g, null, 1) + "\n");
      emitted++;
    }
    log(`🗂  重算 ${emitted} 天的增速檔`);
  }
  if (!isDry && mode !== "report") {
    mkdirSync(GROWTH_DIR, { recursive: true });
    await Bun.write(join(GROWTH_DIR, `${runDate}.json`), JSON.stringify(growth, null, 1) + "\n");
    await saveWatch(w, runDate);
  }

  if (quiet) return { growth, ok, fail, added: discovered.length };

  // 5) 報告
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const fmt = (n: number) => n.toLocaleString("en-US");
  console.log(`\n=== ${runDate} 增速（自行實測，非 trending 數字）===`);
  const block = (title: string, list: GrowthItem[], limit: number) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    list.slice(0, limit).forEach((x, i) => {
      const span = `實測 ${x.span} 日`;
      console.log(
        `${pad(i + 1, 2)} ${pad(x.id.length > 40 ? x.id.slice(0, 39) + "…" : x.id, 40)} ${pad(fmt(x.stars), 8)} ${pad(x.delta === null ? "—" : `+${fmt(x.delta)}`, 9)} ${pad(x.perDay === null ? "—" : fmt(x.perDay), 9)} ${pad(span, 10)} ${x.trending ? "✓ trending" : "—"}`,
      );
    });
  };
  if (!growth.measured.length && !growth.recent.length && !growth.nascent.length) {
    console.log("（還沒有資料，先跑 --backfill 或等明天）");
  }
  block("穩定增速（≥2 日實測）", growth.measured, 12);
  block("單次跨夜樣本（<2 日，數字別和上表比）", growth.recent, 8);
  if (growth.nascent.length) {
    console.log(`\n新秀（樣本不足，總星數 ÷ 建立天數）`);
    growth.nascent.slice(0, 10).forEach((x, i) => {
      console.log(`${pad(i + 1, 2)} ${pad(x.id.length > 40 ? x.id.slice(0, 39) + "…" : x.id, 40)} ${pad(fmt(x.stars), 8)} ${pad(`~${fmt(x.perDay ?? 0)}/d`, 11)} 天數 ${pad(x.ageDays ?? "?", 4)} ${x.trending ? "✓ trending" : "— 未上榜"}`);
    });
  }
  if (growth.alerts.length) {
    console.log(`\n⚠ 健檢：真的在長、但今日不在 trending（${growth.alerts.length} 筆）`);
    for (const a of growth.alerts) {
      const tag = a.kind === "measured" ? `近${a.span}日 +${fmt(a.delta ?? 0)}` : a.kind === "recent" ? `單日 +${fmt(a.delta ?? 0)}` : "新秀";
      console.log(`  · ${a.id}  ${tag}　${fmt(a.perDay)}/day　總 ${fmt(a.stars)}★`);
    }
  } else {
    console.log("\n✓ 健檢：增速前段班的專案今天都在 trending 上");
  }
  console.log(`\n追蹤 ${growth.watching} 個專案（新增 ${discoveredNew}、淘汰 ${pruned}${seeded ? `、基底 ${seeded}` : ""}）→ data/growth/${runDate}.json`);

  return { growth, ok, fail, added: discoveredNew };
}

if (import.meta.main) await runWatch();
