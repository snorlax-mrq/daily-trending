# Notion 資料模型

> 目標：**Notion 是上游，不是輸出目的地。**
> 現況（2026-11-02）是反向：`notion_push.py` 每天 `archive 舊列 → 建新列`，
> 而專案裡沒有任何一支程式讀 Notion，所以「改在 Notion 的內容」隔天就被蓋掉。
> 這份文件定義改法與資料模型。

## 一、為什麼要拆表：實測的重複程度

14 天快照（10/20–11/02）逐項統計：

| 榜單 | item 實例 | 不重複項目 | 重複倍率 | 固定欄位占位元組 |
|---|---|---|---|---|
| HF | 140 | 28 | **5.0×** | 88% |
| GH | 71 | 36 | 2.0× | 45% |
| AA | 50 | 10 | **5.0×** | 64% |
| 合計 | **261** | **74** | 3.5× | **73%** |

- 261 個實例裡只有 74 個不同的東西 → 每天在重寫同一批描述
  （`deepseek-ai/DeepSeek-V4.1-Flash-1017` 連續 14 天，授權／參數／語言被抄了 14 份）
- 快照總 157 KB 中，另有 15.3 KB（10%）是**衍生字串**：
  `kicker`（= tag／lang 的鏡像）、`note`（下載‧讚‧日期的格式化結果）、
  `paramsText`、`paramsBreakdown`、`detail`、`paramsActiveText`
- 這些衍生值**根本不該入庫**，需要時由原始欄位算出來

### 誠實的界線

拆表省的是**屬性**，不是**列數**。「某天第幾名」是不可壓縮的時間序列：
45 筆/日 × 365 = 16,425 列/年，這點不會因為拆表而變少。
拆表的真正收益：

1. 一份描述只存在一處（改 license 是改 1 列，不是 14 列）
2. 實體表可排序／篩選（「授權 Apache-2.0 且參數 < 10B 的模型」）
3. 匯出不必去重，資料一致性由結構保證
4. 觀測列變瘦（6 個數字 vs 25 個欄位）

## 二、四層結構

```
資料層（新）     實體 ×3 ──relation──▶ 每日名次 ×1
                     ▲                      │
編輯層（既有）  日報 ×3（導讀／註記／今日異動，人工可改）
                     │                      │
                     └──── export ──────────┘
                              ▼
                     data/snapshots/*.json + data/headlines/*.json
                              ▼
                     build.ts → dist/ → gh-pages
```

- **資料層**：機器寫，人讀。一列一實體／一列一觀測。
- **編輯層**：既有的「HuggingFace／GitHub／Artificial Analysis 每日整理」三個 DB。
  人寫導讀、補註記。**改成 in-place upsert，人工寫的區塊不被覆蓋。**
- **快照 JSON**：變成 export 的產物（同時保留本地 fallback）。
- 網站照舊由 `build.ts` 產生。

## 三、Schema

### 3.1 實體：HF 模型（`HF 模型`）

| 屬性 | 型別 | 來源 | 變動頻率 |
|---|---|---|---|
| 名稱 | title | `id`（`deepseek-ai/DeepSeek-V4.1-Flash-1017`） | 永不 |
| 網址 | url | `url` | 極少 |
| 分類 | select | `stats.tag` | 少 |
| Pipeline | select | `stats.pipeline` | 少 |
| Library | select | `stats.library` | 少 |
| 授權 | select | `stats.license` | 少 |
| 語言 | rich_text | `stats.langs` join `, ` | 少 |
| 參數 | number | `stats.params` | 罕 |
| 參數來源 | select | `stats.paramsSrc`（safetensors／name） | 少 |
| 生效參數 | number | `stats.paramsActive` | 少 |
| 精度 | select | `stats.quant` | 少 |
| 基底模型 | rich_text | `stats.baseModel` | 少 |
| 發布日 | date | `stats.createdAt` | 永不 |
| 最後更新 | date | `stats.lastModified` | 每天 |
| 最新熱度 | number | 當日 `metric`（刻意反正規化，供瀏覽） | 每天 |
| 最新下載 / 讚 | number | 當日 `stats` | 每天 |
| 首次收錄 | date | 首次觀測日 | 一次 |
| 最近在榜 | date | 最後觀測日 | 每天 |
| 觀測 | relation → 每日名次 | — | 每天 |
| 在榜天數 / 最高名次 / 連續在榜 | rollup／公式 | 由 relation 算 | 自動 |

### 3.2 實體：GitHub 專案（`GitHub 專案`）

