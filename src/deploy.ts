// 把 dist/ 推到 gh-pages（GitHub Pages：Deploy from a branch → gh-pages / root）
// 用法: GITHUB_TOKEN=... bun run src/deploy.ts [--dry]
import { join } from "node:path";
import { ROOT } from "./lib.ts";

const DIST = join(ROOT, "dist");
const dry = process.argv.includes("--dry");
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPO ?? "snorlax-mrq/daily-trending";

if (!dry && !token) {
  console.error("需要 GITHUB_TOKEN 環境變數（repo 權限）");
  process.exit(1);
}

const tmp = join(ROOT, ".deploy-tmp");
await Bun.$`rm -rf ${tmp}`.quiet();
await Bun.$`mkdir -p ${tmp}`.quiet();
await Bun.$`cp -r ${DIST}/. ${tmp}/`.quiet();

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: tmp, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")}\n${await new Response(p.stderr).text()}`);
};
await run(["git", "init", "-q", "-b", "gh-pages"]);
await run(["git", "add", "-A"]);
await run(["git", "-c", "user.email=bot@local", "-c", "user.name=daily-trending", "commit", "-qm", `publish ${new Date().toISOString().slice(0, 10)}`]);
const url = `https://x-access-token:${token}@github.com/${repo}.git`;
if (dry) {
  console.log(`[dry] ${tmp} 已準備好，會推到 ${repo} 的 gh-pages`);
} else {
  await run(["git", "push", "-q", "-f", url, "gh-pages:gh-pages"]);
  console.log(`✅ 已發布 → https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/`);
}
await Bun.$`rm -rf ${tmp}`.quiet();