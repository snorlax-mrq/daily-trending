# 每日榜單 · Daily Trending

三個來源的每日快照：**HuggingFace 模型熱度**、**GitHub 專案熱度**、**Artificial Analysis 模型評測**。
每天一份、永久存檔，價值在「變化」——誰連續在榜、誰昨天第幾名、這週掉了幾名。

## 為什麼是三個榜單

| 榜單 | 回答的問題 | 取得方式 |
|---|---|---|
| HuggingFace | 哪個開源模型正在紅 | 官方 JSON API（`?sort=trendingScore`）＋ `expand[]` 帶參數量／授權／語言 |
| GitHub | 開發者的注意力在哪 | `github.com/trending` HTML 解析（**無官方 API、無歷史**） |
| Artificial Analysis | 哪個模型真的強、又划算 | Next.js RSC payload（API 需金鑰） |

GitHub 與 AA 都沒有官方歷史資料，HF 的 trendingScore 也不留紀錄，
所以「連續在榜幾天、昨天第幾名」只存在本站。

## 結構

```
src/lib.ts              共用：日期、抓取、RSC 解析、快照型別
src/fetch-hf.ts         HF fetcher
src/fetch-gh.ts         GitHub fetcher（HTML）
src/fetch-aa.ts         AA fetcher（RSC）+ 事件去重
src/collect.ts          三來源並行 → data/snapshots/YYYY-MM-DD.json（唯一真相）
src/gh-notes.ts         GitHub 榜備註：抓 README → AI 寫台灣繁中描述 → 寫回快照（快取 data/gh-notes-cache.json）
src/subset-fonts.ts     中文字型子集化（掃 dist 的字集 → Noto Serif TC woff2）
src/import-hf-history.ts 一次性：把舊的 hf-trending 日報匯入成快照
src/backfill-hf-params.ts 一次性（可重跑）：回查 HF detail API，補舊快照的參數量
src/deploy.ts           把 dist/ 推到 gh-pages

build.ts                快照 → 靜態站（index / d/ / board/ / archive）
assets/site.css         全部樣式（無框架）
assets/fonts/           Archivo Narrow（拉丁、窄體數字）、Source Serif 4
data/snapshots/         每日快照（要進 git）
data/headlines/         每日導讀（AI 撰寫，要進 git）
data/seen-aa-events.json AA changelog 去重紀錄
data/notion_items_db.json   Notion 4 個 DB 的 id（notion-db.ts 產生）
data/notion_entities.json   實體 → Notion page id 快取
data/notion_obs.json        觀測 → Notion page id 快取
NOTION.md               Notion 資料模型與同步規則（上游設計）
```

**唯一真相已經搬到 Notion**（見 `NOTION.md`）：`data/snapshots/` 是 `src/notion-export.ts`
從 Notion 匯出的產物，同時保留為離線 fallback。每日流程會寫進 Notion、再從 Notion 匯出回寫，
所以「在 Notion 改的東西」才活得下來。

## 每日執行

cron `64c09feacb314d4c`（每天 08:00 Asia/Taipei，沿用原 HF 日報時段）依序：

```bash
# A. 抓資料
bun run src/collect.ts      # 1. 抓三個來源 → data/snapshots/YYYY-MM-DD.json
bun run src/gh-notes.ts --fetch   # 1b. GitHub 榜缺中文描述的 repo → 抓 README → data/gh-notes/<date>.todo.md
                                  #     由 AI 依 todo 寫 data/gh-notes/<date>.json，再 --apply 寫回快照
                            # 2. 由 AI 寫 data/headlines/YYYY-MM-DD.json（導讀）

# B. 進 Notion（上游）
bun run src/notion-items.ts   # 3. 實體 ×3 ＋ 每日名次（upsert，重跑不重複）
bun run src/notion-relay.ts   # 4. notes／events／長版導讀 → 日報的「榜單中繼」
bun run src/notion-export.ts --write  # 5. 以 Notion 為準回寫 JSON（正常應印「✓ 完全一致」）

# C. 建站
bun run build.ts            # 6. dist/
bun run src/subset-fonts.ts # 7. 中文字型子集（必須在 build 之後）
bun run src/deploy.ts       # 8. 推 gh-pages（需 GITHUB_TOKEN）

# D. 日報（--in-place：人工導讀不被覆蓋）
bun run src/notion-payload.ts --all   # 9. 快照＋導讀 → 三個 payload
cd .. && for b in hf gh aa; do
  python3 scripts/notion_push.py --push --project $b \
    --payload data/digest_out/payload_trending_${b}_<date>.json --in-place
done                                  # 10. 就地更新三個日報列
```

