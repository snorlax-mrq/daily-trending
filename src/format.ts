// 衍生字串的唯一計算處。
// 網站（build.ts）、抓取（fetch-*.ts）、Notion 匯出（notion-export.ts）都必須用同一份規則，
// 否則「從 Notion 還原的快照」會跟原始快照差幾個字，diff 就永遠對不上。
//
// 原則：能算的就不要存。note／kicker／paramsText／detail／paramsBreakdown 都是算出來的。

// ── 數字 ──────────────────────────────────────────
/** 170353 → 170.4K；4298 → 4.3K；637 → 637 */
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

/** AA 的 II 分數（一位小數） */
export const fmtIi = (n: number | null | undefined): string => (typeof n === "number" ? n.toFixed(1) : "—");

// ── HF：中日韓／授權／語言／量化的對照表 ──────────
export const TAG_ZH: Record<string, string> = {
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

export const LICENSE_ZH: Record<string, string> = {
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
  llama4: "Llama 4",
};

/** 常見 ISO 639-1 語言碼（HF 的 language tag 用這個） */
export const LANGS = new Set(
  ("en zh ja ko fr de es pt it ru ar hi th vi id ms tr pl nl sv da fi no cs sk hu ro bg el he fa uk " +
    "bn ta te ml kn gu mr pa ur sw af az ka hy kk mn ne si sq sr hr sl lt lv et is ga cy eu ca gl " +
    "tl my km lo bo ps ku so yo ig ha am om zu xh")
    .split(" "),
);
export const LANG_ZH: Record<string, string> = { en: "英", zh: "中", ja: "日", ko: "韓", fr: "法", de: "德", es: "西", pt: "葡", ru: "俄", ar: "阿", it: "義", vi: "越", th: "泰", id: "印尼", tr: "土", hi: "印地", nl: "荷", pl: "波", uk: "烏" };

export const QUANT = ["fp8", "fp4", "int8", "8-bit", "4-bit", "gguf", "mlx", "awq", "gptq", "onnx", "exl2"];

/** safetensors 的 dtype 代號 → 人看得懂的寫法 */
export const DTYPE: Record<string, string> = { F64: "FP64", F32: "FP32", F16: "FP16", BF16: "BF16", F8_E4M3: "FP8", F8_E5M2: "FP8e5", I8: "INT8", U8: "UINT8", I32: "I32", I64: "I64" };

/** "8-bit" 與 "fp8" 同時出現時只留較精確的那個 */
export function quantLabel(tags: string[]): string {
  const q = new Set(tags);
  if (q.has("fp8")) q.delete("8-bit");
  if (q.has("fp4")) q.delete("4-bit");
  return [...q].join("／");
}

// ── HF：規格 ──────────────────────────────────────
export type Safetensors = { parameters?: Record<string, number>; total?: number };
export type HfModelLike = { id?: string; modelId?: string; tags?: string[]; safetensors?: Safetensors | null };

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

/** 一行式規格摘要：由（可能來自不同來源的）各欄位組成，backfill 重算 detail 時也用它 */
export function composeDetail(s: {
  params?: number | null;
  paramsText?: string | null;
  paramsActiveText?: string | null;
  paramsSrc?: string | null;
  paramsBreakdown?: string | null;
  quant?: string | null;
  license?: string | null;
  langs?: string | null;
  baseModel?: string | null;
}): string | null {
  const langCodes = (s.langs ?? "").split(" ").filter(Boolean);
  const detail = [
    s.paramsText && s.paramsText !== "—" ? `總 ${s.paramsText}（${s.paramsSrc === "name" ? "依名稱" : "safetensors"}）${s.paramsActiveText ? `／啟用 ${s.paramsActiveText}` : ""}` : "",
    s.paramsBreakdown ?? "",
    s.quant ?? "",
    s.license ?? "",
    langCodes.length ? `${langCodes.length} 語（${langCodes.slice(0, 6).map((l) => LANG_ZH[l] ?? l).join("・")}${langCodes.length > 6 ? "…" : ""}）` : "",
    s.baseModel ? `基底 ${s.baseModel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return detail || null;
}

/** 由 HF 的 model 物件（或單筆 detail API）算出規格欄位 */
export function specStats(m: HfModelLike): SpecStats {
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

  const detail = composeDetail({ paramsText, paramsActiveText: activeText, paramsSrc, paramsBreakdown: breakdown || null, quant: quantTags.length ? quantLabel(quantTags) : null, license: lic ? (LICENSE_ZH[lic] ?? lic) : null, langs: langs.length ? langs.join(" ") : null, baseModel });

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

// ── 三個榜單的「副標」與「一行說明」────────────
// kicker＝名稱下方的分類；note＝右欄那行字。兩者都只由原始欄位算出。

/** HF 分類：pipeline_tag → 中文；沒有就「其他」 */
export const hfKicker = (pipeline: string | null | undefined): string => (pipeline ? (TAG_ZH[pipeline] ?? pipeline) : "其他");

/** HF 右欄：下載 170.4K · 讚 4.3K · 10/17 發布（沒有值的欄位略過；全空回空字串） */
export function hfNote(s: { downloads?: number | null; likes?: number | null; createdAt?: string | null }): string {
  const extra: string[] = [];
  if (typeof s.downloads === "number") extra.push(`下載 ${fmtNum(s.downloads)}`);
  if (typeof s.likes === "number") extra.push(`讚 ${fmtNum(s.likes)}`);
  if (s.createdAt) extra.push(`${s.createdAt.slice(5, 10).replace("-", "/")} 發布`);
  return extra.join(" · ");
}

/** AA 右欄：$1.5 / $6 每百萬 token · 120 tok/s · 開放權重 */
export function aaNote(s: { priceIn?: number | null; priceOut?: number | null; tps?: number | null; openWeights?: number | boolean | null }): string {
  const base = `$${s.priceIn ?? "—"} / $${s.priceOut ?? "—"} 每百萬 token · ${Math.round(s.tps ?? 0) || "—"} tok/s`;
  const open = s.openWeights === true || s.openWeights === 1;
  return `${base}${open ? " · 開放權重" : ""}`;
}

/** GH 右欄＝repo 描述（真資料，不是算出來的）；空值統一寫「（無描述）」 */
export const ghNote = (desc: string | null | undefined): string => desc || "（無描述）";

/** HF 的可下載欄位是「觀測當天的數字」，會被這些 formatter 用到 */
export type HfDaily = { downloads?: number | null; downloadsAllTime?: number | null; likes?: number | null; createdAt?: string | null; lastModified?: string | null };

/** 參數量這欄的資料限制，會印在榜單下方；backfill 一併補進舊快照 */
export const PARAMS_NOTE =
  "參數取自 repo 的 safetensors 索引（total 為該 repo 全部權重加總，同一 repo 放多種精度會重複計算）；沒有索引的 GGUF／diffusion repo 顯示「—」，避免從檔名亂猜。";