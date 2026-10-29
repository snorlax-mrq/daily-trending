// HuggingFace Trending — 官方 JSON API（sort=trendingScore）
import { get, today, type Board, type Item } from "./lib.ts";

const API = "https://huggingface.co/api/models?sort=trendingScore&limit=25";

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
  "translation": "翻譯",
  "summarization": "摘要",
  "question-answering": "問答",
  "any-to-any": "任意模態",
  robotics: "機器人",
};

type Model = {
  modelId: string;
  trendingScore?: number;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string | null;
  createdAt?: string;
};

export const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(n);

export async function fetchHf(limit = 10): Promise<Board> {
  const base: Board = { label: "HuggingFace", question: "哪個開源模型正在紅", source: "huggingface.co/api（trendingScore）", items: [] };
  try {
    const models = JSON.parse(await get(API)) as Model[];
    if (!Array.isArray(models) || !models.length) throw new Error("HF API 回傳空陣列");
    const items: Item[] = models.slice(0, limit).map((m, i) => {
      const tag = m.pipeline_tag ? (TAG_ZH[m.pipeline_tag] ?? m.pipeline_tag) : "其他";
      const extra: string[] = [`下載 ${fmtNum(m.downloads ?? 0)}`, `讚 ${fmtNum(m.likes ?? 0)}`];
      if (m.createdAt) extra.push(`${m.createdAt.slice(5, 10).replace("-", "/")} 發布`);
      return {
        id: m.modelId,
        name: m.modelId,
        url: `https://huggingface.co/${m.modelId}`,
        rank: i + 1,
        metric: m.trendingScore ?? null,
        kicker: tag,
        note: extra.join(" · "),
        stats: { downloads: m.downloads ?? null, likes: m.likes ?? null, tag, createdAt: m.createdAt ?? null },
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
  console.log(b.items.slice(0, 3));
}