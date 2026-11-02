// 一次性（可重複執行）：把「規格欄位」補進舊快照的 HF 榜
// 2026-10-29 之前的快照是在 fetch-hf 還沒有 tags／createdAt 時抓的，缺 license／langs／quant／
// baseModel／pipeline／library／createdAt／lastModified／downloadsAllTime／detail。
// 這些還查得到（HF detail API 仍回傳同一個 repo 的 tags），所以逐筆回查補上；查不到就留 null。
//
// 只補「缺的鍵」，不覆寫既有值：params* 與 tag 是抓取當下算的，重算會改寫歷史。
// detail 因為包含新補的欄位，會用「既有 params ＋ 新補欄位」重組（format.ts 的 composeDetail）。
//
// 用法: bun run src/backfill-hf-spec.ts [--date YYYY-MM-DD] [--dry]
import { get, listSnapshots, readSnapshot, writeSnapshot, today } from "./lib.ts";
import { composeDetail, hfNote, specStats, type HfModelLike } from "./format.ts";

const argDate = (() => {
  const i = process.argv.indexOf("--date");
  return i > 0 ? process.argv[i + 1] : undefined;
})();
const dry = process.argv.includes("--dry");
const CONCURRENCY = 4;

const dates = listSnapshots().map((f) => f.replace(/\.json$/, "")).filter((d) => !argDate || d === argDate);

type Target = { date: string; index: number; id: string };
const targets: Target[] = [];
for (const date of dates) {
  const s = await readSnapshot(date);
  for (const [index, it] of (s?.boards?.hf?.items ?? []).entries()) {
    if (it.stats && "license" in it.stats) continue; // 已補過（含確定查不到的 null）
    targets.push({ date, index, id: it.id });
  }
}
console.log(`📋 ${dates.length} 個快照，待補 ${targets.length} 筆${dry ? "（dry run）" : ""}`);
if (!targets.length) process.exit(0);

const detailUrl = (id: string) => {
  const q = new URLSearchParams();
  for (const f of ["safetensors", "tags", "pipeline_tag"]) q.append("expand[]", f);
  return `https://huggingface.co/api/models/${id}?${q.toString()}`;
};

type Fill = { license: string | null; langs: string | null; quant: string | null; baseModel: string | null; pipeline: string | null; library: string | null; createdAt: string | null; lastModified: string | null; downloadsAllTime: number | null };

const MISSING: Fill = { license: null, langs: null, quant: null, baseModel: null, pipeline: null, library: null, createdAt: null, lastModified: null, downloadsAllTime: null };

async function lookup(id: string): Promise<Fill> {
  try {
    const raw = JSON.parse(await get(detailUrl(id))) as HfModelLike & { pipeline_tag?: string; library_name?: string; createdAt?: string; lastModified?: string; downloadsAllTime?: number };
    const s = specStats(raw);
    return {
      license: s.license,
      langs: s.langs,
      quant: s.quant,
      baseModel: s.baseModel,
      pipeline: raw.pipeline_tag ?? null,
      library: raw.library_name ?? null,
      createdAt: raw.createdAt ?? null,
      lastModified: raw.lastModified ?? null,
      downloadsAllTime: raw.downloadsAllTime ?? null,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/HTTP 40[134]/.test(msg)) return MISSING; // 404 已刪 / 401 gated / 403
    throw e;
  }
}

async function pool<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]!);
      }
    }),
  );
  return out;
}

// 同一個 id 只查一次
const uniq = [...new Set(targets.map((t) => t.id))];
console.log(`🔎 不重複模型 ${uniq.length} 個，逐筆回查 HF detail API…`);
const fills = new Map<string, Fill>();
await pool(uniq, CONCURRENCY, async (id) => {
  const f = await lookup(id);
  fills.set(id, f);
  return f;
});

let patched = 0;
const byDate = new Map<string, Target[]>();
for (const t of targets) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t);

for (const [date, list] of byDate) {
  const s = await readSnapshot(date);
  if (!s) continue;
  for (const t of list) {
    const it = s.boards.hf?.items?.[t.index];
    if (!it) continue;
    const f = fills.get(t.id) ?? MISSING;
    const stats = it.stats ?? {};
    // 只補缺的鍵
    for (const [k, v] of Object.entries(f)) if (!(k in stats)) (stats as Record<string, unknown>)[k] = v;
    stats.detail = composeDetail({
      paramsText: (stats.paramsText as string) ?? null,
      paramsActiveText: (stats.paramsActiveText as string) ?? null,
      paramsSrc: (stats.paramsSrc as string) ?? null,
      paramsBreakdown: (stats.paramsBreakdown as string) ?? null,
      quant: (stats.quant as string) ?? null,
      license: (stats.license as string) ?? null,
      langs: (stats.langs as string) ?? null,
      baseModel: (stats.baseModel as string) ?? null,
    });
    it.stats = stats;
    // note 由 stats 算出（補了 createdAt 之後會多一段「MM/DD 發布」）
    it.note = hfNote({ downloads: stats.downloads as number, likes: stats.likes as number, createdAt: stats.createdAt as string | null });
    patched++;
  }
  if (!dry) await writeSnapshot(s);
  console.log(`  ${date} 補 ${list.length} 筆`);
}

console.log(`\n${dry ? "（未寫入）" : "✅ 已寫入"} ${patched} 筆規格 · ${today()}`);
const noLicense = [...fills.entries()].filter(([, f]) => !f.license).length;
console.log(`查不到授權的模型：${noLicense}／${fills.size}（留 null，不推測）`);