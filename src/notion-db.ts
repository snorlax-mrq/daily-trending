// 建立 Notion 的 4 個新 DB（星型模型）：HF 模型／GitHub 專案／AA 模型／每日名次
// 一次性（可重複執行）：已存在就沿用，只補缺少的屬性。
// 用法: bun run src/notion-db.ts [--dry]
// 產出: data/notion_items_db.json  ← 4 個 DB id，給 notion-items / notion-export 用
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT } from "./lib.ts";

const API = "https://api.notion.com/v1";
const PAGE = "408b8a3a-65b7-81ae-ad5a-c185775b3392"; // 「每日榜單」頁（三個日報 DB 也掛在這）
const IDS_FILE = join(ROOT, "data", "notion_items_db.json");
const dry = process.argv.includes("--dry");

const token = process.env.NOTION_API_KEY ?? "";
if (!token) throw new Error("需要 NOTION_API_KEY 環境變數");

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) {
      const wait = Number(res.headers.get("retry-after") ?? 1);
      await Bun.sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }
  throw new Error(`${method} ${path} → 重試 4 次仍被限流`);
}

const sleep = (ms = 350) => Bun.sleep(ms);

async function findDb(title: string): Promise<string | null> {
  const r = await api("POST", "/search", { query: title, filter: { value: "database", property: "object" }, page_size: 100 });
  const hit = (r.results ?? []).find((db: any) => {
    const t = (db.title ?? []).map((x: any) => x.plain_text).join("");
    return t === title && !db.archived;
  });
  return hit?.id ?? null;
}

async function ensureDb(title: string, properties: Record<string, unknown>, dbIds: Record<string, string>): Promise<string> {
  const existing = await findDb(title);
  if (existing) {
    console.log(`↷ ${title} 已存在 ${existing}`);
    // 補缺少的屬性（Notion 不能改型別，只能加新屬性）
    const def = await api("GET", `/databases/${existing}`);
    const have = new Set(Object.keys(def.properties ?? {}));
    const missing = Object.fromEntries(Object.entries(properties).filter(([k]) => !have.has(k)));
    if (Object.keys(missing).length) {
      if (dry) console.log(`  [dry] 會補屬性 ${Object.keys(missing).join("、")}`);
      else {
        await api("PATCH", `/databases/${existing}`, { properties: missing });
        console.log(`  ＋補屬性 ${Object.keys(missing).join("、")}`);
      }
    }
    return existing;
  }
  if (dry) {
    console.log(`[dry] 會建立 ${title}`);
    return `dry-${title}`;
  }
  const db = await api("POST", "/databases", {
    parent: { type: "page_id", page_id: PAGE },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  console.log(`✓ 建立 ${title} → ${db.id}`);
  await sleep();
  return db.id as string;
}

// ── 屬性小工具 ──
const title = () => ({ title: {} });
const rich = () => ({ rich_text: {} });
const num = () => ({ number: { format: "number" } });
const date = () => ({ date: {} });
const url = () => ({ url: {} });
const check = () => ({ checkbox: {} });
const select = (names: string[] = []) => ({ select: { options: names.map((name) => ({ name })) } });
const rel = (dbId: string, syncedName: string) => ({
  relation: { database_id: dbId, type: "dual_property", dual_property: { synced_property_name: syncedName } },
});

// ── 1/2/3：三個實體表 ──
const HF_MODEL: Record<string, unknown> = {
  名稱: title(),
  網址: url(),
  Pipeline: select(),
  Library: select(),
  授權: select(),
  語言: rich(),
  參數: num(),
  參數來源: select(["safetensors", "name"]),
  生效參數: num(),
  精度: select(),
  基底模型: rich(),
  發布日: date(),
  首次收錄: date(),
  最近在榜: date(),
  // 觀測（relation）由「每日名次」建立時反向帶進來
};

const GH_REPO: Record<string, unknown> = {
  名稱: title(),
  網址: url(),
  語言: select(),
  描述: rich(),
  首次收錄: date(),
  最近在榜: date(),
};

const AA_MODEL: Record<string, unknown> = {
  名稱: title(),
  顯示名稱: rich(),
  網址: url(),
  開發商: select(),
  開放權重: check(),
  首次收錄: date(),
  最近在榜: date(),
};

const hfId = await ensureDb("HF 模型", HF_MODEL, {});
const ghId = await ensureDb("GitHub 專案", GH_REPO, {});
const aaId = await ensureDb("AA 模型", AA_MODEL, {});

// ── 4：每日名次（共用一張，靠「榜單」區分）──
const OBS: Record<string, unknown> = {
  標題: title(),
  日期: date(),
  榜單: select(["HF", "GitHub", "AA"]),
  名次: num(),
  指標: num(),
  漲跌: num(),
  狀態: select(["新進", "上升", "下降", "持平"]),
  分類: select(),
  // HF 當日數字
  下載: num(),
  讚: num(),
  累計下載: num(),
  // GitHub 當日數字
  stars: num(),
  forks: num(),
  "今日 stars": num(),
  // AA 當日數字
  輸入價: num(),
  輸出價: num(),
  "tok/s": num(),
  任務成本: num(),
  規格更新: date(),
  ...(hfId.startsWith("dry-") ? {} : { "HF 模型": rel(hfId, "觀測") }),
  ...(ghId.startsWith("dry-") ? {} : { "GitHub 專案": rel(ghId, "觀測") }),
  ...(aaId.startsWith("dry-") ? {} : { "AA 模型": rel(aaId, "觀測") }),
};
const obsId = await ensureDb("每日名次", OBS, {});

// ── 5：實體表的 rollup（在榜天數／最高名次）──
async function addRollups(dbId: string, label: string) {
  if (dbId.startsWith("dry-")) return;
  const def = await api("GET", `/databases/${dbId}`);
  const props = def.properties ?? {};
  if (!props["觀測"]) {
    console.log(`  ⚠ ${label} 沒有「觀測」relation，跳過 rollup`);
    return;
  }
  const missing: Record<string, unknown> = {};
  if (!props["在榜天數"]) missing["在榜天數"] = { rollup: { relation_property_name: "觀測", rollup_property_name: "名次", function: "count" } };
  if (!props["最高名次"]) missing["最高名次"] = { rollup: { relation_property_name: "觀測", rollup_property_name: "名次", function: "min" } };
  if (!Object.keys(missing).length) return;
  if (dry) {
    console.log(`  [dry] ${label} 會補 rollup ${Object.keys(missing).join("、")}`);
    return;
  }
  await api("PATCH", `/databases/${dbId}`, { properties: missing });
  console.log(`  ＋${label} rollup ${Object.keys(missing).join("、")}`);
  await sleep();
}
await addRollups(hfId, "HF 模型");
await addRollups(ghId, "GitHub 專案");
await addRollups(aaId, "AA 模型");

if (!dry) {
  const payload = { hf: hfId, gh: ghId, aa: aaId, obs: obsId };
  await Bun.write(IDS_FILE, JSON.stringify(payload, null, 1) + "\n");
  console.log(`\n✅ DB ids → ${IDS_FILE}`);
  console.log(payload);
} else {
  console.log("\n（dry run，未寫入）");
}
// data/notion_items_db.json 只在 setup 時寫；之後 notion-items / notion-export 直接讀
if (dry && existsSync(IDS_FILE)) console.log(`現有 ${IDS_FILE}:`, await Bun.file(IDS_FILE).text());