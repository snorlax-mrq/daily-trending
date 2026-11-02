// 把「非項目資料」寫進日報的 `榜單中繼` 屬性（JSON 字串）
// 內容：{ generatedAt, notes[], events[], headlines:{ by, lead[] } }
//   notes／events／generatedAt 是榜單層級的機器資料（不是項目，不進「每日名次」）
//   headlines.lead 是網站首頁的三段導讀（長版編輯文），Notion 只當資料容器
// 逐榜的短版導讀（boards.hf/gh/aa）仍在日報頁的「導讀（編輯）」段落，人工可改。
//
// 用法: bun run src/notion-relay.ts [--date YYYY-MM-DD] [--force] [--dry]
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot } from "./lib.ts";

const API = "https://api.notion.com/v1";
const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = argv.includes("--dry");
const force = argv.includes("--force");
const onlyDate = argOf("--date");
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

const DBs = Object.fromEntries(
  await Promise.all(
    (["hf", "gh", "aa"] as const).map(async (p) => {
      const f = join(ROOT, "..", "data", `notion_${p}.json`);
      const { db } = JSON.parse(await Bun.file(f).text()) as { db: string };
      return [p, db] as const;
    }),
  ),
) as Record<"hf" | "gh" | "aa", string>;

/** rich_text 分塊（每塊 1900 字），讀回時接起來 */
const chunks = (s: string) => {
  const out: unknown[] = [];
  for (let i = 0; i < s.length; i += 1900) out.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
  return { rich_text: out.length ? out : [{ type: "text", text: { content: "" } }] };
};

const dates = listSnapshots()
  .map((f) => f.replace(/\.json$/, ""))
  .filter((x) => !onlyDate || x === onlyDate);

let done = 0, skipped = 0, missing = 0;
for (const date of dates) {
  const snap = await readSnapshot(date);
  if (!snap) continue;
  const leadFile = join(ROOT, "data", "headlines", `${date}.json`);
  const headline = existsSync(leadFile)
    ? (JSON.parse(await Bun.file(leadFile).text()) as { by?: string; lead?: string[]; boards?: Record<string, string> })
    : null;

  for (const board of ["hf", "gh", "aa"] as const) {
    const b = snap.boards[board];
    if (!b) continue;
    const rows = await api("POST", `/databases/${DBs[board]}/query`, {
      filter: { property: "日期", date: { equals: date } },
      page_size: 5,
    });
    const page = (rows.results ?? []).find((r: any) => !r.archived);
    if (!page) {
      console.log(`  ⚠ ${date} ${board}：找不到日報列，跳過`);
      missing++;
      continue;
    }
    const had = (page.properties?.["榜單中繼"]?.rich_text ?? []).map((x: any) => x.plain_text).join("");
    if (had && !force) {
      skipped++;
      continue;
    }
    // 用「有這個鍵就寫、沒有就不寫」的規則：JSON.stringify 會丟掉 undefined，
    // 所以 events: [] （有但空）與完全沒有 events 在匯出時可以分辨。
    const relay = JSON.stringify({
      generatedAt: snap.generatedAt,
      notes: b.notes,
      events: b.events,
      // boards 一併存這裡：日報頁的段落會被 Notion 洗掉 <span class="em"> 之類的行內 HTML，
      // 而且官網不渲染 boards[]，所以以這份 JSON 為準；頁面段落是給人讀的鏡像。
      headlines: { by: headline?.by ?? "編輯", lead: headline?.lead ?? [], boards: headline?.boards },
    });
    if (dry) {
      console.log(`  [dry] ${date} ${board} relay ${relay.length} 字`);
      continue;
    }
    await api("PATCH", `/pages/${page.id}`, { properties: { 榜單中繼: chunks(relay) } });
    console.log(`  ✓ ${date} ${board} relay ${relay.length} 字`);
    done++;
  }
}

console.log(`\n${dry ? "（dry run）" : "✅"} 寫入 ${done}｜已存在 ${skipped}｜缺日報列 ${missing}`);