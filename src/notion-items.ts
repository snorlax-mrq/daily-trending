// 快照 → Notion 星型模型（實體 ×3 ＋ 觀測 ×1）
// 實體：HF 模型／GitHub 專案／AA 模型，一列一個東西，只放「這是什麼」
// 觀測：每日名次，一列一個「日期 × 項目」，放「那天網站上看到的數字」
// 用法:
//   bun run src/notion-items.ts                 # 全部快照（回填）
//   bun run src/notion-items.ts --date 2026-11-02
//   bun run src/notion-items.ts --dry
// 前置: 先跑 src/notion-db.ts 建 DB（data/notion_items_db.json）
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot, type Board, type Item, type Snapshot } from "./lib.ts";

const API = "https://api.notion.com/v1";
const IDS_FILE = join(ROOT, "data", "notion_items_db.json");
const CACHE_FILE = join(ROOT, "data", "notion_entities.json");
const OBS_FILE = join(ROOT, "data", "notion_obs.json");

const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = argv.includes("--dry");
const onlyDate = argOf("--date");

if (!existsSync(IDS_FILE)) throw new Error("先跑 bun run src/notion-db.ts 建立 DB");
const DB = JSON.parse(await Bun.file(IDS_FILE).text()) as { hf: string; gh: string; aa: string; obs: string };

const token = process.env.NOTION_API_KEY ?? "";
if (!token) throw new Error("需要 NOTION_API_KEY 環境變數");

// ── Notion API（含 429 退避 + 3 req/s 節流）────────────────
let lastCall = 0;
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const wait = lastCall + 350 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastCall = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) {
      const secs = Number(res.headers.get("retry-after") ?? 1);
      console.warn(`  ⏳ 限流，等 ${secs}s`);
      await Bun.sleep(Math.min(secs, 60) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  }
  throw new Error(`${method} ${path} → 重試 5 次仍被限流`);
}

// ── 屬性值 ────────────────────────────────────────
const t = (s: string) => ({ title: [{ type: "text", text: { content: s.slice(0, 1900) } }] });
const rt = (s: string) => ({ rich_text: [{ type: "text", text: { content: s.slice(0, 1900) } }] });
const n = (v: number | null | undefined) => ({ number: typeof v === "number" ? v : null });
const d = (s: string | null | undefined) => ({ date: s ? { start: s } : null });
const u = (s: string) => ({ url: s || null });
const sel = (s: string | null | undefined) => ({ select: s ? { name: s.slice(0, 90) } : null });
const ck = (b: boolean) => ({ checkbox: b });
const rel = (id: string) => ({ relation: [{ id }] });

/** 去掉 null 值，避免把既有值洗掉 */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ── 讀快照 ────────────────────────────────────────
const dates = listSnapshots()
  .map((f) => f.replace(/\.json$/, ""))
  .filter((x) => !onlyDate || x === onlyDate);
if (!dates.length) throw new Error("沒有符合的快照");

const snaps = new Map<string, Snapshot>();
for (const d0 of listSnapshots().map((f) => f.replace(/\.json$/, ""))) {
  const s = await readSnapshot(d0);
  if (s) snaps.set(d0, s);
}
const allDates = [...snaps.keys()].sort();

/** 前一日的名次（給漲跌／狀態）；與 build.ts 同一規則 */
function prevRank(board: string, id: string, date: string): number | undefined {
  const prev = allDates.filter((x) => x < date && snaps.get(x)!.boards[board]?.items?.length).pop();
  if (!prev) return undefined;
  return snaps.get(prev)!.boards[board]?.items?.find((i) => i.id === id)?.rank;
}

// ── 1. 實體：從所有快照取「最完整」的穩定欄位 ────────
type Entity = { id: string; props: Record<string, unknown>; hash: string };

