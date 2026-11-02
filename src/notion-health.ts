// Notion ↔ 本機的健檢（每週跑一次，抓「安靜壞掉」的情況）
// 檢查項目：
//   1. 列數對帳：每日名次 vs 本機快照 items；實體表 vs 去重後的項目數
//   2. 重複列：同一個「榜單×日期×名次」不該有兩列
//   3. 覆蓋率：最近 N 天每天都要有三個榜的觀測
//   4. 中繼：最近 N 天的日報列都要有「榜單中繼」
//   5. 視圖：每個視圖的 total_count 要等於它該有的筆數
//   6. 匯出回歸：Notion → 快照 JSON 與本機逐欄比較，必須 0 處不同
//   7. 快取一致：data/notion_obs.json 的 key 要覆蓋本機所有 item
//
// 用法: bun run src/notion-health.ts [--days 7] [--quiet]
// 退出碼：0＝全部通過；1＝有問題（cron 會把報告貼出來）
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot } from "./lib.ts";

const VER_OLD = "2022-06-28";
const VER_NEW = "2026-03-11";
const API = "https://api.notion.com/v1";
const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const quiet = argv.includes("--quiet");
const days = Number(argOf("--days") ?? 7);

const token = process.env.NOTION_API_KEY ?? "";
if (!token) throw new Error("需要 NOTION_API_KEY 環境變數");
const DB = JSON.parse(await Bun.file(join(ROOT, "data", "notion_items_db.json")).text()) as { hf: string; gh: string; aa: string; obs: string };

