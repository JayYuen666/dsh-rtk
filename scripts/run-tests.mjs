// 测试入口：Node 22 把 `node:sqlite` 标成实验特性，每个 worker 各打一行警告。
// 这一行对读者没有信息量，却会让根仓的跑测噪点表判红；旗标必须给在**子进程**上，
// 因为 vitest 的 worker 继承的是子进程的 execArgv，进程内监听器拦不住默认打印。
// 单独一层脚本的作用是让判据留在代码里，而不是把旗标写进会被原样打印的 npm 命令行。
import { spawnSync } from "node:child_process";
import path from "node:path";

const vitest = path.join(import.meta.dirname, "..", "node_modules", "vitest", "vitest.mjs");
const existingOptions = Reflect.get(process.env, "NODE_OPTIONS");
const inheritedOptions = typeof existingOptions === "string" ? existingOptions : "";
const nodeOptions = [inheritedOptions, "--disable-warning=ExperimentalWarning"]
  .filter((part) => part !== "")
  .join(" ");
const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", vitest, ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: nodeOptions } },
);
process.exit(result.status ?? 1);