`名稱`(title, `owner/repo`)、`網址`、`語言`(select)、`描述`(rich_text, 160 字)、
`總 stars`、`forks`、`最新今日 stars`、`首次收錄`、`最近在榜`、`觀測`(relation)、rollup 三件。

> `描述` 是**真實來源資料**（repo description），不是衍生字串，要存。

### 3.3 實體：AA 模型（`AA 模型`）

`名稱`(title, slug)、`網址`、`開發商`(select)、`II 分數`、`輸入價`、`輸出價`、
`tok/s`、`每次任務成本`、`開放權重`(checkbox)、`首次收錄`、`最近在榜`、`觀測`(relation)、rollup 三件。

### 3.4 觀測：每日名次（`每日名次`，共用一張）

| 屬性 | 型別 | 說明 |
|---|---|---|
| 標題 | title | `2026-11-02 · deepseek-ai/DeepSeek-V4.1-Flash-1017`（僅供顯示） |
| 日期 | date | 快照日 |
| 榜單 | select | HF／GitHub／AA |
| 名次 | number | 1–25 |
| 指標 | number | 該榜原始指標（HF 熱度／GH stars/day／AA II） |
| 漲跌 | number | + 上升 / − 下降 / 0 持平 |
| 狀態 | select | 新進／上升／下降／持平 |
| 下載 / 讚 | number | 僅 HF 有意義（觀測當日值） |
| 今日 stars | number | 僅 GH |
| 累計 stars | number | 僅 GH（觀測當日值） |
| HF 模型 / GitHub 專案 / AA 模型 | relation ×3 | 只有一個有值 |

**為什麼共用一張而不是三張**：跨榜查詢是常見需求（「今天有哪些新面孔」），
Notion 的 view 可以免費拆出「HF 榜」「GitHub 榜」「AA 榜」三個視圖，
不需要三份 schema。空著的 relation 屬性沒有成本。

## 四、寫入規則（`src/notion-items.ts`）

1. **自然鍵**：HF `id`、GH `owner/repo`、AA `slug`
2. **本地快取** `data/notion_entities.json`：`{ hf: {id: page_id}, gh: {...}, aa: {...} }`
   - 命中 → 直接用 `page_id` 建觀測，**0 次查詢**
   - 未命中 → query 一次（filter：`名稱` equals id）→ 有就補進快取，沒有就建實體
3. **實體只在變動時 PATCH**：本地存 `data/notion_entity_state.json`（id → hash），
   比對穩定欄位；未變則跳過。每日值（熱度／下載／stars）不參與 hash。
4. **觀測列 upsert**：同 `(日期, 榜單, 項目)` 已存在就 PATCH，避免同日重跑產生重複。
5. **節流**：3 req/s（每次寫入間隔 0.35s），429 依 `Retry-After` 退避。

每日請求量估算：觀測 45 + 新實體 9 + 實體更新 45 + 日報 3 ≈ **102 req/日 ≈ 40 秒**。

### 容量（實測）

| | 現在 | 年增 |
|---|---|---|
| 三榜日報 blocks（含表格列） | **543** | — |
| 拆分後 blocks | 543 +（74 實體） | 實體 3.4k + 觀測 16.4k |
| 每日新增 blocks | 47（表格列） | → 54（觀測 45 + 新實體 9） |

Notion Free（多成員）有 1,000 lifetime blocks 上限，但 personal access token 與
單人 Free 不受限；本 workspace 目前 543 blocks 仍在運作，暫無風險。
若日後逼近上限，觀測列可加保留策略（例如只留 12 個月，舊資料留在 git 的 JSON）。

## 五、匯出（`src/notion-export.ts`）

兩段，順序固定：

1. **實體 + 觀測 → `data/snapshots/<date>.json`**（還原成現行 Snapshot 格式）
   - 衍生字串由 `src/format.ts` 重算（從 `fetch-*.ts` 抽出來，兩邊共用）
   - 還原後與本地既有 JSON 逐欄 diff，**必須完全相同**才算回填成功
2. **日報的編輯區 → `data/headlines/<date>.json`**
   - 只取人工寫的段落（導讀／人工註記），不動自動區塊

### 錯誤處理

```
collect → push items → export → build → subset → deploy
                       │
                       └ 失敗 → 沿用本地 JSON，cron 回報警告（不擋建站）
```

## 六、日報 in-place upsert（改 `scripts/notion_push.py`）

現況：`find_row_by_date` → `archive` 全部 → `POST` 新頁。

改成：

