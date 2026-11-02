// Notion → 快照 JSON（回歸驗證用的反向匯出）
// 讀「每日名次」＋三個實體表＋日報的 榜單中繼／導讀段落，重組 data/snapshots 與 data/headlines，
// 再跟本機既有 JSON 逐欄 diff。diff 必須為空，才代表 Notion 真的能當上游。
//
// 用法:
//   bun run src/notion-export.ts            # 只比對，不寫檔
//   bun run src/notion-export.ts --write    # 寫入 data/（覆蓋 snapshot 與 headlines）
//   bun run src/notion-export.ts --date 2026-11-02 [--write]
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot, type Board, type Item, type Snapshot } from "./lib.ts";
import { hfNote, fmtParams, composeDetail } from "./format.ts";

const API = "https://api.notion.com/v1";
const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const write = argv.includes("--write");
const onlyDate = argOf("--date");
const OUT_DIR = join(ROOT, "data", "notion-export");

const token = process.env.NOTION_API_KEY ?? "";
if (!token) throw new Error("需要 NOTION_API_KEY 環境變數");
const DB = JSON.parse(await Bun.file(join(ROOT, "data", "notion_items_db.json")).text()) as { hf: string; gh: string; aa: string; obs: string };

let last = 0;
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const wait = last + 350 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  last = Date.now();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) {
      await Bun.sleep(Math.min(Number(res.headers.get("retry-after") ?? 1), 60) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }
  throw new Error("重試 5 次仍被限流");
}

