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

const TAG_ZH: Record<string, string> = {
  "text-generation": "文字生成",
  "image-text-to-text": "多模態理解",
  "video-text-to-text": "影片理解",
  "text-to-image": "文生圖",
  "image-to-image": "圖像生成／編輯",
  "image-to-video": "圖生影片",
  "video-to-video": "影片編輯",
  "text-to-3d": "3D 生成",
  "image-to-3d": "3D 生成",
  "text-ranking": "排序／重排",
  "text-to-video": "影片生成",
  "text-to-speech": "語音合成",
  "text-to-audio": "音訊生成",
  "automatic-speech-recognition": "語音辨識",
  "feature-extraction": "向量嵌入",
  "text-classification": "文字分類",
  "image-classification": "影像分類",
  "object-detection": "物件偵測",
  "mask-generation": "影像分割",
  translation: "翻譯",
  summarization: "摘要",
  "question-answering": "問答",
  "any-to-any": "任意模態",
  robotics: "機器人",
};

const LICENSE_ZH: Record<string, string> = {
  mit: "MIT",
  "apache-2.0": "Apache-2.0",
  "bsd-3-clause": "BSD-3",
  other: "自訂",
  "cc-by-nc-4.0": "CC BY-NC 4.0",
  "cc-by-4.0": "CC BY 4.0",
  openrail: "OpenRAIL",
  gemma: "Gemma",
  llama2: "Llama 2",
  llama3: "Llama 3",
  "llama3.1": "Llama 3.1",
  "llama3.2": "Llama 3.2",
  "llama3.3": "Llama 3.3",
  "llama4": "Llama 4",
};

/** 常見 ISO 639-1 語言碼（HF 的 language tag 用這個） */
const LANGS = new Set(
  ("en zh ja ko fr de es pt it ru ar hi th vi id ms tr pl nl sv da fi no cs sk hu ro bg el he fa uk " +
    "bn ta te ml kn gu mr pa ur sw af az ka hy kk mn ne si sq sr hr sl lt lv et is ga cy eu ca gl " +
    "tl my km lo bo ps ku so yo ig ha am om zu xh")
    .split(" "),
);
const LANG_ZH: Record<string, string> = { en: "英", zh: "中", ja: "日", ko: "韓", fr: "法", de: "德", es: "西", pt: "葡", ru: "俄", ar: "阿", it: "義", vi: "越", th: "泰", id: "印尼", tr: "土", hi: "印地", nl: "荷", pl: "波", uk: "烏" };

const QUANT = ["fp8", "fp4", "int8", "8-bit", "4-bit", "gguf", "mlx", "awq", "gptq", "onnx", "exl2"];

/** safetensors 的 dtype 代號 → 人看得懂的寫法 */
const DTYPE: Record<string, string> = { F64: "FP64", F32: "FP32", F16: "FP16", BF16: "BF16", F8_E4M3: "FP8", F8_E5M2: "FP8e5", I8: "INT8", U8: "UINT8", I32: "I32", I64: "I64" };

/** "8-bit" 與 "fp8" 同時出現時只留較精確的那個 */
function quantLabel(tags: string[]): string {
  const q = new Set(tags);
  if (q.has("fp8")) q.delete("8-bit");
  if (q.has("fp4")) q.delete("4-bit");
  return [...q].join("／");
}

type Safetensors = { parameters?: Record<string, number>; total?: number };

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
  safetensors?: Safetensors | null;
};

export const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(n);

/** 參數量：763,205,315,794 → 763B；1,728,801,536 → 1.7B；859,922,360 → 860M */
export function fmtParams(n: number): string {
  const unit = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
  if (n >= 1e12) return `${unit(n / 1e12)}T`;
  if (n >= 1e9) return `${unit(n / 1e9)}B`;
  if (n >= 1e6) return `${unit(n / 1e6)}M`;
  if (n >= 1e3) return `${unit(n / 1e3)}K`;
  return String(n);
}

/** 名稱裡的參數量（只給沒有 safetensors 索引的 repo 用）：1T、33B、1.7B、A52B（MoE 啟用） */
function paramsFromName(name: string): { total: number | null; active: number | null } {
  const mult = (u: string) => (u.toUpperCase() === "T" ? 1e12 : 1e9);
  // 排除 4GB / 16GB 這種檔案大小寫法，否則 Nemotron-…-E4B-4GB 會被讀成 4B
  const bare = name.replace(/\d+(?:\.\d+)?\s?GB\b/gi, " ");
  const moe = bare.match(/(?:^|[-_ ])A(\d+(?:\.\d+)?)\s?([BT])\b/);
  const active = moe ? Math.round(Number(moe[1]) * mult(moe[2]!)) : null;
  const rest = bare.replace(/(?:^|[-_ ])A\d+(?:\.\d+)?\s?[BT]\b/g, " ");
  const size = rest.match(/(\d+(?:\.\d+)?)\s?([BT])\b/);
  const total = size ? Math.round(Number(size[1]) * mult(size[2]!)) : null;
  return { total, active };
}

