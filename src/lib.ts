// 共用工具：日期、抓取、快照讀寫、RSC 解析
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

export const ROOT = join(import.meta.dir, "..");
export const SNAP_DIR = join(ROOT, "data", "snapshots");
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

/** 台北時區 YYYY-MM-DD */
export function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

export function formatZh(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(y!, m! - 1, day!)).getUTCDay()];
  return `${y} 年 ${m} 月 ${day} 日 · 星期${wd}`;
}

export async function get(url: string, timeoutMs = 45_000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Next.js RSC payload：把所有 self.__next_f.push([1,"..."]) 串起來 */
export function rscText(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("[\s\S]*?")\]\)<\/script>/g)) {
    try {
      out.push(JSON.parse(m[1]!) as string);
    } catch {
      /* 壞掉的 chunk 跳過 */
    }
  }
  return out.join("");
}

/** 從 marker 之後找第一個 '['，做括號配對（尊重字串轉義），回傳 raw JSON */
export function sliceArray(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf("[", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function listSnapshots(): string[] {
  if (!existsSync(SNAP_DIR)) return [];
  return readdirSync(SNAP_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
}

// ── 統一快照型別 ──
/** 一個榜單項目。metric 是該榜的主指標（HF=trendingScore、GH=stars today、AA=II） */
export type Item = {
  id: string;
  name: string;
  url: string;
  rank: number;
  metric: number | null;
  /** 卡片副標：類型／語言／開發者 */
  kicker: string;
  /** 一行說明 */
  note: string;
  /** 任意補充數字，例如 downloads / likes / price */
  stats?: Record<string, string | number | null>;
};

export type Board = {
  /** 顯示名 */
  label: string;
  /** 榜單在回答什麼問題，一句 */
  question: string;
  source: string;
  items: Item[];
  /** 當日事件（AA 有：新收錄模型／編輯部文章） */
  events?: { kind: string; text: string; url?: string }[];
  /** 讀者必須知道的資料限制，會印在榜單下方 */
  notes?: string[];
  /** 抓取失敗時記在這裡，items 為空 */
  error?: string;
};

export type Snapshot = {
  date: string;
  generatedAt: string;
  boards: Record<string, Board>;
};

export async function writeSnapshot(snap: Snapshot): Promise<string> {
  mkdirSync(SNAP_DIR, { recursive: true });
  const path = join(SNAP_DIR, `${snap.date}.json`);
  await Bun.write(path, JSON.stringify(snap, null, 1) + "\n");
  return path;
}

export async function readSnapshot(date: string): Promise<Snapshot | null> {
  const p = join(SNAP_DIR, `${date}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(await Bun.file(p).text()) as Snapshot;
}