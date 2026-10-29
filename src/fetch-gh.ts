// GitHub Trending — 官方沒有 API，只能解析 HTML（實測不需 UA／不需登入）
// https://github.com/trending?since=daily
import { get, type Board, type Item } from "./lib.ts";

const URL = "https://github.com/trending?since=daily";

const strip = (s: string) =>
  s
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, "")) : 0);

export async function fetchGh(limit = 25): Promise<Board> {
  const base: Board = { label: "GitHub", question: "開發者的注意力在哪", source: "github.com/trending（HTML）", items: [] };
  try {
    const html = await get(URL);
    const chunks = html.split('<article class="Box-row">').slice(1);
    if (!chunks.length) throw new Error("找不到 article.Box-row（GitHub 版面可能改版）");

    const items: Item[] = [];
    for (const raw of chunks) {
      const href = raw.match(/<h2[^>]*>[\s\S]*?href="\/([^"?#]+)"/)?.[1];
      if (!href) continue;
      const desc = raw.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1];
      const lang = raw.match(/itemprop="programmingLanguage">([^<]+)</)?.[1];
      const stars = num(strip(raw.match(/href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""));
      const forks = num(strip(raw.match(/href="\/[^"]+\/forks"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""));
      const todayStars = num(raw.match(/([\d,]+)\s*stars?\s*today/)?.[1]);
      items.push({
        id: href,
        name: href,
        url: `https://github.com/${href}`,
        rank: items.length + 1,
        metric: todayStars,
        kicker: lang ?? "—",
        note: strip(desc ?? "").slice(0, 160) || "（無描述）",
        stats: { stars, forks, todayStars, lang: lang ?? null },
      });
      if (items.length >= limit) break;
    }
    if (!items.length) throw new Error("解析後 0 筆");
    return { ...base, items, notes: [`GitHub 依當日熱度決定榜單長度，今天 ${items.length} 筆（不是固定 25 筆）；「今日新增 stars」是官方未公開算法的數字。`] };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

if (import.meta.main) {
  const b = await fetchGh();
  console.log(b.items.length, b.error ?? "");
  for (const i of b.items.slice(0, 5)) console.log(i.rank, i.name, i.metric, i.kicker, "|", i.note.slice(0, 50));
}