`run.sh` 是 1/3 的包裝。第 5 步的 `--write` 有安全閘：匯出的項目數比本機少就拒絕覆寫
（代表 Notion 沒寫完），寧可留著舊 JSON 也不要上一個缺資料的站。

`--in-place` 只重建「生成區塊」，`導讀（編輯）` 底下的段落是人工區，原封不動。
要連人工區一起覆蓋時加 `--force-human`。

### 一次性工具（不在每日流程）

| 指令 | 用途 |
|---|---|
| `bun run src/notion-db.ts` | 建立／補齊 4 個 Notion DB（可重跑） |
| `bun run src/notion-dedupe.ts` | 清掉「每日名次」的重複列（中斷造成的） |
| `bun run src/notion-views.ts [--verify]` | 建立／補齊 15 個常用視圖（可重跑，同名的跳過）；`--verify` 用查詢 API 核對筆數 |
| `bun run src/notion-health.ts [--days 7] [--quiet]` | 七項健檢（列數／重複／覆蓋率／中繼／視圖／匯出回歸／快取）；有問題退出碼 1。每週 cron 跑一次 |
| `bun run src/backfill-hf-params.ts` | 補舊快照的參數量（只補會失效的數字，不推測歷史） |
| `bun run src/backfill-hf-spec.ts [--refill]` | 補舊快照的 license／langs／quant／baseModel／createdAt／library（還查得到才補，查不到留 null） |

`backfill-hf-params.ts` 只補會隨時間失效的數字（目前是參數量），授權／語言這類「抓取當下」的狀態不回填，
避免偽造歷史；`backfill-hf-spec.ts` 相反，只補「不隨時間改變」的規格，且以 HF 現在還查得到為準。

## Notion

`trending` 頁 →「每日榜單」子頁 → **三個 DB，一個來源一個**（一天一列）：

| DB | project | 專屬屬性 |
|---|---|---|
| HuggingFace 每日整理 | `hf` | 冠軍模型 · 熱度 · 下載 · 讚（表格含參數、發布日） |
| GitHub 每日整理 | `gh` | 榜首專案 · 今日 stars · 語言 |
| Artificial Analysis 每日整理 | `aa` | 榜首模型 · II 分數 |

三者共有：`名稱` `日期` `摘要` `主題` `資料來源` `新進榜數` `網站`。
內文：該榜的導讀段落 + 一張 table + 註記（＋AA 的今日異動），全部由同一份快照產生。

導讀寫在 `data/headlines/<date>.json`，支援分榜：
```jsonc
{ "by": "編輯",
  "lead": ["三段共用敘述（網站用）"],
  "boards": { "hf": "…", "gh": "…", "aa": "…" } }   // boards 有寫就優先給該 DB 用
```

（2026-10-29 的舊「單一合併 DB」資料已拆進三個 DB 後封存。）

## 資料模型

快照是唯一真相，頁面只是投影：

