// 中文字型子集化：只把「這一期真的用到的字」打包成 woff2
// 站上的明體中文若靠系統字型，Windows／Android 會退回黑體，報紙的版面語言就沒了。
// 做法：掃 dist 所有 HTML → 取字集 → pyftsubset（Noto Serif CJK TC）→ 覆蓋 dist/assets/fonts
// 用法: bun run src/subset-fonts.ts
import { join } from "node:path";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { ROOT } from "./lib.ts";

const DIST = join(ROOT, "dist");
const FONT_DIR = join(DIST, "assets", "fonts");
const CHAR_FILE = join(ROOT, "data", ".charset.txt");

const TTC = [
  { src: "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", num: 3, out: "NotoSerifTC-400.woff2" },
  { src: "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", num: 3, out: "NotoSerifTC-700.woff2" },
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
  });
}

const files = walk(DIST);
if (!files.length) {
  console.error("dist 沒有 HTML，先跑 build.ts");
  process.exit(1);
}
const chars = new Set<string>();
for (const f of files) {
  const html = await Bun.file(f).text();
  for (const ch of html) if (ch.codePointAt(0)! > 0x7f) chars.add(ch);
}
// 基本 ASCII 與常用標點（未來新增來源名稱時不會缺字）
for (let c = 0x20; c < 0x7f; c++) chars.add(String.fromCharCode(c));
for (const c of "　、。〈〉《》「」『』【】〔〕·—－…～！？：；，。（）％＄") chars.add(c);
const text = [...chars].join("");
await Bun.write(CHAR_FILE, text);

mkdirSync(FONT_DIR, { recursive: true });
for (const { src, num, out } of TTC) {
  if (!existsSync(src)) {
    console.warn(`跳過 ${out}：找不到 ${src}`);
    continue;
  }
  const proc = Bun.spawn(
    ["python3", "-m", "fontTools.subset", src, `--font-number=${num}`, `--text-file=${CHAR_FILE}`, "--flavor=woff2", "--layout-features=kern,liga,vert", "--desubroutinize", `--output-file=${join(FONT_DIR, out)}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`pyftsubset 失敗（${out}）：${await new Response(proc.stderr).text()}`);
    continue;
  }
  const size = statSync(join(FONT_DIR, out)).size;
  console.log(`  ${out.padEnd(24)} ${(size / 1024).toFixed(0)} KB`);
}
console.log(`字型子集完成：${chars.size} 個字元`);