// GitHub 榜的「備註」欄：繁體中文（台灣）＋依 README 內容寫
// 背景：GitHub 沒有 API，trending 頁只能拿到 repo 的 about 一行英文，有些甚至是空的；
//       網站與 Notion 的「描述」就變成英文或「（無描述）」。這裡補一步：
//         --fetch  抓缺中文描述的 repo 的 README → data/gh-notes/<date>.todo.md（給 AI 讀）
//         --apply  讀 data/gh-notes/<date>.json（AI 寫的 { "owner/repo": "中文描述" }）→ 寫回快照
// 中文描述會流進 Notion 實體表的「描述」，匯出後仍是中文（Notion 是上游）。
//
// 用法:
//   bun run src/gh-notes.ts --fetch [--date YYYY-MM-DD] [--force]
//   bun run src/gh-notes.ts --apply [--date YYYY-MM-DD]
//   bun run src/gh-notes.ts --status
// 快取: data/gh-notes-cache.json（描述不常變，同一 repo 只寫一次；--force 重寫）
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { ROOT, listSnapshots, readSnapshot, today, type Item, type Snapshot } from "./lib.ts";

const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const date = argOf("--date") ?? today();
const force = argv.includes("--force");
const mode = argv.includes("--apply") ? "apply" : argv.includes("--status") ? "status" : argv.includes("--backfill") ? "backfill" : "fetch";

const NOTES_DIR = join(ROOT, "data", "gh-notes");
const CACHE_FILE = join(ROOT, "data", "gh-notes-cache.json");
const TODO_FILE = join(NOTES_DIR, `${date}.todo.md`);
const AI_FILE = join(NOTES_DIR, `${date}.json`);
const SNAP_FILE = join(ROOT, "data", "snapshots", `${date}.json`);

type Cache = Record<string, { zh: string; at: string }>;
const cache: Cache = existsSync(CACHE_FILE) ? JSON.parse(await Bun.file(CACHE_FILE).text()) : {};
mkdirSync(NOTES_DIR, { recursive: true });

if (!existsSync(SNAP_FILE)) throw new Error(`沒有 ${date} 的快照，先跑 bun run src/collect.ts`);
const snap = JSON.parse(await Bun.file(SNAP_FILE).text()) as Snapshot;
const items: Item[] = snap.boards.gh?.items ?? [];
if (!items.length) throw new Error(`${date} 的 GitHub 榜沒有項目`);

/** 少數常見的「只有簡體會用」的字，用來提示（不擋） */
const SIMPLIFIED = "这个说时会为对应该发现据网络项处众无关产业务经历边样问题实际间点开闭启动页级质检测认证券学习计划报单显编著视频语单词汇读写讲讨论议题专门类数软优势谈让从两义举乡书买卖";
const hasSimplified = (s: string) => [...s].some((ch) => SIMPLIFIED.includes(ch));

// ── README 取得與清理 ────────────────────────────────
const CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.rst", "README.markdown", "README"];