async function queryAll(dbId: string, filter?: unknown): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const q = await api("POST", `/databases/${dbId}/query`, { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(q.results ?? []).filter((r: any) => !r.archived));
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function children(blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const q = await api("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...q.results);
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── 屬性取值 ──────────────────────────────────────
const P: Record<string, (p: any) => any> = {
  title: (p) => (p.title ?? []).map((x: any) => x.plain_text).join(""),
  rich_text: (p) => (p.rich_text ?? []).map((x: any) => x.plain_text).join(""),
  number: (p) => p.number,
  date: (p) => p.date?.start ?? null,
  url: (p) => p.url ?? null,
  select: (p) => p.select?.name ?? null,
  checkbox: (p) => p.checkbox,
  relation: (p) => (p.relation ?? []).map((r: any) => r.id),
};
function read(props: Record<string, any>, name: string): any {
  const p = props[name];
  if (!p) return undefined;
  return P[p.type] ? P[p.type]!(p) : undefined;
}

// ── 讀三張實體表 ──────────────────────────────────
type EntityMap = Map<string, Record<string, any>>;
async function loadEntities(db: string, fields: string[]): Promise<EntityMap> {
  const rows = await queryAll(db);
  const map: EntityMap = new Map();
  for (const r of rows) {
    const o: Record<string, any> = {};
    for (const f of fields) o[f] = read(r.properties, f);
    map.set(r.id, o);
  }
  console.log(`  ${fields[0]}… ${map.size} 列`);
  return map;
}

const HF_FIELDS = ["名稱", "網址", "Pipeline", "Library", "授權", "語言", "參數", "參數來源", "生效參數", "精度", "基底模型", "參數組成", "發布時間"];
const GH_FIELDS = ["名稱", "網址", "語言", "描述"];
const AA_FIELDS = ["名稱", "顯示名稱", "網址", "開發商", "開放權重"];

// ── 榜單靜態欄位（與 fetch-*.ts 一致；差異會被 diff 抓到）──
const BOARD_META: Record<string, { label: string; question: string; source: string }> = {
  hf: { label: "HuggingFace", question: "哪個開源模型正在紅", source: "huggingface.co/api（trendingScore）" },
  gh: { label: "GitHub", question: "開發者的注意力在哪", source: "github.com/trending（HTML）" },
  aa: { label: "Artificial Analysis", question: "哪個模型真的強、又划算", source: "artificialanalysis.ai（Intelligence Index）" },
};

// ── 主流程 ────────────────────────────────────────
const dates = listSnapshots()
  .map((f) => f.replace(/\.json$/, ""))
  .filter((x) => !onlyDate || x === onlyDate);

console.log("讀 Notion…");
const hfEnt = await loadEntities(DB.hf, HF_FIELDS);
const ghEnt = await loadEntities(DB.gh, GH_FIELDS);
const aaEnt = await loadEntities(DB.aa, AA_FIELDS);
const obsRows = await queryAll(DB.obs);
console.log(`  observations ${obsRows.length} 列`);

// 日報：日期 → board → { relay, boards 導讀 }
const daily: Record<string, Record<string, { relay: any; lead: string | null }>> = {};
for (const board of ["hf", "gh", "aa"] as const) {
  const dbFile = join(ROOT, "..", "data", `notion_${board}.json`);
  const { db } = JSON.parse(await Bun.file(dbFile).text()) as { db: string };
  for (const row of await queryAll(db)) {
    const date = read(row.properties, "日期");
    if (!date) continue;
    const relayRaw = read(row.properties, "榜單中繼") ?? "";
    let relay: any = null;
    try {
      relay = relayRaw ? JSON.parse(relayRaw) : null;
    } catch {
      console.warn(`  ⚠ ${date} ${board} 榜單中繼 不是合法 JSON`);
    }
    // 逐榜短版導讀：heading 導讀（編輯）之後、下一個 heading 之前的段落
    let lead: string | null = null;
    const blocks = await children(row.id);
    const at = blocks.findIndex((b) => b.type === "heading_2" && (b.heading_2.rich_text ?? []).map((x: any) => x.plain_text).join("").includes("導讀"));
    if (at >= 0) {
      const paras: string[] = [];
      for (const b of blocks.slice(at + 1)) {
        if (b.type.startsWith("heading_")) break;
        if (b.type === "paragraph") paras.push((b.paragraph.rich_text ?? []).map((x: any) => x.plain_text).join(""));
      }
      lead = paras.join("\n").trim() || null;
    }
    (daily[date] ??= {})[board] = { relay, lead };
  }
  console.log(`  日報 ${board} 讀取完成`);
}

// 觀測分組
const byDate = new Map<string, any[]>();
for (const r of obsRows) {
  const date = read(r.properties, "日期");
  if (!date) continue;
  (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(r);
}

function buildItem(board: "hf" | "gh" | "aa", row: any): Item | null {
  const p = row.properties;
  const relIds: string[] = read(p, board === "hf" ? "HF 模型" : board === "gh" ? "GitHub 專案" : "AA 模型") ?? [];
  const ent = (board === "hf" ? hfEnt : board === "gh" ? ghEnt : aaEnt).get(relIds[0] ?? "");
  if (!ent) {
    console.warn(`  ⚠ ${read(p, "標題")}：relation 指向的實體不存在`);
    return null;
  }
  const rank = read(p, "名次");
  const metric = read(p, "指標");
  const kicker = read(p, "分類") ?? "";
  const base = { id: ent["名稱"] as string, name: ent["名稱"] as string, url: ent["網址"] ?? "", rank, metric };

  if (board === "hf") {
    const downloads = read(p, "下載");
    const likes = read(p, "讚");
    const createdAt = ent["發布時間"] ?? null;
    const params = ent["參數"] ?? null;
    const paramsActive = ent["生效參數"] ?? null;
    const stats = {
      downloads,
      downloadsAllTime: read(p, "累計下載"),
      likes,
      tag: kicker,
      pipeline: ent["Pipeline"] ?? null,
      library: ent["Library"] ?? null,
      createdAt,
      lastModified: read(p, "修改時間") || null,
      params,
      paramsText: params === null ? "—" : fmtParams(params),
      paramsActive,
      paramsActiveText: paramsActive === null ? null : fmtParams(paramsActive),
      paramsSrc: ent["參數來源"] ?? null,
      paramsBreakdown: ent["參數組成"] || null,
      license: ent["授權"] ?? null,
      langs: ent["語言"] || null,
      quant: ent["精度"] ?? null,
      baseModel: ent["基底模型"] || null,
      detail: composeDetail({
        params,
        paramsText: params === null ? "—" : fmtParams(params),
        paramsActiveText: paramsActive === null ? null : fmtParams(paramsActive),
        paramsSrc: ent["參數來源"] ?? null,
        paramsBreakdown: ent["參數組成"] || null,
        quant: ent["精度"] ?? null,
        license: ent["授權"] ?? null,
        langs: ent["語言"] || null,
        baseModel: ent["基底模型"] || null,
      }),
    };
    return { ...base, kicker, note: hfNote({ downloads, likes, createdAt }), stats };
  }
  if (board === "gh") {
    return {
      ...base,
      kicker,
      note: ent["描述"] ?? "",
      stats: { stars: read(p, "stars"), forks: read(p, "forks"), todayStars: read(p, "今日 stars"), lang: ent["語言"] ?? null },
    };
  }
  return {
    ...base,
    name: ent["顯示名稱"] || ent["名稱"],
    kicker,
    note: `$${read(p, "輸入價") ?? "—"} / $${read(p, "輸出價") ?? "—"} 每百萬 token · ${Math.round(read(p, "tok/s") ?? 0) || "—"} tok/s${ent["開放權重"] ? " · 開放權重" : ""}`,
    stats: { priceIn: read(p, "輸入價"), priceOut: read(p, "輸出價"), tps: read(p, "tok/s"), costPerTask: read(p, "任務成本"), openWeights: ent["開放權重"] ? 1 : 0 },
  };
}

function buildSnapshot(date: string): Snapshot {
  const boards: Record<string, Board> = {};
  const rows = byDate.get(date) ?? [];
  for (const board of ["hf", "gh", "aa"] as const) {
    const rowsFor = rows.filter((r) => read(r.properties, "榜單") === { hf: "HF", gh: "GitHub", aa: "AA" }[board]);
    const relay = daily[date]?.[board]?.relay;
    // 那天還沒上線的榜（沒有觀測、也沒有日報列）就不要憑空生一個空榜
    if (!rowsFor.length && !relay) continue;
    const items = rowsFor.map((r) => buildItem(board, r)).filter((x): x is Item => !!x).sort((a, b) => a.rank - b.rank);
    const b: Board = { ...BOARD_META[board]!, items };
    if (relay && "notes" in relay) b.notes = relay.notes;
    if (relay && "events" in relay) b.events = relay.events;
    boards[board] = b;
  }
  const gen = daily[date]?.hf?.relay?.generatedAt ?? daily[date]?.gh?.relay?.generatedAt ?? null;
  return { date, generatedAt: gen, boards } as Snapshot;
}

function buildHeadline(date: string) {
  const relay = daily[date]?.hf?.relay?.headlines ?? {};
  const boards: Record<string, string> = {};
  // boards[] 以 榜單中繼 的 JSON 為準（頁面段落會被 Notion 洗掉行內 HTML）
  for (const k of ["hf", "gh", "aa"]) {
    const v = relay.boards?.[k] ?? daily[date]?.[k]?.lead;
    if (v) boards[k] = v;
  }
  return { by: relay.by ?? "編輯", lead: relay.lead ?? [], boards };
}

// ── diff ─────────────────────────────────────────
function diff(a: any, b: any, path = ""): string[] {
  const out: string[] = [];
  if (a === b) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (!(typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9)) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: 型別不同（array vs object）`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${path}: 長度 ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) out.push(...diff(a[k], b[k], path ? `${path}.${k}` : k));
  return out;
}

let total = 0;
mkdirSync(OUT_DIR, { recursive: true });
for (const date of dates) {
  const got = buildSnapshot(date);
  const local = await readSnapshot(date);
  const diffs = local ? diff(local, got, "snapshot") : ["本機沒有這天的快照"];
  const hlGot = buildHeadline(date);
  const hlFile = join(ROOT, "data", "headlines", `${date}.json`);
  const hlLocal = existsSync(hlFile) ? JSON.parse(await Bun.file(hlFile).text()) : null;
  // 本機沒有導讀檔、匯出的也是空的 → 沒東西可比，不算差異（10/20–10/28 本來就沒寫導讀）
  const hlDiffs = hlLocal
    ? diff({ lead: hlLocal.lead ?? [], boards: Object.fromEntries(["hf", "gh", "aa"].map((k) => [k, hlLocal.boards?.[k]]).filter(([, v]) => v)) }, { lead: hlGot.lead, boards: hlGot.boards }, "headlines")
    : []; // 本機沒有導讀檔（10/20–10/28 還沒開始寫導讀）；Notion 那邊即使有段落也不算差異
  const hlInfo = !hlLocal && (hlGot.lead.length || Object.keys(hlGot.boards).length)
    ? `（本機無導讀檔；Notion 有 ${Object.keys(hlGot.boards).length} 段逐榜摘要，不計入差異）`
    : "";

  const all = [...diffs, ...hlDiffs];
  total += all.length;
  console.log(`\n${date}　${all.length ? `✗ ${all.length} 處不同` : "✓ 完全一致"}（items ${Object.values(got.boards).reduce((n, b) => n + b.items.length, 0)} 筆）${hlInfo}`);
  for (const d of all.slice(0, 8)) console.log(`   ${d}`);
  if (all.length > 8) console.log(`   …另有 ${all.length - 8} 處`);

  await Bun.write(join(OUT_DIR, `${date}.json`), JSON.stringify(got, null, 1) + "\n");

  // --write：以 Notion 為準覆寫本機 JSON（人在 Notion 改的東西就會流回網站）。
  // 安全閘：匯出的項目數比本機少 → 視為 Notion 沒寫完／被誤刪，當天不覆寫。
  if (write) {
    const gotCount = Object.values(got.boards).reduce((n, b) => n + b.items.length, 0);
    const localCount = local ? Object.values(local.boards).reduce((n, b) => n + b.items.length, 0) : 0;
    if (local && gotCount < localCount) {
      console.log(`   ⛔ 匯出只有 ${gotCount} 筆，本機 ${localCount} 筆 → 不覆寫（Notion 可能沒寫完）`);
    } else {
      const { writeSnapshot } = await import("./lib.ts");
      await writeSnapshot(got);
      // 導讀檔只在「本來就有」時覆寫：沒有導讀的年代不憑空生一個空檔（會讓網站的導讀區消失）
      if (hlLocal) await Bun.write(hlFile, JSON.stringify({ by: hlGot.by, lead: hlGot.lead, boards: hlGot.boards }, null, 1)); // 原檔沒有結尾換行
    }
  }
}

console.log(`\n${total === 0 ? "✅ 匯出與本機快照完全一致" : `⚠ 共 ${total} 處不同`}　匯出檔在 ${OUT_DIR}`);
if (total > 0) process.exitCode = 1;