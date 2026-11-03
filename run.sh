#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run src/collect.ts      # 三來源 → data/snapshots/YYYY-MM-DD.json（含增速榜原料）
# ↑ 收集時會順便跑 src/watch.ts：watchlist → 每日總星數 → data/growth/YYYY-MM-DD.json
#   不想跑就給 --no-watch 或 WATCH_OFF=1
# ↑ 之後由 AI 寫 data/headlines/YYYY-MM-DD.json（導讀）
bun run build.ts            # → dist/
bun run src/subset-fonts.ts # 中文字型子集