const nums = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strs = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function buildEntities(board: "hf" | "gh" | "aa") {
  const acc = new Map<string, { first: string; last: string; items: Item[] }>();
  for (const date of allDates) {
    for (const it of snaps.get(date)!.boards[board]?.items ?? []) {
      const e = acc.get(it.id) ?? { first: date, last: date, items: [] };
      e.last = date;
      e.items.push(it);
      acc.set(it.id, e);
    }
  }
  const out: Entity[] = [];
  for (const [id, e] of acc) {
    // 欄位可能在不同天才有值（10/29 前沒有 license），取第一個非空值
    const pick = <T>(f: (s: Record<string, unknown>) => T | null): T | null => {
      for (const it of e.items) {
        const v = f(it.stats ?? {});
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return null;
    };
    const latest = e.items[e.items.length - 1]!;
    if (board === "hf") {
      const props = compact({
        名稱: t(id),
        網址: u(latest.url),
        Pipeline: sel(pick((s) => strs(s.pipeline))),
        Library: sel(pick((s) => strs(s.library))),
        授權: sel(pick((s) => strs(s.license))),
        ...(pick((s) => strs(s.langs)) ? { 語言: rt(pick((s) => strs(s.langs))!) } : {}),
        參數: n(pick((s) => nums(s.params))),
        參數來源: sel(pick((s) => strs(s.paramsSrc))),
        生效參數: n(pick((s) => nums(s.paramsActive))),
        精度: sel(pick((s) => strs(s.quant))),
        ...(pick((s) => strs(s.baseModel)) ? { 基底模型: rt(pick((s) => strs(s.baseModel))!) } : {}),
        參數組成: rt(pick((s) => strs(s.paramsBreakdown)) ?? ""),
        ...(pick((s) => strs(s.createdAt)) ? { 發布時間: rt(pick((s) => strs(s.createdAt))!) } : {}),
        發布日: d(pick((s) => strs(s.createdAt))?.slice(0, 10)),
        首次收錄: d(e.first),
        最近在榜: d(e.last),
      });
      out.push({ id, props, hash: JSON.stringify(props) });
    } else if (board === "gh") {
      const props = compact({
        名稱: t(id),
        網址: u(latest.url),
        語言: sel(pick((s) => strs(s.lang))),
        描述: rt(latest.note ?? ""),
        首次收錄: d(e.first),
        最近在榜: d(e.last),
      });
      out.push({ id, props, hash: JSON.stringify(props) });
    } else {
      const props = compact({
        名稱: t(id),
        顯示名稱: rt(latest.name),
        網址: u(latest.url),
        開發商: sel(latest.kicker),
        開放權重: ck(pick((s) => nums(s.openWeights)) === 1),
        首次收錄: d(e.first),
        最近在榜: d(e.last),
      });
      out.push({ id, props, hash: JSON.stringify(props) });
    }
  }
  return out;
}

// ── 2. 觀測：日期 × 項目 ─────────────────────────
type Obs = { key: string; title: string; props: Record<string, unknown>; board: "hf" | "gh" | "aa"; id: string };

const BOARD_LABEL = { hf: "HF", gh: "GitHub", aa: "AA" } as const;

function buildObservations(board: "hf" | "gh" | "aa"): Obs[] {
  const out: Obs[] = [];
  for (const date of dates) {
    const b: Board | undefined = snaps.get(date)!.boards[board];
    for (const it of b?.items ?? []) {
      const prev = prevRank(board, it.id, date);
      const delta = prev === undefined || prev === null ? null : prev - it.rank;
      const state = delta === null ? "新進" : delta > 0 ? "上升" : delta < 0 ? "下降" : "持平";
      const s = (it.stats ?? {}) as Record<string, unknown>;
      const title = `${date} · ${BOARD_LABEL[board]} · ${String(it.rank).padStart(2, "0")} ${it.name}`;
      const base: Record<string, unknown> = {
        標題: t(title),
        日期: d(date),
        榜單: sel(BOARD_LABEL[board]),
        名次: n(it.rank),
        指標: n(it.metric),
        漲跌: n(delta),
        狀態: sel(state),
        分類: sel(it.kicker),
      };
      if (board === "hf") {
        base.下載 = n(nums(s.downloads));
        base.讚 = n(nums(s.likes));
        base.累計下載 = n(nums(s.downloadsAllTime));
        const lm = strs(s.lastModified);
        if (lm) {
          base.規格更新 = d(lm.slice(0, 10));
          base.修改時間 = rt(lm); // 完整 ISO，匯出時要一字不差
        }
      } else if (board === "gh") {
        base.stars = n(nums(s.stars));
        base.forks = n(nums(s.forks));
        base["今日 stars"] = n(nums(s.todayStars));
      } else {
        base.輸入價 = n(nums(s.priceIn));
        base.輸出價 = n(nums(s.priceOut));
        base["tok/s"] = n(nums(s.tps));
        base.任務成本 = n(nums(s.costPerTask));
      }
      out.push({ key: `${date}|${board}|${it.id}`, title, props: compact(base), board, id: it.id });
    }
  }
  return out;
}

// ── 3. 寫入 ──────────────────────────────────────
type Cache = { [board: string]: Record<string, { page: string; hash: string }> };
const cache: Cache = existsSync(CACHE_FILE) ? JSON.parse(await Bun.file(CACHE_FILE).text()) : { hf: {}, gh: {}, aa: {} };
for (const k of ["hf", "gh", "aa"]) cache[k] ??= {};
const obsMap: Record<string, string> = existsSync(OBS_FILE) ? JSON.parse(await Bun.file(OBS_FILE).text()) : {};

async function saveCache() {
  if (dry) return;
  await Bun.write(CACHE_FILE, JSON.stringify(cache, null, 1) + "\n");
  await Bun.write(OBS_FILE, JSON.stringify(obsMap, null, 1) + "\n");
}

async function ensureEntity(board: "hf" | "gh" | "aa", e: Entity): Promise<string> {
  const hit = cache[board]![e.id];
  if (hit) {
    if (hit.hash === e.hash) return hit.page;
    if (!dry) await api("PATCH", `/pages/${hit.page}`, { properties: e.props });
    cache[board]![e.id] = { page: hit.page, hash: e.hash };
    return hit.page;
  }
  if (dry) return `dry-${board}-${e.id}`;
  // 沒快取：先查一次（Notion 可能已經有這個項目）
  const q = await api("POST", `/databases/${DB[board]}/query`, {
    filter: { property: "名稱", title: { equals: e.id } },
    page_size: 1,
  });
  const found = (q.results ?? [])[0];
  if (found) {
    await api("PATCH", `/pages/${found.id}`, { properties: e.props });
    cache[board]![e.id] = { page: found.id, hash: e.hash };
    return found.id;
  }
  const page = await api("POST", "/pages", { parent: { database_id: DB[board] }, properties: e.props });
  cache[board]![e.id] = { page: page.id, hash: e.hash };
  return page.id as string;
}

const stats = { created: 0, updated: 0, unchanged: 0, obsCreated: 0, obsUpdated: 0 };

async function upsertObservation(o: Obs, entityPage: string) {
  const props = { ...o.props, [o.board === "hf" ? "HF 模型" : o.board === "gh" ? "GitHub 專案" : "AA 模型"]: rel(entityPage) };
  const existing = obsMap[o.key];
  if (dry) {
    console.log(`  [dry] ${existing ? "PATCH" : "POST"} ${o.key}`);
    return;
  }
  if (existing) {
    await api("PATCH", `/pages/${existing}`, { properties: props });
    stats.obsUpdated++;
    return;
  }
  // 沒有快取：先用「標題」查一次，避免中斷／併發造成重複列
  const found = await api("POST", `/databases/${DB.obs}/query`, {
    filter: { property: "標題", title: { equals: o.title } },
    page_size: 1,
  });
  const hit = (found.results ?? [])[0];
  if (hit) {
    await api("PATCH", `/pages/${hit.id}`, { properties: props });
    obsMap[o.key] = hit.id;
    stats.obsUpdated++;
    await saveCache();
    return;
  }
  const page = await api("POST", "/pages", { parent: { database_id: DB.obs }, properties: props });
  obsMap[o.key] = page.id;
  stats.obsCreated++;
  await saveCache();
}

for (const board of ["hf", "gh", "aa"] as const) {
  const entities = buildEntities(board);
  console.log(`\n${BOARD_LABEL[board]}：${entities.length} 個實體、${buildObservations(board).length} 筆觀測`);
  const pageOf = new Map<string, string>();
  const local = { created: 0, updated: 0, unchanged: 0, obsCreated: 0, obsUpdated: 0 };
  const ob0 = { ...stats };
  for (const e of entities) {
    const before = cache[board]![e.id];
    const page = await ensureEntity(board, e);
    pageOf.set(e.id, page);
    if (!before) local.created++;
    else if (before.hash !== e.hash) local.updated++;
    else local.unchanged++;
    if (!dry) await saveCache();
  }
  for (const o of buildObservations(board)) {
    const page = pageOf.get(o.id);
    if (!page) {
      console.warn(`  ⚠ 找不到實體 ${o.id}，跳過觀測 ${o.key}`);
      continue;
    }
    await upsertObservation(o, page);
  }
  console.log(`  實體：新增 ${local.created}｜更新 ${local.updated}｜未變 ${local.unchanged}`);
  console.log(`  觀測：新增 ${stats.obsCreated - ob0.obsCreated}｜更新 ${stats.obsUpdated - ob0.obsUpdated}`);
}

await saveCache();
if (dry) console.log("\n（dry run，未寫入 Notion）");
else console.log(`\n✅ 實體 新增 ${stats.created}／更新 ${stats.updated}／未變 ${stats.unchanged}；觀測 新增 ${stats.obsCreated}／更新 ${stats.obsUpdated}`);