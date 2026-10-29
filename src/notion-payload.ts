// 快照 + 導讀 → Notion payload（分榜輸出，一天一列／一榜一 DB）
// 用法:
//   bun run src/notion-payload.ts --board hf [--date YYYY-MM-DD]
//   bun run src/notion-payload.ts --all                # 三個榜都產
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { ROOT, readSnapshot, listSnapshots, formatZh, type Snapshot, type Board, type Item } from "./lib.ts";

const SITE = "https://snorlax-mrq.github.io/daily-trending";
const PAYLOAD_DIR = join(ROOT, "..", "data", "digest_out");
const BOARDS = ["hf", "gh", "aa"] as const;
type BoardKey = (typeof BOARDS)[number];

const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

const date = argOf("--date") ?? listSnapshots().pop()!.replace(/\.json$/, "");
const wanted: BoardKey[] = argv.includes("--all")
  ? [...BOARDS]
  : ([argOf("--board") ?? "all"] as string[]).flatMap((b) => (b === "all" ? [...BOARDS] : (BOARDS.includes(b as BoardKey) ? [b as BoardKey] : [])));

if (!wanted.length) {
  console.error("--board 只接受 hf / gh / aa（或 --all）");
  process.exit(1);
}

const snap = await readSnapshot(date);
if (!snap) {
  console.error(`找不到 ${date} 的快照，先跑 src/collect.ts`);
  process.exit(1);
}

/** 導讀：新格式 boards.{kv} 優先，舊格式（只有 lead 陣列）按 0=AA／1=HF／2=GitHub 對應 */
const leadFile = join(ROOT, "data", "headlines", `${date}.json`);
const headline = existsSync(leadFile)
  ? (JSON.parse(await Bun.file(leadFile).text()) as {
      by?: string;
      lead?: string[];
      boards?: Partial<Record<BoardKey, string>>;
    })
  : null;
const legacyMap: Record<BoardKey, number> = { aa: 0, hf: 1, gh: 2 };
const leadFor = (k: BoardKey): string[] => {
  const b = headline?.boards?.[k];
  if (b) return [b];
  const legacy = headline?.lead?.[legacyMap[k]];
  return legacy ? [legacy] : [];
};

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
const num = (n: unknown) =>
  typeof n !== "number" ? "—" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10);

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

const MARK: Record<BoardKey, { columns: string[]; label: string; extra: string }> = {
  hf: { columns: ["#", "模型", "熱度", "漲跌", "下載／讚", "發布"], label: "HuggingFace 模型熱度", extra: "下載／讚" },
  gh: { columns: ["#", "專案", "今日 stars", "漲跌", "語言", "總 stars"], label: "GitHub 專案熱度", extra: "語言" },
  aa: { columns: ["#", "模型", "II 分數", "漲跌", "$/M in·out", "tok/s"], label: "Artificial Analysis 模型評測", extra: "$/M" },
};