```jsonc
{ "date": "2026-10-29",
  "generatedAt": "…",
  "boards": {
    "hf": { "label": "HuggingFace", "question": "…", "source": "…",
            "items": [{ "id", "name", "url", "rank", "metric",
                        "kicker", "note", "stats" }],
            // stats 是 loose bag，榜單自己決定要塞什麼。hf 目前有：
            // downloads / downloadsAllTime / likes / tag / pipeline / library
            // createdAt / lastModified
            // params / paramsText / paramsActive / paramsActiveText / paramsSrc(safetensors|name)
            // paramsBreakdown / license / langs / quant / baseModel / detail
            // detail 是一行式規格摘要（參數＋精度＋授權＋語言＋基底），給 tooltip 與 Notion 用
            "notes": ["讀者必須知道的資料限制"],
            "error": "抓取失敗時的訊息" },
    "gh": { … }, "aa": { …, "events": [{ "kind", "text", "url" }] } } }
```

- 漲跌＝與「前一個有該榜的日期」比較；沒有前一日就整欄不印（不製造假訊號）。
- 走勢＝近 9 個紀錄日的名次（桌機畫線、手機印數字）。
- 單一來源失敗只讓該榜空白並在頁面標紅，不影響其他榜。

## GitHub 榜的備註（中文、依 README）

GitHub 沒有 API，trending 頁只給得到 repo 的一行英文 about，常常還是空的（顯示「（無描述）」）。
所以 `gh.note` 不直接用 about，而是走 `src/gh-notes.ts`：

1. `--fetch`：挑出還沒有中文描述的項目，抓 `raw.githubusercontent.com/<repo>/HEAD/README.md`（依序試幾個常見檔名），
   去掉徽章／HTML／程式碼區塊，遇到安裝或使用章節就停，截到 1,900 字，寫成 `data/gh-notes/<date>.todo.md`。
2. AI 讀 todo，替每則寫 50–100 字台灣繁中（這專案做什麼＋README 裡最關鍵的差別），存 `data/gh-notes/<date>.json`。
3. `--apply`：寫回當日快照的 `gh.items[].note`，並更新快取 `data/gh-notes-cache.json`（同一 repo 只寫一次，`--force` 才重寫）。

`note` 會流進 Notion「GitHub 專案」實體表的 `描述`，所以 Notion 與網站看到的是同一句話。
描述是「這東西是什麼」，不屬於歷史事實，因此在 Notion 改完匯出時，舊日期的同一個 repo 也會跟著換（不是造假數字）。
`--backfill` 可把快取的中文描述補回所有舊快照；`--status` 看當天還缺幾筆。

## 新來源要加什麼

只加一支 `src/fetch-xx.ts` 回傳 `Board`，掛進 `src/collect.ts` 的 `Promise.all`。
`KEY_LABEL` / `METRIC_LABEL` 在 `build.ts`。

## 部署

GitHub Pages：**Deploy from a branch → `gh-pages` / root**（`src/deploy.ts` 會建一個乾淨的
orphan commit 推上去，`dist/.nojekyll` 已含在產物裡）。原始碼在 `main`，`dist/` 不進版控。

## 已知限制

- 參數量取自 repo 的 `safetensors.total`，是「該 repo 全部權重加總」——同一個 repo 放 bf16＋fp8 兩份就會重複計算；
  MoE 的「啟用參數」只有檔名有寫（`35B-A3B`）才抓得到，且只寫進 `stats` 與 tooltip，不進表格。
  沒有索引的 GGUF／diffusion repo 一律印「—」，不從檔名回推（`-E4B-4GB` 這種寫法很容易誤判）。
  **上下文長度（`max_position_embeddings`）不在 list 回傳的 `config` 裡**，要嘛逐筆抓 `config.json`，目前不做。
- GitHub trending 每日筆數不固定（實測 11–25 筆），排序不是 `stars today`。
- AA Intelligence Index 2026-10-27 換到 v5，273 筆條目只有 77 筆完成評分，遷移期名次會劇烈變動。
- AA changelog 保留約 13 天，用 `data/seen-aa-events.json` 去重，避免同一件事連日重報。

## 授權

程式碼 MIT。**資料不重新授權**：排行榜內容來自各來源網站，版權屬原站；
本站只主張「每日快照與整理」這層編排，轉載請連回原站與本頁。