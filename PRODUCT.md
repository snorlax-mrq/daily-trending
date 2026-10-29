# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Bun + TypeScript 產生器 → 純靜態 HTML/CSS → GitHub Pages（與既有 ai-daily-feed 相同的抓取／建置／推送方式；沒有前端框架，沒有建置期以外的執行環境）。

## Users

主要使用者是資料集擁有者本人（台北，每天早上花 30 秒掃一眼），其次是收到 Discord 摘要後點進來的同事／同好。他們在早上喝咖啡的幾分鐘內想知道「昨天 AI 圈變了什麼」，而不是被一份完整清單淹没；偶爾會回來翻前幾天的紀錄，確認某個模型／專案是什麼時候開始紅的。

## Product Purpose

每天自動快照三個互相獨立、都被業界引用的 trending 來源（HuggingFace 模型熱度、GitHub 專案熱度、Artificial Analysis 模型評測），產生一頁可掃讀的每日榜單，並把每一天的排名存成可回溯的時序紀錄。成功＝讀者 30 秒內說得出今天的三個變化，而且一週後還能查到「那天它是第幾名」。

## Positioning

三個榜單回答三個不同的問題，本站的價值在並置與變化，不在清單本身：

- HuggingFace ＝ 哪個開源模型正在紅（有官方 API、有分數）
- GitHub ＝ 開發者的注意力在哪（官方無 API、無歷史，只能爬 HTML）
- Artificial Analysis ＝ 哪個模型真的強又划算（能力／價格／速度）

GitHub 與 AA 都沒有官方歷史資料，HF 的 trendingScore 也不留紀錄；所以「連續在榜第幾天、昨天第幾名、這週掉了几名」這些資料只存在本站。這是任何單一來源都無法複製的機制，也是本站與單純轉貼榜單的差別。

## Operating Context

- 由排程每天自動執行（台北時間早上），先推 Discord／Notion，再重建靜態站。
- 讀者多為使用手機或筆電快速掃讀，一次看三張榜單；深度讀者會點進單一榜單的時序頁。
- 內容語言為繁體中文（台灣用語），模型／專案名稱與技術名詞保留原文。
- 資料源全部是外部公開網頁／API，隨時可能改版或封鎖。

## Capabilities and Constraints

- HF：官方 JSON API（`?sort=trendingScore`），回 10–25 筆，欄位含 trendingScore／downloads／likes／pipeline_tag。
- GitHub：無官方 API、無歷史。解析 `github.com/trending?since=daily` 的 HTML（`article.Box-row`），每日筆數不固定（實測 11–25 筆），唯一動能指標是頁面上的 `N stars today`（官方未公開計算方式）。
- AA：無公開 API（需金鑰），解析 Next.js RSC payload。Intelligence Index v5 於 2026-10-27 上線，條目 272 筆中僅 76 筆已評分，遷移期榜單會劇烈洗牌。
- 三來源任一失敗不得影響其他來源；缺榜必須在頁面上明顯標示，不可靜默顯示空榜。
- 每日快照 `data/snapshots/YYYY-MM-DD.json` 是唯一真相；頁面是快照的投影，不得反向寫入。

## Brand Commitments

- 繁體中文（台灣），不使用簡體字。
- 不使用浮誇的行銷語氣、不用 emoji 當裝飾（既有日報的 emoji 徽章不繼承到網站）。
- 明確區分「資料」與「編輯意見」：數字連回原始來源，編輯導讀要標示為編輯導讀。

## Evidence on Hand

- `data/snapshots/2026-10-29.json`：三榜真實快照（HF 10 筆、GitHub 14 筆、AA 10 筆 + 8 則事件）。
- 既有 `hf-trending/daily.ts` 的排名徽章與連續在榜邏輯（可沿用計算方式，不沿用版面）。
- 既有 `ai-daily-feed` 的抓取／建置／推送管線經驗（含 GitHub Pages 部署方式）。
- 不存在的：真實讀者數、流量、任何商業指標。未來設計不得虛構這類數字。

## Product Principles

1. **變化優先於清單。** 一個「昨天第 3、今天第 1」比「今天第 1」有價值；版面與互動都應該讓差異先被看到。
2. **三個問題不混為一談。** 三個榜單的指標不可互相比較、不可合成單一總分；並置是為了看見不同角度。
3. **每個數字可追溯。** 任何排名、分數、價格都能連回來源頁，並標明抓取時間。
4. **失敗要吵。** 來源掛掉、筆數異常、解析失敗都必須讓讀者看到，而不是安靜地少一行。
5. **一天一頁，可回看。** 每日存檔是永久連結，同一網址永遠代表同一天的紀錄。

## Accessibility & Inclusion

- 純靜態 HTML，無 JS 也可讀完全部內容；深淺色跟隨系統偏好並可手動切換。
- 表格在手機上不得造成水平捲動；榜單以可重排的結構呈現，而非固定像素寬的寬表格。