export type SpecStats = {
  params: number | null;
  paramsText: string;
  paramsActive: number | null;
  paramsActiveText: string | null;
  /** safetensors＝有索引；name＝從檔名推得；null＝查不到 */
  paramsSrc: "safetensors" | "name" | null;
  paramsBreakdown: string | null;
  license: string | null;
  langs: string | null;
  quant: string | null;
  baseModel: string | null;
  /** 一行式規格摘要，給 tooltip 與 Notion 內文用 */
  detail: string | null;
};

/** 由 HF 的 model 物件（或單筆 detail API）算出規格欄位 */
export function specStats(m: { id?: string; modelId?: string; tags?: string[]; safetensors?: Safetensors | null }): SpecStats {
  const id = m.modelId ?? m.id ?? "";
  const tags = m.tags ?? [];
  const st = m.safetensors;
  const total = st?.total ?? null;

  const quantTags = tags.filter((t) => QUANT.includes(t));
  const isQuantRepo = quantTags.includes("gguf") || quantTags.includes("mlx");
  // 名稱裡的 A52B／A4B 是 MoE 的「啟用參數」，即使有 safetensors 索引也值得留
  const named = isQuantRepo ? { total: null, active: null } : paramsFromName(id.split("/").pop() ?? id);
  const params = total ?? named.total;
  const paramsActive = named.active !== null && (params === null || named.active < params) ? named.active : null;
  const paramsSrc: SpecStats["paramsSrc"] = total !== null ? "safetensors" : named.total !== null ? "name" : null;
  const breakdown = st?.parameters
    ? Object.entries(st.parameters)
        .filter(([, v]) => v > 1e7)
        .sort((a, b) => b[1] - a[1])
        .map(([dt, v]) => `${DTYPE[dt] ?? dt} ${fmtParams(v)}`)
        .join(" · ")
    : "";

  const lic = tags.find((t) => t.startsWith("license:"))?.slice(8) ?? null;
  const langs = tags.filter((t) => LANGS.has(t));
  const baseModelTag = tags.find((t) => t.startsWith("base_model:") && !t.startsWith("base_model:finetune:"));
  const rawBase = baseModelTag ? baseModelTag.slice("base_model:".length) : null;
  const baseModel = rawBase && rawBase.length > 42 ? `${rawBase.slice(0, 41)}…` : rawBase;

  const paramsText = params === null ? "—" : fmtParams(params);
  const activeText = paramsActive !== null ? fmtParams(paramsActive) : null;

  const detail = [
    params !== null ? `總 ${paramsText}（${paramsSrc === "name" ? "依名稱" : "safetensors"}）${activeText ? `／啟用 ${activeText}` : ""}` : "",
    breakdown,
    quantLabel(quantTags),
    lic ? (LICENSE_ZH[lic] ?? lic) : "",
    langs.length ? `${langs.length} 語（${langs.slice(0, 6).map((l) => LANG_ZH[l] ?? l).join("・")}${langs.length > 6 ? "…" : ""}）` : "",
    baseModel ? `基底 ${baseModel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    params,
    paramsText,
    paramsActive,
    paramsActiveText: activeText,
    paramsSrc,
    paramsBreakdown: breakdown || null,
    license: lic ? (LICENSE_ZH[lic] ?? lic) : null,
    langs: langs.length ? langs.join(" ") : null,
    quant: quantTags.length ? quantLabel(quantTags) : null,
    baseModel,
    detail: detail || null,
  };
}

/** 參數量這欄的資料限制，會印在榜單下方；backfill 一併補進舊快照 */
export const PARAMS_NOTE =
  "參數取自 repo 的 safetensors 索引（total 為該 repo 全部權重加總，同一 repo 放多種精度會重複計算）；沒有索引的 GGUF／diffusion repo 顯示「—」，避免從檔名亂猜。";

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
      const tag = m.pipeline_tag ? (TAG_ZH[m.pipeline_tag] ?? m.pipeline_tag) : "其他";

      const extra: string[] = [`下載 ${fmtNum(m.downloads ?? 0)}`, `讚 ${fmtNum(m.likes ?? 0)}`];
      if (m.createdAt) extra.push(`${m.createdAt.slice(5, 10).replace("-", "/")} 發布`);

      return {
        id,
        name: id,
        url: `https://huggingface.co/${id}`,
        rank: i + 1,
        metric: m.trendingScore ?? null,
        kicker: tag,
        note: extra.join(" · "),
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
