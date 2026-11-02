// 建立 Notion 的常用視圖（可重複執行：同名的就跳過）
// 用法: bun run src/notion-views.ts [--dry] [--verify]
//   --verify：用「查詢視圖」API 把每個視圖的實際結果抓回來，確認筆數符合預期
//
// 注意：視圖 API 需要 Notion-Version 2026-03-11（data source 概念），
// 與 notion-items／notion-export 用的 2022-06-28 並存，各支程式自己帶版本號。
import { join } from "node:path";
import { ROOT } from "./lib.ts";

const API = "https://api.notion.com/v1";
const VER = "2026-03-11";
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const verify = argv.includes("--verify");

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
      headers: { authorization: `Bearer ${token}`, "notion-version": VER, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) {
      await Bun.sleep(Math.min(Number(res.headers.get("retry-after") ?? 1), 60) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }
  throw new Error("重試 5 次仍被限流");
}

// ── 視圖定義 ──────────────────────────────────────
type ViewSpec = {
  db: "hf" | "gh" | "aa" | "obs";
  name: string;
  type: "table" | "board" | "chart" | "list" | "gallery";
  filter?: unknown;
  sorts?: unknown[];
  quick_filters?: Record<string, unknown>;
  configuration?: unknown;
  /** 驗證時預期的筆數（undefined＝不檢查） */
  expect?: number;
  why: string;
};

const sel = (name: string, value: string) => ({ property: name, select: { equals: value } });

/** 每日名次的三個榜：欄位挑過，只看當日數字 */
const obsProps = (board: "HF" | "GitHub" | "AA") => {
  const common = ["標題", "日期", "榜單", "名次", "指標", "漲跌", "狀態", "分類"];
  const own = board === "HF" ? ["下載", "讚", "累計下載"] : board === "GitHub" ? ["stars", "今日 stars", "forks"] : ["輸入價", "輸出價", "tok/s", "任務成本"];
  const others = ["HF 模型", "GitHub 專案", "AA 模型"].filter((x) => !x.startsWith(board));
  return [
    ...common.map((p) => ({ property_id: p, visible: true })),
    ...own.map((p) => ({ property_id: p, visible: true })),
    ...others.map((p) => ({ property_id: p, visible: false })),
    { property_id: "規格更新", visible: false },
    { property_id: "修改時間", visible: false },
  ];
};

