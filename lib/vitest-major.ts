import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * vitest 主版本探针。
 *
 * 为什么需要它：`rtk vitest` 在 vitest 5 上会**吞掉全部输出**——rtk 给 vitest 加
 * `--reporter=json` 后从 stdout 读 JSON，而 vitest 5 改成把 JSON 写进文件，于是 rtk 只拿到
 * 那行「JSON report written to …」通告，三级解析全失败，回一个
 * `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed`；**副作用是还在用户仓库里
 * 建出 `.vitest/json/output.json`**。版本边界实测：2.1.9 / 3.2.7 / 4.1.12 正常，5.1.0 坏。
 * 所以在「会不会落到 vitest 上」这件事没把握时，本模块**返回 undefined**，由调用方拒绝改写。
 */

/** 向上找 `node_modules/vitest/package.json` 的最大层数。 */
const MAX_DEPTH = 8;

const DIRECT = /^(?:npx|pnpx|bunx)\s+vitest(?:\s|$)|^vitest(?:\s|$)/u;
const VIA_PM = /^(?:pnpm|npm|yarn|bun)\s+(?:exec\s+|dlx\s+|x\s+)?vitest(?:\s|$)/u;
const TEST_SCRIPT = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/u;

/**
 * 这条命令会不会落到 vitest 上。
 *
 * `<pm> test` 也算：rtk 的规则把 `pnpm test` / `npm run test` 都塌缩成 `rtk vitest`，
 * pipe 表也把它们映射到 vitest filter。代价是 jest 项目里的 `pnpm test` 也会被当 vitest 探——
 * 探不到就拒绝改写（宁可少压一次，也不要在用户仓库里写副作用文件）。
 */
export function isVitestCommand(command: string): boolean {
  const trimmed = command.trimStart();
  return DIRECT.test(trimmed) || VIA_PM.test(trimmed) || TEST_SCRIPT.test(trimmed);
}

/**
 * 目录 → 主版本。`null` 表示「从这个目录一路向上到根都没有装 vitest」。
 *
 * 缓存的语义必须钉死：`null` **只能**在「整条向上路径都探过」之后才写。写成「这一层没有」
 * 就错了——中间层没有 vitest、但它的祖先装了，是常态（monorepo 的子包）；那样一来第二次
 * 调用在中间层读到 `null` 就直接返回 undefined，结果与第一次不一致。
 */
const majorByDir = new Map<string, number | null>();

/**
 * 清空探针缓存。**只给测试用**：缓存是进程级单例，同一份用例里两个临时目录可能是父子关系，
 * 不清就会读到上一格写下的结论。生产路径没有调用点，故不进任何导出面以外的语义。
 */
export function resetVitestMajorCache(): void {
  majorByDir.clear();
}

// 版本号是**点分**的（`5.1.0`），不是普通数字串：`Number("5.1.0")` 是 NaN，
// 所以只能取开头的整数段。
const LEADING_MAJOR = /^(?<major>\d+)/u;

/** 从 `version` 字段取主版本；非字符串、非正整数一律 undefined。 */
function majorOf(version: unknown): number | undefined {
  const matched = typeof version === "string" ? LEADING_MAJOR.exec(version)?.groups : undefined;
  const parsed = Number(matched?.["major"]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 读这一层 `node_modules/vitest/package.json` 的主版本；这一层没有可用的就返回 undefined。 */
function readMajorIn(dir: string): number | undefined {
  let version: unknown;
  try {
    const raw = readFileSync(path.join(dir, "node_modules", "vitest", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
  } catch {
    // 文件不存在 / 不是 JSON / 没权限，一律当这一层没有。
    version = "unreadable";
  }
  return majorOf(version);
}

/**
 * 从 `directory` 一路向上找，返回 `{ major, visited }`：`visited` 是走过但没命中的目录，
 * 供调用方把「整条路径的结论」一次性写进缓存。
 */
function walkUp(directory: string): { major: number | undefined; visited: string[] } {
  const visited: string[] = [];
  let dir = path.resolve(directory);
  let major: number | undefined;
  for (let depth = 0; depth <= MAX_DEPTH && major === undefined; depth += 1) {
    const cached = majorByDir.get(dir);
    if (cached !== undefined) {
      major = cached ?? undefined;
      break;
    }
    visited.push(dir);
    major = readMajorIn(dir);
    const parent = path.dirname(dir);
    if (major === undefined && parent === dir) {
      break;
    }
    if (major === undefined) {
      dir = parent;
    }
  }
  return { major, visited };
}

/**
 * 从 `cwd` 向上找最近一个装了 vitest 的 `node_modules`，返回它的主版本。
 *
 * 探不到返回 `undefined`（调用方据此**拒绝改写**）。到文件系统根就停：`path.dirname('/')`
 * 仍是 `/`，不判这一格会绕圈直到 `MAX_DEPTH`。
 *
 * 缓存按**整条路径的结论**写：找到的那一层之下的所有目录都记同一个主版本；一路到根都没找到，
 * 才把走过的目录都记成 `null`。这样同一个目录重复调用给同一结果，且不装 vitest 的目录只付一次
 * 八层 IO 的代价。
 */
export function detectVitestMajor(cwd: string, command: string): number | undefined {
  let found: number | undefined;
  if (isVitestCommand(command)) {
    const walked = walkUp(cwd);
    found = walked.major;
    for (const each of walked.visited) {
      majorByDir.set(each, found ?? null);
    }
  }
  return found;
}