1. 找到當日列 → **保留 page_id**
2. `PATCH /pages/{id}` 更新屬性（名稱／摘要／冠軍模型…）
3. 內文分區重建：
   - `heading_2 == "導讀（編輯）"` 之後到下一個 `heading_2` 之前的段落 → **人工區，不動**
   - 其餘（榜單表格、註記、今日異動、footer）→ `DELETE` 後重插
4. 若 `導讀（編輯）` 不存在（新的一天）→ 依現行格式建立

> 表格欄數建立後不可改（Notion 限制）：要加欄位時只能刪表重建，
> 重建時同樣只動 generated 區塊。

## 七、回填步驟

| # | 動作 | 產出 | 時間 |
|---|---|---|---|
| 1 | 建 4 個 DB（3 實體 + 1 觀測），寫入 schema | DB id 進 `data/notion_*.json` | 20 分 |
| 2 | `src/format.ts` 抽 formatter；`src/notion-items.ts` 寫入器 | — | 2 小時 |
| 3 | **回填 74 實體 + 261 觀測** | Notion 可見 261 列 | ~90 秒 + 開發 |
| 4 | `src/notion-export.ts` 匯出 → 與本地 JSON diff | diff 必須為空 | 1.5 小時 |
| 5 | `notion_push.py` 改 in-place upsert | 導讀不再被覆蓋 | 1 小時 |
| 6 | 接 cron、更新 README 每日步驟 | — | 30 分 |

### 歷史欄位的誠實原則

10/20–10/28 的 HF 快照沒有 `license`／`langs`／`quant`／`baseModel`（10/29 才加）。
回填時**照原樣留空**，不推測、不回填——與 `backfill-hf-params.ts` 只補
「會隨時間失效的數字」的原則一致。實體表新建時以「首次觀測日」為準。

## 八、實作現況（2026-11-02 完成）

| 指令 | 做什麼 | 狀態 |
|---|---|---|
| `src/notion-db.ts` | 建 4 個 DB、補屬性、加 rollup | ✅ 已建（id 在 `data/notion_items_db.json`） |
| `src/notion-items.ts` | 實體 upsert ＋ 觀測 upsert（3 req/s、429 退避、快取） | ✅ 28／36／10 實體、261 觀測 |
| `src/notion-relay.ts` | notes／events／generatedAt／長版導讀 → 日報「榜單中繼」 | ✅ 24 列 |
| `src/notion-export.ts` | Notion → 快照 JSON，並逐欄 diff | ✅ **14／14 天完全一致** |
| `src/notion-dedupe.ts` | 清重複觀測列 | ✅ |
| `scripts/notion_push.py --in-place` | 就地更新日報列，保留人工導讀 | ✅ 已驗證（人工段落存活） |

### 實測數字

- 14 天快照：261 個 item → **74 個實體**（HF 28／GH 36／AA 10）
- Notion 寫入：實體 74 ＋ 觀測 261 ＋ 日報 24；全量重跑一次約 3 分鐘（3 req/s）
- 每日增量：觀測 45 ＋ 實體變動 ≈ 50 次寫入 ≈ 20 秒

### 三個實作上的坑（已解）

1. **表格欄數不可改**：`table_width` 建立後不能透過 API 變更，所以日報的生成區塊一律
   「刪掉重建」，只有 `導讀（編輯）` 底下的段落不動。
2. **rich_text 只有 2000 字**：「榜單中繼」的 JSON 約 1.2–1.6 KB，仍可能超過，
   所以 `props_from_payload` 改成自動分塊（最多 100 塊＝200KB）。
3. **行內 HTML 會被 Notion 洗掉**：日報頁的 `boards` 段落拿不回 `<span class="em">`，
   所以 `boards[]` 以「榜單中繼」的 JSON 為準；頁面段落是給人讀的鏡像。

### 歷史缺口（誠實記錄）

10/20–10/28 的快照從未記錄 `downloads`／`likes`／`downloadsAllTime`／`lastModified`，
這些是**逐日觀測值，無法回溯**，因此在 Notion 裡也是 null，匯出後同樣是 null。
`createdAt`／`library`／`license`／`langs`／`quant`／`baseModel` 屬於不隨時間改變的規格，
已用 HF detail API 補齊（22 個模型全部查得到，0 筆留空）。

## 九、未決

- 觀測列的保留策略（目前決定永久保留；blocks 撞牆再談 12 個月歸檔）
- 是否要把 `events`（今日異動）也結構化成獨立 DB（目前存在日報的 JSON 屬性）
- AA 的價格欄位是否算「實體屬性」（會變）→ 目前放觀測列，實體只留「最新值」的 rollup
