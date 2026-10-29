// Artificial Analysis — 官方 API 需金鑰（401），改解析 Next.js RSC payload
//   /leaderboards/models  → initialModels（分數／價格／速度）
//   /changelog            → initialData.data（模型收錄、供應商上架、文章、方法論）
import { get, rscText, sliceArray, type Board, type Item } from "./lib.ts";

type Model = {
  slug: string;
  name: string;
  modelCreatorName?: string;
  deprecated?: boolean;
  isOpenWeights?: boolean;
  intelligenceIndex?: number | null;
  intelligenceIndexCostPerTask?: number | null;
  price1mInputTokens?: number | null;
  price1mOutputTokens?: number | null;
  medianOutputTokensPerSecond?: number | null;
};

type Change = {
  id: string;
  type: string;
  dateLa: string;
  title?: string;
  subtitle?: string;
  slug?: string;
  model?: { slug: string; name: string; intelligenceIndex?: number | null; creator?: { name: string } };
  host?: { name: string };
};

export type AaRaw = { models: Model[]; changes: Change[] };

export async function fetchAaRaw(): Promise<AaRaw> {
  const [lbHtml, chgHtml] = await Promise.all([get("https://artificialanalysis.ai/leaderboards/models"), get("https://artificialanalysis.ai/changelog")]);
  const models = JSON.parse(sliceArray(rscText(lbHtml), '"initialModels"') ?? "[]") as Model[];
  if (!models.length) throw new Error("initialModels 解析失敗（AA 版面可能改版）");
  const changes = (JSON.parse(sliceArray(rscText(chgHtml), '"initialData":{"data"') ?? "[]") as Change[]).filter((c) => c && c.id);
  return { models, changes };
}

const one = (n?: number | null) => (typeof n === "number" ? n.toFixed(1) : "—");

export function buildAaBoard(raw: AaRaw, limit = 10, seenEventIds: Set<string> = new Set()): Board {
  const base: Board = { label: "Artificial Analysis", question: "哪個模型真的強、又划算", source: "artificialanalysis.ai（Intelligence Index）", items: [] };
  const scored = raw.models
    .filter((m) => !m.deprecated && typeof m.intelligenceIndex === "number")
    .sort((a, b) => (b.intelligenceIndex ?? 0) - (a.intelligenceIndex ?? 0));

  const items: Item[] = scored.slice(0, limit).map((m, i) => ({
    id: m.slug,
    name: m.name,
    url: `https://artificialanalysis.ai/models/${m.slug}`,
    rank: i + 1,
    metric: m.intelligenceIndex ?? null,
    kicker: m.modelCreatorName ?? "—",
    note: `$${m.price1mInputTokens ?? "—"} / $${m.price1mOutputTokens ?? "—"} 每百萬 token · ${Math.round(m.medianOutputTokensPerSecond ?? 0) || "—"} tok/s${m.isOpenWeights ? " · 開放權重" : ""}`,
    stats: {
      priceIn: m.price1mInputTokens ?? null,
      priceOut: m.price1mOutputTokens ?? null,
      tps: Math.round(m.medianOutputTokensPerSecond ?? 0) || null,
      costPerTask: typeof m.intelligenceIndexCostPerTask === "number" ? Number(m.intelligenceIndexCostPerTask.toFixed(3)) : null,
      openWeights: m.isOpenWeights ? 1 : 0,
    },
  }));

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
    events.push({ kind: "新模型", text: `${m.name}（${m.creator?.name ?? "?"}）${typeof m.intelligenceIndex === "number" ? ` · II ${one(m.intelligenceIndex)}` : ""}`, url: `https://artificialanalysis.ai/models/${m.slug}` });
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