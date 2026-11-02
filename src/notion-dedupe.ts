// 修復：刪掉「每日名次」裡的重複列（同一 日期×榜單×標題 多於一列）
// 成因：寫入是「POST 建列 → 存本機快取」兩步，若中途被中斷／同時跑兩個實例，就會多出一列。
// 保留規則：優先用 data/notion_obs.json 記的那一列，否則留最早建立的。
// 用法: bun run src/notion-dedupe.ts [--dry]
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT } from "./lib.ts";

const API = "https://api.notion.com/v1";
const IDS = JSON.parse(await Bun.file(join(ROOT, "data", "notion_items_db.json")).text()) as { obs: string };
const OBS_FILE = join(ROOT, "data", "notion_obs.json");
const obsMap: Record<string, string> = existsSync(OBS_FILE) ? JSON.parse(await Bun.file(OBS_FILE).text()) : {};
const dry = process.argv.includes("--dry");

const token = process.env.NOTION_API_KEY ?? "";
if (!token) throw new Error("需要 NOTION_API_KEY 環境變數");

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

const rows: any[] = [];
let cursor: string | undefined;
do {
  const q = await api("POST", `/databases/${IDS.obs}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
  rows.push(...q.results);
  cursor = q.has_more ? q.next_cursor : undefined;
} while (cursor);

const keep = new Set(Object.values(obsMap));
const groups = new Map<string, any[]>();
for (const r of rows) {
  const p = r.properties;
  const title = (p["標題"]?.title ?? []).map((x: any) => x.plain_text).join("");
  groups.set(title, [...(groups.get(title) ?? []), r]);
}

let removed = 0;
for (const [title, list] of groups) {
  if (list.length < 2) continue;
  // 優先保留 obsMap 指到的那一列
  const keeper = list.find((r) => keep.has(r.id)) ?? list.sort((a, b) => a.created_time.localeCompare(b.created_time))[0];
  for (const r of list) {
    if (r.id === keeper.id) continue;
    if (dry) console.log(`[dry] 會刪 ${title}`);
    else await api("PATCH", `/pages/${r.id}`, { archived: true });
    removed++;
  }
}
console.log(`${dry ? "（dry run）" : "✅"} 共 ${rows.length} 列，重複群組 ${[...groups.values()].filter((l) => l.length > 1).length} 個，${dry ? "待刪" : "已刪"} ${removed} 列`);