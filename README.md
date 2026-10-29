# 每日榜單 · Daily Trending

三個來源的每日快照：**HuggingFace 模型熱度**、**GitHub 專案熱度**、**Artificial Analysis 模型評測**。
每天一份、永久存檔，價值在「變化」——誰連續在榜、誰昨天第幾名、這週掉了幾名。

## 為什麼是三個榜單

| 榜單 | 回答的問題 | 取得方式 |
|---|---|---|
| HuggingFace | 哪個開源模型正在紅 | 官方 JSON API（`?sort=trendingScore`） |
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
src/subset-fonts.ts     中文字型子集化（掃 dist 的字集 → Noto Serif TC woff2）
src/import-hf-history.ts 一次性：把舊的 hf-trending 日報匯入成快照
src/deploy.ts           把 dist/ 推到 gh-pages

build.ts                快照 → 靜態站（index / d/ / board/ / archive）
assets/site.css         全部樣式（無框架）
assets/fonts/           Archivo Narrow（拉丁、窄體數字）、Source Serif 4
data/snapshots/         每日快照（唯一真相，要進 git）
data/headlines/         每日導讀（AI 撰寫，要進 git）
data/seen-aa-events.json AA changelog 去重紀錄
```

## 每日執行

cron `64c09feacb314d4c`（每天 08:00 Asia/Taipei，沿用原 HF 日報時段）依序：

```bash
bun run src/collect.ts      # 1. 抓三個來源 → data/snapshots/YYYY-MM-DD.json
                            # 2. 由 AI 寫 data/headlines/YYYY-MM-DD.json（導讀）
bun run build.ts            # 3. 產生 dist/
bun run src/subset-fonts.ts # 4. 中文字型子集（必須在 build 之後）
bun run src/deploy.ts       # 5. 推 gh-pages（需 GITHUB_TOKEN）
bun run src/notion-payload.ts --all   # 6. 快照＋導讀 → 三個 payload（hf/gh/aa）
cd .. && for b in hf gh aa; do
  python3 scripts/notion_push.py --push --project $b \
    --payload data/digest_out/payload_trending_${b}_<date>.json
done                                  # 7. 寫 Notion（同日舊列自動封存）
```

`run.sh` 是 1/3/4 的包裝。

## Notion

`trending` 頁 →「每日榜單」子頁 → **三個 DB，一個來源一個**（一天一列）：

| DB | project | 專屬屬性 |
|---|---|---|
| HuggingFace 每日整理 | `hf` | 冠軍模型 · 熱度 · 下載 · 讚 |
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
            "notes": ["讀者必須知道的資料限制"],
            "error": "抓取失敗時的訊息" },
    "gh": { … }, "aa": { …, "events": [{ "kind", "text", "url" }] } } }
```

- 漲跌＝與「前一個有該榜的日期」比較；沒有前一日就整欄不印（不製造假訊號）。
- 走勢＝近 9 個紀錄日的名次（桌機畫線、手機印數字）。
- 單一來源失敗只讓該榜空白並在頁面標紅，不影響其他榜。

## 新來源要加什麼

只加一支 `src/fetch-xx.ts` 回傳 `Board`，掛進 `src/collect.ts` 的 `Promise.all`。
`KEY_LABEL` / `METRIC_LABEL` 在 `build.ts`。

## 部署

GitHub Pages：**Deploy from a branch → `gh-pages` / root**（`src/deploy.ts` 會建一個乾淨的
orphan commit 推上去，`dist/.nojekyll` 已含在產物裡）。原始碼在 `main`，`dist/` 不進版控。

## 已知限制

- GitHub trending 每日筆數不固定（實測 11–25 筆），排序不是 `stars today`。
- AA Intelligence Index 2026-10-27 換到 v5，273 筆條目只有 77 筆完成評分，遷移期名次會劇烈變動。
- AA changelog 保留約 13 天，用 `data/seen-aa-events.json` 去重，避免同一件事連日重報。

## 授權

程式碼 MIT。**資料不重新授權**：排行榜內容來自各來源網站，版權屬原站；
本站只主張「每日快照與整理」這層編排，轉載請連回原站與本頁。