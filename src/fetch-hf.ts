// HuggingFace Trending — 官方 JSON API（sort=trendingScore）
// 一次 list call 用 expand[] 多帶 safetensors（參數量）、tags（授權／語言／量化）、
// downloadsAllTime、lastModified；實測 payload 15.2KB → 16.7KB，不必逐筆打 detail API。
import { get, today, type Board, type Item } from "./lib.ts";

const FIELDS = [
  "safetensors",
  "downloadsAllTime",
  "lastModified",
  "tags",
  "pipeline_tag",
  "library_name",
  "createdAt",
  "likes",
  "downloads",
  "trendingScore",
];

function apiUrl(limit: number): string {
  const q = new URLSearchParams({ sort: "trendingScore", limit: String(limit) });
  for (const f of FIELDS) q.append("expand[]", f);
  return `https://huggingface.co/api/models?${q.toString()}`;
}

// 衍生字串與對照表集中在 src/format.ts（網站、抓取、Notion 匯出共用同一份規則）
import { fmtNum, fmtParams, specStats, hfKicker, hfNote, PARAMS_NOTE, type SpecStats } from "./format.ts";
export { fmtNum, fmtParams, specStats, PARAMS_NOTE, type SpecStats };

type Model = {
  id: string;
  modelId?: string;
  trendingScore?: number;
  downloads?: number;
  downloadsAllTime?: number;
  likes?: number;
  pipeline_tag?: string | null;
  library_name?: string;
  createdAt?: string;
  lastModified?: string;
  tags?: string[];
  safetensors?: { parameters?: Record<string, number>; total?: number } | null;
};

export async function fetchHf(limit = 10): Promise<Board> {
  const base: Board = {
    label: "HuggingFace",
    question: "哪個開源模型正在紅",
    source: "huggingface.co/api（trendingScore）",
    items: [],
    notes: [PARAMS_NOTE],
  };
  try {
    const models = JSON.parse(await get(apiUrl(Math.max(limit, 25)))) as Model[];
    if (!Array.isArray(models) || !models.length) throw new Error("HF API 回傳空陣列");
    const items: Item[] = models.slice(0, limit).map((m, i) => {
      const id = m.modelId ?? m.id;
      const tag = hfKicker(m.pipeline_tag);
      const extra = hfNote({ downloads: m.downloads ?? 0, likes: m.likes ?? 0, createdAt: m.createdAt });

      return {
        id,
        name: id,
        url: `https://huggingface.co/${id}`,
        rank: i + 1,
        metric: m.trendingScore ?? null,
        kicker: tag,
        note: extra,
        stats: {
          downloads: m.downloads ?? null,
          downloadsAllTime: m.downloadsAllTime ?? null,
          likes: m.likes ?? null,
          tag,
          pipeline: m.pipeline_tag ?? null,
          library: m.library_name ?? null,
          createdAt: m.createdAt ?? null,
          lastModified: m.lastModified ?? null,
          ...specStats(m),
        },
      };
    });
    return { ...base, items };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

if (import.meta.main) {
  const b = await fetchHf();
  console.log(today(), b.items.length, b.error ?? "");
  for (const it of b.items) console.log(`${String(it.rank).padStart(2)} ${(it.stats?.paramsText as string).padStart(6)}  ${it.id}`);
  console.log("\n明細範例:", b.items[0]?.stats);
}
