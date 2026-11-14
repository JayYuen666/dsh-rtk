/**
 * `rtk rewrite` 的后置校验：只有「把一段 wrapper 前缀剥掉、剩下逐字符不动」的改写才采用。
 *
 * 返回 `undefined` 表示通过；返回原因串表示拒绝（调用方原样执行原命令）。
 *
 * 为什么不能只信 rtk 的退出码：rc=3 只说明「有等价改写」，不说明改写对插件无损。实测两类反例——
 * 把 rtk 插进 wrapper 内部（`uv run cargo test` → `uv run rtk cargo test`），以及把
 * `npm run lint` 塌缩成 `rtk lint`（用户脚本完全不跑，无 eslint 时仍 rc=0 伪造成功）。
 */

/** P1 要求的前缀形态：`rtk` 加一个空格。**不带**空格的那种（`rtk` / `rtkx`）不算前插形态。 */
const RTK_PREFIX = "rtk ";

// npm / pnpm 的脚本运行词。被剥掉的前缀里出现它们，就意味着「用户脚本可能被换成了同名工具」。
const SCRIPT_RUNNER = /\b(?:run-script|run|rum|urn)\b/u;

// 被剥掉的部分必须是「空白或路径分隔符」结尾：这就是 P3 的词边界。
// `/` 也算边界——`bin/rspec spec` → `rtk rspec spec` 剥掉的是 `bin/`（实测产物），
// 是合法的路径前缀剥离；只认空白会让 bin/ 家族整片被拒。
const PREFIX_BOUNDARY = /[\s/]$/u;

// 允许被剥掉的 wrapper 白名单。`uv run` 含 run 词，只能靠这张表放行；其余都是「明确只是转发」
// 的入口。pattern 都要求尾随空白，匹配时补一个空格（见 isAllowedWrapper）。
const ALLOWED_WRAPPERS: readonly RegExp[] = [
  /^npx\s+/u,
  /^pnpx\s+/u,
  /^pnpm\s+exec\s+/u,
  /^pnpm\s+dlx\s+/u,
  /^npm\s+exec\s+/u,
  /^npm\s+x\s+/u,
  /^python\s+-m\s+/u,
  /^python3?\s+-m\s+/u,
  /^uv\s+run\s+/u,
  /^bundle\s+exec\s+/u,
  /^bin\//u,
];

/** 判据 P4 的一半：被剥掉的前缀是不是「允许剥离的 wrapper」。 */
function isAllowedWrapper(stripped: string): boolean {
  return ALLOWED_WRAPPERS.some((pattern) => pattern.test(`${stripped} `));
}

/** P4 是否命中：剥掉的前缀含脚本运行词、且整段不在白名单里。 */
function stripsScriptRunner(stripped: string): boolean {
  return stripped !== "" && SCRIPT_RUNNER.test(stripped) && !isAllowedWrapper(stripped);
}

/**
 * P1：只接受前插形态。
 *
 * `rtk` 落在命令中间说明 rtk 认为某个 wrapper 可以被剥，但插件无法判断该 wrapper
 * （timeout / nice / nohup / env）的语义，统一拒绝。链式命令同理：实测
 * `cd /tmp && cargo test` 的产物是 `cd /tmp && rtk cargo test`，落在中间 → 这里拒。
 */
function checkPrefix(rewritten: string): string | undefined {
  return rewritten.startsWith(RTK_PREFIX) ? undefined : "not-rtk-prefixed";
}

/**
 * P2：`rtk ` 之后必须有东西。
 *
 * `trimEnd` 是必须的——实测 stdout 不带尾换行，但下游拼接与夹具可能带尾随空白，
 * 不 trim 会让 P3 的 `endsWith` 永远不成立。
 */
function checkRest(rest: string): string | undefined {
  return rest.trim() === "" ? "empty-rest" : undefined;
}

/**
 * P3 + P4：原命令（去掉前导空白）必须以 rest 结尾，且被剥掉的那一段要落在边界上；
 * 剥掉的前缀里不得含脚本运行词（除非整段是白名单 wrapper）。
 */
function checkSuffix(original: string, rest: string): string | undefined {
  const trimmed = original.trimStart();
  const suffixOk = trimmed.endsWith(rest);
  const stripped = suffixOk ? trimmed.slice(0, trimmed.length - rest.length) : "";
  // 空串是合法的「剥掉的前缀」：前插式改写（`rtk pnpm run build`）不剥任何东西。
  const boundaryOk = suffixOk && (stripped === "" || PREFIX_BOUNDARY.test(stripped));
  let reject: string | undefined;
  if (boundaryOk) {
    // P4：被剥掉的前缀里不得含脚本运行词——除非整段前缀都落在白名单 wrapper 里。
    if (stripsScriptRunner(stripped.trim())) {
      reject = "script-runner-stripped";
    }
  } else {
    reject = "not-a-suffix";
  }
  return reject;
}

/** 校验一次改写；`undefined` = 通过。 */
export function verifyRewrite(original: string, rewritten: string): string | undefined {
  const prefixProblem = checkPrefix(rewritten);
  const rest = rewritten.slice(RTK_PREFIX.length).trimEnd();
  const restProblem = prefixProblem === undefined ? checkRest(rest) : undefined;
  const suffixProblem =
    prefixProblem === undefined && restProblem === undefined
      ? checkSuffix(original, rest)
      : undefined;
  return prefixProblem ?? restProblem ?? suffixProblem;
}