async function buildPayload(key: BoardKey, date: string): Promise<{ payload: Record<string, unknown>; out: string } | null> {
  const b = snap!.boards[key];
  if (!b) return null;

  const prev = await prevBoard(key);
  const before = new Map((prev?.items ?? []).map((x) => [x.id, x.rank]));
  const delta = (it: Item) => {
    if (!prev) return "—";
    const r = before.get(it.id);
    if (r === undefined) return "新";
    const d = r - it.rank;
    return d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "＝";
  };
  // 沒有前一日可比 → 新進榜數無意義，留 undefined（不要寫 0）
  const fresh = prev ? b.items.filter((x) => !before.has(x.id)) : [];
  const freshCount = prev ? fresh.length : undefined;
  const newModels = (b.events ?? []).filter((e) => e.kind === "新模型").length;
  const top = b.items[0];
  const lead = leadFor(key).map(strip).filter(Boolean);

  // 表格
  const rows = b.items.map((it) => {
    const d = delta(it);
    if (key === "hf") return [String(it.rank), it.name, num(it.metric), d, `${num(it.stats?.downloads)}／${num(it.stats?.likes)}`, String(it.kicker ?? "—")];
    if (key === "gh") return [String(it.rank), it.name, num(it.metric), d, String(it.kicker ?? "—"), num(it.stats?.stars)];
    return [String(it.rank), it.name, num(it.metric), d, `$${it.stats?.priceIn ?? "—"}·$${it.stats?.priceOut ?? "—"}`, num(it.stats?.tps)];
  });

  const sections: Record<string, unknown>[] = [];
  if (lead.length) sections.push({ heading: "導讀（編輯）", paragraphs: lead });
  if (b.error || !b.items.length) {
    sections.push({ heading: MARK[key].label, paragraphs: [`⚠️ 今日未取得資料：${b.error ?? "空榜單"}`] });
  } else {
    sections.push({ heading: MARK[key].label, table: { columns: MARK[key].columns, rows } });
    const bullets = [
      prev
        ? `今日 ${b.items.length} 筆；新進榜 ${fresh.length} 筆${fresh.length ? `（${fresh.slice(0, 4).map((x) => x.name).join("、")}${fresh.length > 4 ? "…" : ""}）` : ""}。`
        : `今日 ${b.items.length} 筆；本站首次記錄此榜，尚無前一日可比較，明日起才會出現漲跌與新進榜。`,
      ...(b.notes ?? []),
    ];
    sections.push({ heading: "註記", bullets });
  }
  // AA 的當日異動（文章／新收錄／第三方上架／方法論）
  const ev = (b.events ?? []).filter((e, i, arr) => arr.findIndex((x) => x.kind === e.kind && x.text.slice(0, 22) === e.text.slice(0, 22)) === i);
  if (ev.length) sections.push({ heading: "今日異動", bullets: ev.map((e) => `${e.kind} · ${e.url ? `[${e.text}](${e.url})` : e.text}`) });

  const url = `${SITE}/d/${date}.html`;
  const props_extra: Record<string, unknown> = { 新進榜數: freshCount };
  let title: string;
  let summary: string;

  if (key === "hf") {
    const streak = (await (async () => {
      let n = 0;
      const ds = listSnapshots().map((f) => f.replace(/\.json$/, "")).filter((d) => d <= date).reverse();
      for (const d of ds) {
        const s = await readSnapshot(d);
        if (s?.boards.hf?.items?.[0]?.id === top?.id) n++;
        else break;
      }
      return n;
    })());
    title = `${date} · ${top ? `${top.name} 第 ${streak} 日在榜` : "無資料"}${freshCount ? ` · 新進 ${freshCount} 款` : freshCount === 0 ? " · 無新進榜" : ""}`;
    summary = top
      ? `冠軍 ${top.name}（熱度 ${num(top.metric)}，連續第 ${streak} 日）；${freshCount === undefined ? "首日記錄，無從比較新進榜。" : `今日新進榜 ${freshCount} 款。`}`
      : "今日未取得 HuggingFace 榜單。";
    Object.assign(props_extra, {
      冠軍模型: top?.name ?? "—",
      熱度: typeof top?.metric === "number" ? Math.round(top.metric) : undefined,
      下載: typeof top?.stats?.downloads === "number" ? top.stats.downloads : undefined,
      讚: typeof top?.stats?.likes === "number" ? Math.round(top.stats.likes as number) : undefined,
    });
  } else if (key === "gh") {
    title = `${date} · ${top ? `${top.name} 居首（${num(top.metric)} stars/day）` : "無資料"}${freshCount ? ` · 新進 ${freshCount} 筆` : ""}`;
    summary = top
      ? `榜首 ${top.name}（今日新增 ${num(top.metric)} stars）；${freshCount === undefined ? "首日記錄" : `新進榜 ${freshCount} 筆`}；${b.items.length} 筆入榜。`
      : "今日未取得 GitHub trending。";
    Object.assign(props_extra, {
      榜首專案: top?.name ?? "—",
      "今日 stars": typeof top?.metric === "number" ? Math.round(top.metric) : undefined,
      語言: String(top?.kicker ?? "—"),
    });
  } else {
    title = `${date} · ${top ? `${top.name} 居首（II ${num(top.metric)}）` : "無資料"}${newModels ? ` · 新收錄 ${newModels} 款` : ""}`;
    summary = top
      ? `Intelligence Index 榜首 ${top.name}（${num(top.metric)}）；${newModels ? `今日新收錄 ${newModels} 款模型` : "今日無新收錄模型"}。`
      : "今日未取得 Artificial Analysis 資料。";
    Object.assign(props_extra, {
      榜首模型: top?.name ?? "—",
      "II 分數": typeof top?.metric === "number" ? Math.round(top.metric * 10) / 10 : undefined,
      新進榜數: newModels || undefined,
    });
  }

  for (const k of Object.keys(props_extra)) if (props_extra[k] === undefined) delete props_extra[k];

  const payload = {
    date,
    title,
    headline: "",
    url,
    props: {
      summary,
      topics: [MARK[key].label],
      source: key === "hf" ? "HF API" : key === "gh" ? "GitHub trending" : "artificialanalysis.ai",
      url,
      props_extra,
    },
    sections,
  };

  mkdirSync(PAYLOAD_DIR, { recursive: true });
  const out = join(PAYLOAD_DIR, `payload_trending_${key}_${date}.json`);
  await Bun.write(out, JSON.stringify(payload, null, 2) + "\n");
  return { payload, out };
}

for (const key of wanted) {
  const r = await buildPayload(key, date);
  if (!r) {
    console.log(`↷ ${key}：快照沒有這個榜，跳過`);
    continue;
  }
  console.log(`📄 ${key} → ${r.out}`);
  console.log(`   ${r.payload.title}`);
}