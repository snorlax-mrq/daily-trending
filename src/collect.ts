// 收集三個榜單 → data/snapshots/YYYY-MM-DD.json（單一真相）
// 用法: bun run src/collect.ts [--date YYYY-MM-DD]
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ROOT, today, writeSnapshot, readSnapshot, listSnapshots, type Snapshot } from "./lib.ts";
import { fetchHf } from "./fetch-hf.ts";
import { fetchGh } from "./fetch-gh.ts";
import { fetchAaRaw, buildAaBoard, aaEventIds } from "./fetch-aa.ts";

const SEEN = join(ROOT, "data", "seen-aa-events.json");

const argDate = (() => {
  const i = process.argv.indexOf("--date");
  return i > 0 ? process.argv[i + 1] : undefined;
})();
const date = argDate ?? today();

const seen: string[] = existsSync(SEEN) ? (JSON.parse(await Bun.file(SEEN).text()) as { ids: string[] }).ids : [];
const seenSet = new Set(seen);

// 三來源並行；任一失敗只讓該榜空白，不擋其他榜
const [hf, gh, aaRaw] = await Promise.all([
  fetchHf(10),
  fetchGh(25),
  fetchAaRaw().catch((e: Error) => e),
]);

const boards: Snapshot["boards"] = { hf, gh };
if (aaRaw instanceof Error) {
  boards.aa = { label: "Artificial Analysis", question: "哪個模型真的強、又划算", source: "artificialanalysis.ai", items: [], error: aaRaw.message };
} else {
  boards.aa = buildAaBoard(aaRaw, 10, seenSet);
}

// 同日重跑：新抓的 events 會被 seen 去重清空，保留既有快照裡已記錄的事件（union by text）
const prior = await readSnapshot(date);
for (const [key, b] of Object.entries(boards)) {
  const old = prior?.boards?.[key]?.events;
  if (!old?.length) continue;
  const fresh = b.events ?? [];
  const have = new Set(fresh.map((e) => e.text));
  b.events = [...fresh, ...old.filter((e) => !have.has(e.text))];
}

const snap: Snapshot = { date, generatedAt: new Date().toISOString(), boards };
const path = await writeSnapshot(snap);

// AA 事件去重：只記錄已回報過的（保留最近 800 筆）
if (!(aaRaw instanceof Error)) {
  const next = [...new Set([...aaEventIds(aaRaw), ...seen])].slice(0, 800);
  await Bun.write(SEEN, JSON.stringify({ ids: next }, null, 1) + "\n");
}

// 摘要
const prevDate = listSnapshots().filter((f) => f < `${date}.json`).pop()?.replace(/\.json$/, "");
const prev = prevDate ? await readSnapshot(prevDate) : null;

console.log(`📸 ${date} → ${path}`);
for (const [key, b] of Object.entries(boards)) {
  const p = prev?.boards[key]?.items.length;
  console.log(`  ${key.padEnd(3)} ${b.error ? `❌ ${b.error}` : `${String(b.items.length).padStart(2)} 筆${prevDate ? `（前次 ${prevDate} ${p ?? 0} 筆）` : ""}`}${b.events?.length ? ` · ${b.events.length} 則事件` : ""}`);
}
const failed = Object.entries(boards).filter(([, b]) => b.error);
if (failed.length) console.error(`⚠️ 失敗來源：${failed.map(([k, b]) => `${k}（${b.error}）`).join("、")}`);