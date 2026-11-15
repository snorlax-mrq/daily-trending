// Artificial Analysis — 官方 API 需金鑰（401），改解析 Next.js RSC payload
//   /leaderboards/models  → initialModels（分數／價格／速度）
//   /changelog            → initialData.data（模型收錄、供應商上架、文章、方法論）
//
// 2026-11-15 改版：頂層 slug 消失（搬到 release.slug）、速度欄 medianOutputTokensPerSecond
// 改名 outputSpeed、id 變 UUID，且同一 release 的多個 variant（Max/Xhigh/…）共用同一個
// release.slug，官網也把模型頁壓平成 release 頁（舊 per-variant 網址 308 轉址）。
// 自然鍵策略：沿用歷史的 per-variant slug —— 同名模型曾在歷史快照出現就沿用舊 id
//（保住 Notion 實體與漲跌連續性）；查不到才用 release.slug＋suffix 推導新鍵。
import { listSnapshots, readSnapshot, get, rscText, sliceArray, type Board, type Item } from "./lib.ts";
import { aaNote } from "./format.ts";

type Model = {
  slug?: string; // 舊版頂層 slug（改版前）；新版此欄是 UUID，不可當自然鍵
  id?: string; // 新版 UUID
  release?: { slug: string; name: string };
  suffix?: string | null; // 新版：variant 參數（如 "Xhigh, Default Fallback"）
  name: string;
  modelCreatorName?: string;
  deprecated?: boolean;
  isOpenWeights?: boolean;
  intelligenceIndex?: number | null;
  intelligenceIndexCostPerTask?: number | null;
  price1mInputTokens?: number | null;
  price1mOutputTokens?: number | null;
  medianOutputTokensPerSecond?: number | null; // 舊欄位
  outputSpeed?: number | null; // 2026-11-15 改版後
};

type Change = {
  id: string;
  type: string;
  dateLa: string;
  title?: string;
  subtitle?: string;
  slug?: string;
  model?: { slug?: string; release?: { slug: string }; name: string; intelligenceIndex?: number | null; creator?: { name: string } };
  host?: { name: string };
};

export type AaRaw = { models: (Model & { key: string })[]; changes: Change[] };

/** 歷史快照的「模型名稱 → 舊 id」對照（名稱含 variant、跨日穩定；同日重跑也適用） */
async function loadNameIds(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of listSnapshots()) {
    const s = await readSnapshot(f.replace(/\.json$/, ""));
    for (const it of s?.boards.aa?.items ?? []) {
      if (it.id && it.name) map.set(it.name, it.id);
    }
  }
  return map;
}

const kebab = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function resolveKey(m: Model, nameIds: Map<string, string>): string {
  if (m.slug) return m.slug; // 舊版欄位還在就直接用
  const bridged = nameIds.get(m.name);
  if (bridged) return bridged; // 曾在榜：沿用舊 id
  const base = m.release?.slug;
  if (!base) throw new Error(`AA 模型「${m.name}」無 slug 可用（版面又改了？）`);
  const eff = m.suffix ? kebab(m.suffix.split(",")[0] ?? "") : "";
  return eff ? `${base}-${eff}` : base;
}

export async function fetchAaRaw(): Promise<AaRaw> {
  const [lbHtml, chgHtml] = await Promise.all([get("https://artificialanalysis.ai/leaderboards/models"), get("https://artificialanalysis.ai/changelog")]);
  const models = JSON.parse(sliceArray(rscText(lbHtml), '"initialModels"') ?? "[]") as (Model & { key: string })[];
  if (!models.length) throw new Error("initialModels 解析失敗（AA 版面可能改版）");
  const nameIds = await loadNameIds();
  for (const m of models) m.key = resolveKey(m, nameIds);
  const changes = (JSON.parse(sliceArray(rscText(chgHtml), '"initialData":{"data"') ?? "[]") as Change[]).filter((c) => c && c.id);
  return { models, changes };
}

const one = (n?: number | null) => (typeof n === "number" ? n.toFixed(1) : "—");