const SPECS: ViewSpec[] = [
  // ── HF 模型 ──
  {
    db: "hf",
    name: "參數 100B 以上",
    type: "table",
    filter: { property: "參數", number: { greater_than_or_equal_to: 100_000_000_000 } },
    sorts: [{ property: "參數", direction: "descending" }],
    why: "大模型清單；參數是穩定事實，適合排序",
  },
  {
    db: "hf",
    name: "授權一覽",
    type: "board",
    quick_filters: { 授權: {} },
    sorts: [{ property: "參數", direction: "descending" }],
    configuration: {
      type: "board",
      group_by: { type: "select", property_id: "授權", sort: { type: "ascending" }, hide_empty_groups: true },
      card_layout: "compact",
    },
    why: "按授權分欄，一眼看出哪個授權最多；filter bar 可即時篩",
  },
  {
    db: "hf",
    name: "常客（在榜 ≥ 7 天）",
    type: "table",
    filter: { property: "在榜天數", rollup: { number: { greater_than_or_equal_to: 7 } } },
    sorts: [{ property: "在榜天數", direction: "descending" }, { property: "最高名次", direction: "ascending" }],
    why: "區分「長期霸榜」與「一日行情」",
  },

  // ── GitHub 專案 ──
  {
    db: "gh",
    name: "依語言",
    type: "board",
    sorts: [{ property: "在榜天數", direction: "descending" }],
    configuration: {
      type: "board",
      group_by: { type: "select", property_id: "語言", sort: { type: "ascending" }, hide_empty_groups: true },
      card_layout: "compact",
    },
    why: "看哪個語言的專案正在紅",
  },
  {
    db: "gh",
    name: "在榜最久",
    type: "table",
    sorts: [{ property: "在榜天數", direction: "descending" }, { property: "最高名次", direction: "ascending" }],
    quick_filters: { 語言: {} },
    why: "誰是常駐榜單的專案；語言可即時篩",
  },

  // ── AA 模型 ──
  {
    db: "aa",
    name: "開放權重",
    type: "table",
    filter: { property: "開放權重", checkbox: { equals: true } },
    sorts: [{ property: "在榜天數", direction: "descending" }],
    why: "開源與閉源分開看（2026-11-02 實測 0 筆：AA 前十目前沒有開放權重模型，不是壞掉）",
  },
  {
    db: "aa",
    name: "依開發商",
    type: "board",
    sorts: [{ property: "在榜天數", direction: "descending" }],
    configuration: {
      type: "board",
      group_by: { type: "select", property_id: "開發商", sort: { type: "ascending" }, hide_empty_groups: true },
      card_layout: "compact",
    },
    why: "誰在這份榜單上佔的席次最多",
  },

  // ── 每日名次：三個榜各一個視圖（Notion 的視圖是免費的，所以共用一張表不吃虧）──
  {
    db: "obs",
    name: "HF 榜",
    type: "table",
    filter: sel("榜單", "HF"),
    sorts: [{ property: "日期", direction: "descending" }, { property: "名次", direction: "ascending" }],
    configuration: { type: "table", properties: obsProps("HF") },
    expect: 140,
    why: "網站 HF 榜的原始資料，依日期新到舊",
  },
  {
    db: "obs",
    name: "GitHub 榜",
    type: "table",
    filter: sel("榜單", "GitHub"),
    sorts: [{ property: "日期", direction: "descending" }, { property: "名次", direction: "ascending" }],
    configuration: { type: "table", properties: obsProps("GitHub") },
    expect: 71,
    why: "同上，GitHub",
  },
  {
    db: "obs",
    name: "AA 榜",
    type: "table",
    filter: sel("榜單", "AA"),
    sorts: [{ property: "日期", direction: "descending" }, { property: "名次", direction: "ascending" }],
    configuration: { type: "table", properties: obsProps("AA") },
    expect: 50,
    why: "同上，Artificial Analysis",
  },
  {
    db: "obs",
    name: "新面孔",
    type: "table",
    filter: sel("狀態", "新進"),
    sorts: [{ property: "日期", direction: "descending" }, { property: "榜單", direction: "ascending" }],
    configuration: { type: "table", properties: obsProps("HF") },
    why: "每天新進榜的東西；「新」＝本站首次記錄，不代表當天發布",
  },
  {
    db: "obs",
    name: "HF 單日熱度排行",
    type: "table",
    filter: sel("榜單", "HF"),
    sorts: [{ property: "指標", direction: "descending" }],
    quick_filters: { 日期: {} },
    configuration: { type: "table", properties: obsProps("HF") },
    why: "跨日期比較熱度；先選日期再排序，看當天誰最熱",
  },
  {
    db: "obs",
    name: "GitHub 單日 stars 排行",
    type: "table",
    filter: sel("榜單", "GitHub"),
    sorts: [{ property: "指標", direction: "descending" }],
    quick_filters: { 日期: {} },
    configuration: { type: "table", properties: obsProps("GitHub") },
    why: "同日跨專案比較「今天新增幾顆星」；先選日期再排序",
  },
  {
    db: "obs",
    name: "AA 單日 II 排行",
    type: "table",
    filter: sel("榜單", "AA"),
    sorts: [{ property: "指標", direction: "descending" }],
    quick_filters: { 日期: {} },
    configuration: { type: "table", properties: obsProps("AA") },
    why: "Intelligence Index 是浮點數，Notion 的排序比網站上的「同分」更精確",
  },
  {
    db: "obs",
    name: "每日收錄筆數",
    type: "chart",
    configuration: {
      type: "chart",
      chart_type: "line",
      x_axis: { type: "date", property_id: "日期", group_by: "day", sort: { type: "ascending" } },
      y_axis: { aggregator: "count" },
      height: "medium",
      axis_labels: "both",
      grid_lines: "horizontal",
      caption: "每天寫進 Notion 的觀測筆數（三個榜加總）。數字變動代表榜單長度改變，不是漏抓。",
    },
    why: "一眼看出資料管線有沒有斷",
  },
];