function cleanReadme(raw: string): string {
  let s = raw.replace(/\r/g, "");
  s = s.replace(/^---\n[\s\S]*?\n---\n/, ""); // YAML front matter
  s = s.replace(/```[\s\S]*?```/g, ""); // 程式碼區塊
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<picture[\s\S]*?<\/picture>/gi, " ").replace(/<(img|source|iframe|video|svg)\b[\s\S]*?>/gi, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&[a-z]+;/g, " ");
  const prose: string[] = [];
  for (const rawLine of s.split("\n")) {
    const isHeading = /^\s{0,3}#{1,6}\s/.test(rawLine);
    const headingText = rawLine.replace(/^\s*#{1,6}\s*/, "").trim();
    const ln = rawLine
      .replace(/<[^>]+>/g, " ") // HTML
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 圖片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 連結留文字
      .replace(/^[\s>*\-+|]+/, "") // 清單／縮排／引言／表格
      .replace(/\*\*|__|`/g, "")
      .replace(/\[!\[[^\]]*\]\](\[[^\]]*\])?/g, " ") // reference 式徽章
      .replace(/\s+/g, " ")
      .trim();
    if (!ln) continue;
    if (isHeading) {
      // 安裝／使用說明之後都是指令，對「這是什麼」沒幫助，有足夠內容就收手
      if (prose.join(" ").length > 300 && /^(install|installation|quick ?start|getting started|usage|setup|build|development|contributing|license|sponsors?|platinum|backers?|安裝|安装|使用|快速開始|快速开始|開發|开发)/i.test(headingText)) break;
      prose.push(`【${headingText}】`);
      continue;
    }
    if (/^(=+|-{3,})$/.test(ln)) continue;
    // 語言切換列、徽章殘骸、純符號列
    if ((ln.match(/[•|]/g) ?? []).length >= 3) continue;
    if ((ln.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length < 12) continue;
    if (/^[\w-]+=/.test(ln)) continue;
    if (/^(table of contents|contents)$/i.test(ln)) continue;
    prose.push(ln);
    if (prose.join(" ").length > 1900) break;
  }
  return prose.join("\n").slice(0, 1900).trim();
}

async function fetchReadme(id: string): Promise<string | null> {
  for (const f of CANDIDATES) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${id}/HEAD/${f}`, {
        headers: { "user-agent": "daily-trending/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const text = cleanReadme(await res.text());
      if (text.length >= 40) return text;
    } catch {
      /* 換下一個檔名 */
    }
  }
  return null;
}

// ── backfill：把快取裡的中文描述補回舊快照（描述不隨日期變，Notion 實體是共用一列）──
if (mode === "backfill") {
  let files = 0, changed = 0;
  for (const f of listSnapshots().map((x) => x.replace(/\.json$/, ""))) {
    const p = join(ROOT, "data", "snapshots", `${f}.json`);
    const s0 = JSON.parse(await Bun.file(p).text()) as Snapshot;
    let n = 0;
    for (const it of s0.boards.gh?.items ?? []) {
      const zh = cache[it.id]?.zh;
      if (zh && it.note !== zh) {
        it.note = zh;
        n++;
      }
    }
    if (n) {
      await Bun.write(p, JSON.stringify(s0, null, 1) + "\n");
      files++;
      changed += n;
    }
  }
  console.log(`✓ 回填 ${files} 份快照、${changed} 筆備註（快取 ${Object.keys(cache).length} 筆）`);
  process.exit(0);
}

// ── status ────────────────────────────────────────
if (mode === "status") {
  const missing = items.filter((i) => !cache[i.id]?.zh);
  console.log(`${date} GitHub ${items.length} 筆；有中文描述 ${items.length - missing.length} 筆、缺 ${missing.length} 筆`);
  for (const i of missing) console.log(`  缺 ${i.id}（原描述：${i.note.slice(0, 60)}）`);
  process.exit(0);
}

// ── apply ────────────────────────────────────────
if (mode === "apply") {
  const ai: Record<string, string> = existsSync(AI_FILE) ? JSON.parse(await Bun.file(AI_FILE).text()) : {};
  let applied = 0;
  const warns: string[] = [];
  for (const it of items) {
    const zh = (ai[it.id] ?? cache[it.id]?.zh ?? "").trim();
    if (!zh) {
      warns.push(`缺中文描述：${it.id}（原描述：${it.note || "空"}）`);
      continue;
    }
    if (zh.length < 12) warns.push(`太短（${zh.length} 字）：${it.id}`);
    if (hasSimplified(zh)) warns.push(`疑似簡體：${it.id} → ${zh}`);
    it.note = zh;
    applied++;
    if (ai[it.id]) cache[it.id] = { zh, at: date };
  }
  await Bun.write(SNAP_FILE, JSON.stringify(snap, null, 1) + "\n");
  await Bun.write(CACHE_FILE, JSON.stringify(cache, null, 1) + "\n");
  // 用掉就把 AI 檔封存，避免明天誤用
  if (existsSync(AI_FILE)) await Bun.write(join(NOTES_DIR, `${date}.applied.json`), JSON.stringify(ai, null, 1) + "\n");
  console.log(`✓ ${date}：${applied}/${items.length} 筆備註已換成中文 → ${SNAP_FILE}`);
  for (const w of warns) console.warn(`  ⚠️ ${w}`);
  process.exit(0);
}

// ── fetch：列出還缺中文描述的 repo，附 README 摘要 ────────────
const todo = items.filter((i) => force || !cache[i.id]?.zh);
if (!todo.length) {
  console.log(`✓ ${date}：${items.length} 筆都有中文描述了，不用抓 README（要重寫加 --force）`);
  process.exit(0);
}

console.log(`抓 ${todo.length} 個 repo 的 README…`);
const blocks: string[] = [];
for (const it of todo) {
  const readme = await fetchReadme(it.id);
  const s = it.stats ?? {};
  const head = `- 語言 ${it.kicker} ｜ ★${(s.stars ?? 0).toLocaleString("en-US")} ｜ 今日 +${(s.todayStars ?? 0).toLocaleString("en-US")}`;
  const body = readme
    ? `- README 摘要：\n${readme.split("\n").map((l) => `  ${l}`).join("\n")}`
    : `- README 抓不到（沒有 README 或路徑不符），只能依 GitHub 原描述寫，並在語氣上保守。`;
  blocks.push(`## ${it.id}\n${head}\n- GitHub 原描述：${it.note || "（空）"}\n${body}`);
  console.log(`  ${readme ? "✓" : "✗"} ${it.id}（README ${readme?.length ?? 0} 字）`);
}

const guide = `# ${date} GitHub 榜：缺少中文描述的專案（${todo.length} 筆）

請依下面每一則的 README 內容，各寫一句到兩句台灣繁體中文描述，寫進 \`data/gh-notes/${date}.json\`：

\`\`\`json
{ "${todo[0]!.id}": "……", "其他 owner/repo": "……" }
\`\`\`

規格：
- 50–90 字（備註欄固定三行、約 90 字滿版，超過會被截掉）。
- 第一句寫「這是什麼／做什麼」，第二句寫 README 裡最關鍵的差別或亮點（特色、限制、成立的條件）。
- 只能寫 README 與原描述真的有的東西；README 抓不到就只寫原描述的意思，不要補想像。
- 專有名詞保留原文（例如 agent、CLI、MCP），不要硬翻。
- 繁體中文、台灣用語，禁簡體；不要 emoji、不要破折號「——」。

`;

await Bun.write(TODO_FILE, guide + blocks.join("\n\n") + "\n");
console.log(`\n→ ${TODO_FILE}`);
console.log(`寫完 ${AI_FILE} 後跑：bun run src/gh-notes.ts --apply --date ${date}`);