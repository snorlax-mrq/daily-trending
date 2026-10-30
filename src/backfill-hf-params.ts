// 一次性（可重複執行）：把「參數量」補進舊快照的 HF 榜
// 2026-10-30 之前的快照是在 fetch-hf 還沒有 safetensors 欄位時抓的，這裡逐筆回查 HF detail API。
// 用法: bun run src/backfill-hf-params.ts [--date YYYY-MM-DD] [--dry]
//   - 只補 params* 這幾個統計值；授權／語言／基底屬於「抓取當下」的狀態，不回填，避免偽造歷史。
//   - 已有 paramsText 的項目直接跳過，所以可以安心重跑。
import { get, listSnapshots, readSnapshot, writeSnapshot, today } from "./lib.ts";
import { PARAMS_NOTE, specStats } from "./fetch-hf.ts";

const argDate = (() => {
  const i = process.argv.indexOf("--date");
  return i > 0 ? process.argv[i + 1] : undefined;
})();
const dry = process.argv.includes("--dry");

const dates = listSnapshots().map((f) => f.replace(/\.json$/, "")).filter((d) => !argDate || d === argDate);
const CONCURRENCY = 4;

type Target = { date: string; index: number; id: string };
const targets: Target[] = [];
for (const date of dates) {
  const s = await readSnapshot(date);
  const items = s?.boards?.hf?.items ?? [];
  for (const [index, it] of items.entries()) {
    if (it.stats && "paramsText" in it.stats) continue; // 已補過（含確定查不到的 "—"）
    targets.push({ date, index, id: it.id });
  }
}
console.log(`📋 ${dates.length} 個快照，待補 ${targets.length} 筆${dry ? "（dry run）" : ""}`);

const detailUrl = (id: string) => {
  const q = new URLSearchParams();
  for (const f of ["safetensors", "tags", "pipeline_tag"]) q.append("expand[]", f);
  return `https://huggingface.co/api/models/${id}?${q.toString()}`;
};

type Patch = { params: number | null; paramsText: string; paramsActive: number | null; paramsActiveText: string | null; paramsSrc: "safetensors" | "name" | null; paramsBreakdown: string | null };

async function lookup(id: string): Promise<Patch | "missing"> {
  try {
    const raw = JSON.parse(await get(detailUrl(id))) as { id?: string; modelId?: string; tags?: string[]; safetensors?: { parameters?: Record<string, number>; total?: number } | null };
    const spec = specStats(raw);
    return {
      params: spec.params,
      paramsText: spec.paramsText,
      paramsActive: spec.paramsActive,
      paramsActiveText: spec.paramsActiveText,
      paramsSrc: spec.paramsSrc,
      paramsBreakdown: spec.paramsBreakdown,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/HTTP 40[134]/.test(msg)) return "missing"; // 404 已刪 / 401 gated / 403
    throw e;
  }
}

/** 簡單併發池 */
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

const results = await pool(targets, CONCURRENCY, async (t) => {
  const p = await lookup(t.id);
  return { t, p };
});

const patched = new Map<string, number>();
for (const { t, p } of results) {
  const s = await readSnapshot(t.date);
  const it = s?.boards?.hf?.items?.[t.index];
  if (!s || !it) continue;
  it.stats = {
    ...(it.stats ?? {}),
    ...(p === "missing"
      ? { params: null, paramsText: "—", paramsActive: null, paramsActiveText: null, paramsSrc: null, paramsBreakdown: null }
      : p),
  };
  if (!dry) await writeSnapshot(s);
  patched.set(t.date, (patched.get(t.date) ?? 0) + 1);
  const label = it.name.length > 46 ? `${it.name.slice(0, 45)}…` : it.name;
  console.log(`  ${t.date}  ${(p === "missing" ? "—" : p.paramsText).padStart(6)}  ${label}`);
}

// 舊快照沒有「參數量怎麼來的」這行註記，一起補上（有 params 欄的頁面都該說明）
let noted = 0;
for (const date of dates) {
  const s = await readSnapshot(date);
  const hf = s?.boards?.hf;
  if (!s || !hf?.items?.length) continue;
  hf.notes = hf.notes ?? [];
  if (hf.notes.includes(PARAMS_NOTE)) continue;
  hf.notes.push(PARAMS_NOTE);
  if (!dry) await writeSnapshot(s);
  noted++;
}

console.log(`\n${dry ? "（未寫入）" : "✅ 已寫入"} ${[...patched.values()].reduce((a, b) => a + b, 0)} 筆參數，${patched.size} 個快照；補註記 ${noted} 個快照 · ${today()}`);