// ── 建立 ─────────────────────────────────────────
const dsCache = new Map<string, string>();
async function dataSourceOf(db: string): Promise<string> {
  if (dsCache.has(db)) return dsCache.get(db)!;
  const d = await api("GET", `/databases/${db}`);
  const id = d.data_sources?.[0]?.id;
  if (!id) throw new Error(`${db} 沒有 data source`);
  dsCache.set(db, id);
  return id;
}

/** 視圖的 group_by／chart 軸要用「屬性 id」（不是名稱），而且 data source 回的是 URL-encoded 短 id */
const propIdCache = new Map<string, Map<string, string>>();
async function propIds(db: string): Promise<Map<string, string>> {
  const hit = propIdCache.get(db);
  if (hit) return hit;
  const ds = await dataSourceOf(db);
  const d = await api("GET", `/data_sources/${ds}`);
  const m = new Map<string, string>();
  for (const [name, p] of Object.entries<any>(d.properties ?? {})) m.set(name, decodeURIComponent(p.id));
  propIdCache.set(db, m);
  return m;
}

async function existingViews(databaseId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const r = await api("GET", `/views?database_id=${databaseId}${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const v of r.results ?? []) {
      const full = await api("GET", `/views/${v.id}`);
      if (full.name) out.set(full.name, full.id);
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** configuration 裡的 property_id 可能是中文名稱，換成真正的屬性 id */
function resolveIds(cfg: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(cfg)) return cfg.map((x) => resolveIds(x, ids));
  if (cfg && typeof cfg === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (k === "property_id" && typeof v === "string") out[k] = ids.get(v) ?? v;
      else out[k] = resolveIds(v, ids);
    }
    return out;
  }
  return cfg;
}

const created: { spec: ViewSpec; id: string }[] = [];
for (const dbKey of ["hf", "gh", "aa", "obs"] as const) {
  const databaseId = DB[dbKey];
  const have = await existingViews(databaseId);
  const specs = SPECS.filter((s) => s.db === dbKey);
  console.log(`\n${dbKey}（既有 ${have.size} 個視圖）`);
  for (const spec of specs) {
    if (have.has(spec.name)) {
      console.log(`  ↷ ${spec.name} 已存在`);
      created.push({ spec, id: have.get(spec.name)! });
      continue;
    }
    if (dry) {
      console.log(`  [dry] 會建 ${spec.name}（${spec.type}）：${spec.why}`);
      continue;
    }
    try {
      const ds = await dataSourceOf(databaseId);
      const ids = await propIds(databaseId);
      const body: Record<string, unknown> = { database_id: databaseId, data_source_id: ds, name: spec.name, type: spec.type };
      if (spec.filter) body.filter = spec.filter;
      if (spec.sorts) body.sorts = spec.sorts;
      if (spec.quick_filters) body.quick_filters = spec.quick_filters;
      if (spec.configuration) body.configuration = resolveIds(spec.configuration, ids);
      const v = await api("POST", "/views", body);
      console.log(`  ✓ ${spec.name}（${spec.type}）`);
      created.push({ spec, id: v.id });
    } catch (e) {
      console.log(`  ✗ ${spec.name}：${(e as Error).message.slice(0, 160)}`);
    }
  }
}

// ── 驗證：用「查詢視圖」把實際結果抓回來 ──────────
if (verify && !dry) {
  console.log("\n驗證（查詢各視圖的實際結果）…");
  for (const { spec, id } of created) {
    try {
      const q = await api("POST", `/views/${id}/queries`, {});
      const total: number = q.total_count ?? (q.results ?? []).length;
      if (q.id) await api("DELETE", `/views/queries/${q.id}`).catch(() => {});
      const ok = spec.expect === undefined ? "" : total === spec.expect ? " ✓" : ` ✗ 預期 ${spec.expect}`;
      console.log(`  ${spec.name}：${total} 筆${ok}`);
    } catch (e) {
      console.log(`  ${spec.name}：查詢失敗 ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

console.log(`\n${dry ? "（dry run）" : `✅ ${created.length} 個視圖就緒`}`);