let last = 0;
async function api<T = any>(method: string, path: string, body?: unknown, ver = VER_OLD): Promise<T> {
  const wait = last + 340 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  last = Date.now();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": ver, "content-type": "application/json" },
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

async function queryAll(db: string, ver = VER_OLD): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const q = await api("POST", `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, ver);
    out.push(...(q.results ?? []).filter((r: any) => !r.archived));
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── 本機期望值 ────────────────────────────────────
const dates = listSnapshots().map((f) => f.replace(/\.json$/, ""));
const snaps = new Map<string, any>();
for (const d of dates) {
  const s = await readSnapshot(d);
  if (s) snaps.set(d, s);
}
const recent = dates.slice(-days);

type Expect = { items: number; perBoard: Record<string, number>; perDay: Record<string, number>; entities: Record<string, number> };
const expect: Expect = { items: 0, perBoard: { hf: 0, gh: 0, aa: 0 }, perDay: {}, entities: { hf: 0, gh: 0, aa: 0 } };
const ids: Record<string, Set<string>> = { hf: new Set(), gh: new Set(), aa: new Set() };
for (const [d, s] of snaps) {
  let n = 0;
  for (const b of ["hf", "gh", "aa"]) {
    for (const it of s.boards?.[b]?.items ?? []) {
      expect.perBoard[b]++;
      ids[b]!.add(it.id);
      n++;
    }
  }
  expect.perDay[d] = n;
  expect.items += n;
}
for (const b of ["hf", "gh", "aa"]) expect.entities[b] = ids[b]!.size;

// ── 1/2. 列數與重複 ───────────────────────────────
const problems: string[] = [];
const notes: string[] = [];

const obsRows = await queryAll(DB.obs);
const obsByBoard: Record<string, number> = { HF: 0, GitHub: 0, AA: 0 };
const seenKey = new Map<string, number>();
for (const r of obsRows) {
  const p = r.properties;
  const board = p["榜單"]?.select?.name ?? "?";
  const date = p["日期"]?.date?.start ?? "?";
  const rank = p["名次"]?.number ?? "?";
  obsByBoard[board] = (obsByBoard[board] ?? 0) + 1;
  const k = `${date}|${board}|${rank}`;
  seenKey.set(k, (seenKey.get(k) ?? 0) + 1);
}
const dups = [...seenKey.entries()].filter(([, v]) => v > 1);

if (obsRows.length !== expect.items) problems.push(`每日名次 ${obsRows.length} 列 ≠ 本機 ${expect.items} 筆`);
if (obsByBoard.HF !== expect.perBoard.hf) problems.push(`HF 觀測 ${obsByBoard.HF} ≠ ${expect.perBoard.hf}`);
if (obsByBoard.GitHub !== expect.perBoard.gh) problems.push(`GitHub 觀測 ${obsByBoard.GitHub} ≠ ${expect.perBoard.gh}`);
if (obsByBoard.AA !== expect.perBoard.aa) problems.push(`AA 觀測 ${obsByBoard.AA} ≠ ${expect.perBoard.aa}`);
if (dups.length) problems.push(`重複列 ${dups.length} 組（例：${dups[0]![0]}）`);

// ── 3. 覆蓋率：最近 N 天 ───────────────────────────
for (const d of recent) {
  const have = obsRows.filter((r) => r.properties["日期"]?.date?.start === d).length;
  const want = expect.perDay[d] ?? 0;
  if (have !== want) problems.push(`${d} 觀測 ${have} 筆 ≠ 本機 ${want} 筆`);
}

// ── 4. 中繼屬性 ───────────────────────────────────
const relayMissing: string[] = [];
for (const board of ["hf", "gh", "aa"] as const) {
  const f = join(ROOT, "..", "data", `notion_${board}.json`);
  if (!existsSync(f)) continue;
  const { db } = JSON.parse(await Bun.file(f).text()) as { db: string };
  for (const row of await queryAll(db)) {
    const date = row.properties["日期"]?.date?.start;
    if (!date || !recent.includes(date)) continue;
    const relay = (row.properties["榜單中繼"]?.rich_text ?? []).map((x: any) => x.plain_text).join("");
    if (!relay) relayMissing.push(`${date} ${board}`);
  }
}
if (relayMissing.length) problems.push(`榜單中繼缺漏 ${relayMissing.length} 筆（${relayMissing.slice(0, 3).join("、")}${relayMissing.length > 3 ? "…" : ""}）`);

// ── 5. 視圖筆數 ───────────────────────────────────
const VIEW_EXPECT: Record<string, Record<string, number>> = {
  hf: { "參數 100B 以上": [...ids.hf!].length ? -1 : 0, 授權一覽: expect.entities.hf },
  gh: { 依語言: expect.entities.gh, 在榜最久: expect.entities.gh },
  aa: { 依開發商: expect.entities.aa },
  obs: {
    "HF 榜": expect.perBoard.hf,
    "GitHub 榜": expect.perBoard.gh,
    "AA 榜": expect.perBoard.aa,
    "HF 單日熱度排行": expect.perBoard.hf,
    "GitHub 單日 stars 排行": expect.perBoard.gh,
    "AA 單日 II 排行": expect.perBoard.aa,
    每日收錄筆數: expect.items,
  },
};
const viewReport: string[] = [];
for (const dbKey of ["hf", "gh", "aa", "obs"] as const) {
  const listed = await api("GET", `/views?database_id=${DB[dbKey]}`, undefined, VER_NEW);
  for (const ref of listed.results ?? []) {
    const v = await api("GET", `/views/${ref.id}`, undefined, VER_NEW);
    const want = VIEW_EXPECT[dbKey]?.[v.name];
    if (want === undefined || want < 0) continue;
    const q = await api("POST", `/views/${ref.id}/queries`, {}, VER_NEW);
    const total = q.total_count ?? (q.results ?? []).length;
    if (q.id) await api("DELETE", `/views/queries/${q.id}`, undefined, VER_NEW).catch(() => {});
    if (total !== want) problems.push(`視圖「${v.name}」${total} 筆 ≠ ${want}`);
    viewReport.push(`${v.name} ${total}`);
  }
}

// ── 6. 匯出回歸（最近的日期抽驗，省時間）─────────────
const { execSync } = await import("node:child_process");
let diffOut = "";
try {
  diffOut = execSync(`bun run src/notion-export.ts --date ${recent[recent.length - 1]}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  diffOut = String((e as any).stdout ?? "") + String((e as any).stderr ?? "");
}
const mismatch = /✗ (\d+) 處不同/.exec(diffOut);
if (mismatch) problems.push(`匯出回歸 ${recent[recent.length - 1]} 有 ${mismatch[1]} 處不同`);

// ── 7. 快取一致 ───────────────────────────────────
const obsFile = join(ROOT, "data", "notion_obs.json");
if (existsSync(obsFile)) {
  const map = JSON.parse(await Bun.file(obsFile).text()) as Record<string, string>;
  const missing = [...snaps.entries()].flatMap(([d, s]) =>
    ["hf", "gh", "aa"].flatMap((b) => ((s.boards?.[b]?.items ?? []) as any[]).map((it) => `${d}|${b}|${it.id}`)),
  ).filter((k) => !map[k]);
  if (missing.length) problems.push(`觀測快取缺 ${missing.length} 筆（重跑 notion-items 即可補）`);
  if (Object.keys(map).length !== expect.items) problems.push(`觀測快取 ${Object.keys(map).length} 筆 ≠ 本機 ${expect.items}`);
}

// ── 報告 ─────────────────────────────────────────
const lastDate = dates[dates.length - 1];
const lines: string[] = [];
lines.push(`Notion 健檢 ${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })}`);
lines.push(`快照 ${dates.length} 天（${dates[0]} ~ ${lastDate}）｜項目 ${expect.items} 筆`);
lines.push(`每日名次 ${obsRows.length}　HF ${obsByBoard.HF}／GitHub ${obsByBoard.GitHub}／AA ${obsByBoard.AA}`);
lines.push(`實體 HF ${expect.entities.hf}／GitHub ${expect.entities.gh}／AA ${expect.entities.aa}`);
if (viewReport.length) lines.push(`視圖 ${viewReport.length} 個核對完成`);
if (problems.length) {
  lines.push("");
  lines.push(`⚠️ ${problems.length} 個問題`);
  for (const p of problems) lines.push(`- ${p}`);
} else {
  lines.push("");
  lines.push("✅ 全部通過（列數、重複、覆蓋率、中繼、視圖、匯出回歸、快取）");
}

const report = lines.join("\n");
if (!quiet || problems.length) console.log(report);
else console.log("✅ 全部通過");
if (problems.length) process.exitCode = 1;