export function buildAaBoard(raw: AaRaw, limit = 10, seenEventIds: Set<string> = new Set()): Board {
  const base: Board = { label: "Artificial Analysis", question: "哪個模型真的強、又划算", source: "artificialanalysis.ai（Intelligence Index）", items: [] };
  const scored = raw.models
    .filter((m) => !m.deprecated && typeof m.intelligenceIndex === "number")
    .sort((a, b) => (b.intelligenceIndex ?? 0) - (a.intelligenceIndex ?? 0));

  const items: Item[] = scored.slice(0, limit).map((m, i) => {
    const priceIn = m.price1mInputTokens ?? null;
    const priceOut = m.price1mOutputTokens ?? null;
    const tps = Math.round(m.outputSpeed ?? m.medianOutputTokensPerSecond ?? 0) || null;
    const openWeights = m.isOpenWeights ? 1 : 0;
    const releaseSlug = m.release?.slug ?? m.key; // 官網已壓平成 release 頁（per-variant 網址會 308 轉址）
    return {
    id: m.key,
    name: m.name,
    url: `https://artificialanalysis.ai/models/${releaseSlug}`,
    rank: i + 1,
    metric: m.intelligenceIndex ?? null,
    kicker: m.modelCreatorName ?? "—",
    note: aaNote({ priceIn, priceOut, tps, openWeights }),
    stats: {
      priceIn,
      priceOut,
      tps,
      costPerTask: typeof m.intelligenceIndexCostPerTask === "number" ? Number(m.intelligenceIndexCostPerTask.toFixed(3)) : null,
      openWeights,
    },
  };
  });

  // 當日事件：AA changelog 保留約 13 天，用 seen id 去重（只報第一次看到的）
  const ldates = [...new Set(raw.changes.map((c) => c.dateLa))].sort().reverse();
  const focus = new Set(ldates.slice(0, 2));
  const todays = raw.changes.filter((c) => focus.has(c.dateLa) && !seenEventIds.has(c.id));
  const events: Board["events"] = [];
  for (const c of todays.filter((x) => x.type === "articlePublished").slice(0, 4)) {
    events.push({ kind: "文章", text: c.title ?? "", url: `https://artificialanalysis.ai/articles/${c.slug}` });
  }
  for (const c of todays.filter((x) => x.type === "modelAdded").slice(0, 8)) {
    const m = c.model!;
    events.push({ kind: "新模型", text: `${m.name}（${m.creator?.name ?? "?"}）${typeof m.intelligenceIndex === "number" ? ` · II ${one(m.intelligenceIndex)}` : ""}`, url: `https://artificialanalysis.ai/models/${m.release?.slug ?? m.slug}` });
  }
  const hosts = todays.filter((x) => x.type === "hostModelAdded" && x.host?.name !== x.model?.creator?.name);
  const byHost = new Map<string, number>();
  for (const h of hosts) byHost.set(h.host!.name, (byHost.get(h.host!.name) ?? 0) + 1);
  for (const [host, n] of byHost) events.push({ kind: "供應商", text: `${host} 新增 ${n} 個模型上架` });
  for (const m of todays.filter((x) => x.type === "methodologyUpdated")) events.push({ kind: "方法論", text: `${m.title ?? ""}${m.version && !(m.title ?? "").includes(m.version) ? ` v${m.version}` : ""}` });

  const total = raw.models.length;
  const scoredCount = scored.length;
  const method = [...raw.changes].reverse().find((c) => c.type === "methodologyUpdated");
  const notes = method
    ? [`${method.title ?? "Intelligence Index"} 於 ${method.dateLa} 上線：${total} 筆條目中僅 ${scoredCount} 筆已評分，榜單仍在遷移，名次會劇烈變動。`]
    : [`${total} 筆條目中僅 ${scoredCount} 筆已評分。`];
  return { ...base, items, events, notes };
}

export const aaEventIds = (raw: AaRaw): string[] => raw.changes.map((c) => c.id);