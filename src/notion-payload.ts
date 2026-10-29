// 快照 + 導讀 → Notion payload（給 scripts/notion_push.py --push --project trending）
// 用法: bun run src/notion-payload.ts [--date YYYY-MM-DD]
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { ROOT, readSnapshot, listSnapshots, formatZh, type Snapshot, type Board, type Item } from "./lib.ts";

const SITE = "https://snorlax-mrq.github.io/daily-trending";
const PAYLOAD_DIR = join(ROOT, "..", "data", "digest_out");

const date = (() => {
  const i = process.argv.indexOf("--date");
  return i > 0 ? process.argv[i + 1]! : listSnapshots().pop()!.replace(/\.json$/, "");
})();

const snap = await readSnapshot(date);
if (!snap) {
  console.error(`找不到 ${date} 的快照，先跑 src/collect.ts`);
  process.exit(1);
}

/** 前一日的同一個榜（沒有就 null） */
async function prevBoard(key: string): Promise<Board | null> {
  const prevDates = listSnapshots()
    .map((f) => f.replace(/\.json$/, ""))
    .filter((d) => d < date);
  for (let i = prevDates.length - 1; i >= 0; i--) {
    const s = await readSnapshot(prevDates[i]!);
    const b = s?.boards?.[key];
    if (b?.items?.length) return b;
  }
  return null;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
const num = (n: number | null | undefined) =>
  typeof n !== "number" ? "—" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);

async function deltaMark(key: string, it: Item): Promise<string> {
  const prev = await prevBoard(key);
  if (!prev) return "—";
  const before = prev.items.find((x) => x.id === it.id);
  if (!before) return "新";
  const d = before.rank - it.rank;
  return d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "＝";
}

// ── 三張表 ──
const KS: [string, string, string[]][] = [
  ["hf", "榜單 I · HuggingFace", ["#", "模型", "熱度", "漲跌", "下載／讚"]],
  ["gh", "榜單 II · GitHub", ["#", "專案", "今日 stars", "漲跌", "語言"]],
  ["aa", "榜單 III · Artificial Analysis", ["#", "模型", "II 分數", "漲跌", "$/M in·out"]],
];

const sections: Record<string, unknown>[] = [];

// 導讀
const leadFile = join(ROOT, "data", "headlines", `${date}.json`);
if (existsSync(leadFile)) {
  const lead = JSON.parse(await Bun.file(leadFile).text()) as { lead?: string[] };
  const paras = (lead.lead ?? []).map(strip).filter(Boolean);
  if (paras.length) sections.push({ heading: "導讀（編輯）", paragraphs: paras });
}

for (const [key, heading, columns] of KS) {
  const b = snap.boards[key];
  if (!b) continue;
  if (b.error || !b.items.length) {
    sections.push({ heading, paragraphs: [`⚠️ 今日未取得資料：${b.error ?? "空榜單"}`] });
    continue;
  }
  const rows: string[][] = [];
  for (const it of b.items) {
    const d = await deltaMark(key, it);
    if (key === "hf") rows.push([String(it.rank), it.name, num(it.metric), d, `${num(it.stats?.downloads as number)}／${num(it.stats?.likes as number)}`]);
    else if (key === "gh") rows.push([String(it.rank), it.name, num(it.metric), d, String(it.kicker ?? "—")]);
    else rows.push([String(it.rank), it.name, num(it.metric), d, `$${it.stats?.priceIn ?? "—"}·$${it.stats?.priceOut ?? "—"}`]);
  }
  sections.push({ heading, table: { columns, rows } });
  if (b.notes?.length) sections.push({ heading: `${heading} · 註記`, bullets: b.notes });
}

// AA 異動
const aa = snap.boards.aa;
const events = (aa?.events ?? []).filter((e, i, arr) => arr.findIndex((x) => x.kind === e.kind && x.text.slice(0, 22) === e.text.slice(0, 22)) === i);
if (events.length) {
  sections.push({
    heading: "Artificial Analysis 今日異動",
    bullets: events.map((e) => `${e.kind}：${e.url ? `[${e.text}](${e.url})` : e.text}`),
  });
}

// ── 屬性 ──
const top = (k: string) => snap.boards[k]?.items?.[0]?.name ?? "";
const champ = snap.boards.aa?.items?.[0];
const freshCount = await (async () => {
  let n = 0;
  for (const [key, b] of Object.entries(snap.boards)) {
    const prev = await prevBoard(key);
    if (!prev) continue;
    const before = new Set(prev.items.map((x) => x.id));
    n += b.items.filter((x) => !before.has(x.id)).length;
  }
  return n;
})();

const shortTop = (k: string) => {
  const n = top(k);
  return n.replace(/^(deepseek-ai|black-forest-labs|OpenMOSS-Team|meta-models)\//, "");
};

const title = `${date} · HF ${shortTop("hf") || "—"}／GH ${shortTop("gh") || "—"}／AA ${champ ? `${champ.name} ${num(champ.metric)}` : "—"}`;
const summary = [
  `HuggingFace 榜首 ${top("hf") || "—"}`,
  `GitHub 榜首 ${top("gh") || "—"}`,
  champ ? `Artificial Analysis 榜首 ${champ.name}（II ${num(champ.metric)}）` : "Artificial Analysis 無資料",
  `三榜合計新進 ${freshCount} 筆`,
].join("；");

const missing = Object.entries(snap.boards).filter(([, b]) => b.error).map(([, b]) => b.label);

const payload = {
  date,
  title,
  headline: missing.length
    ? `⚠️ ${formatZh(date)}　${missing.join("、")} 今日抓取失敗，其餘榜單正常。`
    : `${formatZh(date)}　三個來源的每日快照：${summary}`,
  url: `${SITE}/d/${date}.html`,
  props: {
    summary,
    topics: ["模型熱度", "開發者動態", "模型評測"],
    source: "trending",
    url: `${SITE}/d/${date}.html`,
    props_extra: {
      "榜首·HF": top("hf") || "—",
      "榜首·GitHub": top("gh") || "—",
      "榜首·AA": champ ? `${champ.name}（${num(champ.metric)}）` : "—",
      新進榜數: freshCount,
    },
  },
  sections,
};

mkdirSync(PAYLOAD_DIR, { recursive: true });
const out = join(PAYLOAD_DIR, `payload_trending_${date}.json`);
await Bun.write(out, JSON.stringify(payload, null, 2) + "\n");
console.log(`📄 ${out}`);
console.log(`   ${title}`);
console.log(`   ${sections.length} 個 section · 新進 ${freshCount} 筆${missing.length ? ` · 失敗來源：${missing.join("、")}` : ""}`);