// 一次性：把 hf-trending/reports/*.md 的舊日報匯入成 snapshots（只有 hf 榜）
// 用途：讓新站上線第一天就有 HF 的 8 天歷史，走勢圖與名次變化不是空的。
// 用法: bun run src/import-hf-history.ts
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { ROOT, SNAP_DIR, writeSnapshot, readSnapshot, type Board, type Item } from "./lib.ts";

const REPORT_DIR = join(ROOT, "..", "hf-trending", "reports");
const TAG_ZH: Record<string, string> = {
  "文字生成": "文字生成", "多模態理解": "多模態理解",
};

if (!existsSync(REPORT_DIR)) {
  console.error("找不到 hf-trending/reports");
  process.exit(1);
}

const files = readdirSync(REPORT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
let n = 0;
for (const f of files) {
  const date = f.replace(/\.md$/, "");
  const existing = await readSnapshot(date);
  if (existing?.boards?.hf?.items?.length) continue; // 已有真實快照，不覆蓋
  const text = await Bun.file(join(REPORT_DIR, f)).text();
  const items: Item[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\*\*(\d+)\. (?:🆕|▲\d+|▼\d+|＝) \[([^\]]+)\]\(([^)]+)\)\*\*\s*—\s*(.+)$/);
    if (!m) continue;
    const rank = Number(m[1]);
    const id = m[2]!;
    const url = m[3]!;
    const tag = m[4]!.trim();
    const nums = line.match(/🔥 ([\d.]+[KM]?|—) · ⬇️ ([\d.]+[KM]?|—) · ❤️ ([\d.]+[KM]?|—)/);
    const parseK = (s?: string) => {
      if (!s || s === "—") return null;
      const v = parseFloat(s);
      return s.endsWith("M") ? Math.round(v * 1_000_000) : s.endsWith("K") ? Math.round(v * 1_000) : Math.round(v);
    };
    items.push({
      id,
      name: id,
      url,
      rank,
      metric: parseK(nums?.[1]),
      kicker: tag,
      note: "",
      stats: { downloads: parseK(nums?.[2]), likes: parseK(nums?.[3]), tag },
    });
  }
  if (!items.length) continue;
  const board: Board = { label: "HuggingFace", question: "哪個開源模型正在紅", source: "huggingface.co/api（trendingScore）", items };
  await writeSnapshot({ date, generatedAt: `${date}T00:00:00.000Z`, boards: { hf: board } });
  n++;
  console.log(`  ${date}  ${items.length} 筆`);
}
console.log(`匯入 ${n} 天 HF 歷史（共 ${files.length} 份日報）`);
