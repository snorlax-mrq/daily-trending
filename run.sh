#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run src/collect.ts      # 三來源 → data/snapshots/YYYY-MM-DD.json
# ↑ 之後由 AI 寫 data/headlines/YYYY-MM-DD.json（導讀）
bun run build.ts            # → dist/
bun run src/subset-fonts.ts # 中文字型子集
