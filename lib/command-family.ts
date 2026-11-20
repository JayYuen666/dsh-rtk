/**
 * 命令家族：把一条具体命令归一成「哪个工具的哪个子命令」，统计与建议都按它聚合。
 *
 * 为什么不存完整命令：账本与页面刻意不留原文（README 的隐私口径），而按整条命令聚合
 * 的条形图通常每条只出现一次——既泄原文又没有可读性。家族这一层是两边都要的那一格。
 *
 * 归一规则刻意**保守**：认识的工具取两词（`cargo test`），其余只取首词（`rg`），
 * 认不出就是 `unknown`。宁可把 `cargo build --release` 与 `cargo build` 合成一家，
 * 也不去猜参数语义——猜错了没有读者能验证，而统计口径一旦不可验证就没人信。
 */
import { splitCommand } from "./command-segments.ts";

/** 只改命令、不改变「在跑什么」的前缀词；归一前剥掉它们的路径与赋值形态。 */
const WRAPPERS = new Set(["sudo", "env", "command", "time", "nohup", "builtin"]);

/** 第二个词是子命令（而不是参数或路径）的工具。 */
const TWO_WORD = new Set([
  "cargo",
  "git",
  "pnpm",
  "npm",
  "yarn",
  "go",
  "python",
  "python3",
  "pytest",
  "ruff",
  "dotnet",
  "docker",
  "kubectl",
  "aws",
  "ctest",
  "mvn",
  "gradle",
  "bun",
  "deno",
  "php",
  "composer",
  "pint",
  "phpunit",
  "pest",
  "rspec",
  "rake",
]);

/** 包管理器：`run <script>` 里第三词才是真正的动作，`pnpm run build` 与 `pnpm test` 该分开。 */
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
/**
 * 工具自己的全局选项里，**下一个词是它的取值**的那些。
 *
 * rtk 1.2.1 起 `cargo +nightly test` / `git -C /repo log` 这类带工具级前缀的写法会被改写
 * （`rtk rewrite` 回 rc=3），统计侧也必须认得出子命令：否则它们全被归一成 `cargo` / `git`，
 * 页面上看不出到底跑了哪件事。
 *
 * 只登记「确实吃一个值」的选项：认错方向的代价不同——把 flag 当成吃值会吞掉真正的子命令，
 * 把吃值选项当成 flag 会把用户路径当成子命令（隐私与可读性都坏）。`+toolchain` 单独处理：
 * 它以 `+` 开头且不吃值。
 */
/** `--configuration` 与 `--registry` 被多个工具共用，抽常量只为压住重复字面量规则。 */
const CONFIGURATION_LONG = "--configuration";
const REGISTRY_LONG = "--registry";
const TOOL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  aws: new Set([
    "--region",
    "--profile",
    "--output",
    "--endpoint-url",
    "--ca-bundle",
    "--cli-read-timeout",
    "--cli-connect-timeout",
    "--color",
  ]),
  bun: new Set(["--cwd", "--config"]),
  cargo: new Set([
    "--config",
    "-Z",
    "--target",
    "--color",
    "--manifest-path",
    "--message-format",
    "--jobs",
    "-j",
  ]),
  composer: new Set(["--working-dir", "-d", "--config", "--repo"]),
  ctest: new Set(["-C", "-j", "--build-config", "-R", "-E", "-L", "-LE", "-T"]),
  deno: new Set(["--config", "--cwd", "--lock", "--cert", "--log-level"]),
  docker: new Set(["-H", "--host", "--context", "--config", "--log-level", "-l"]),
  dotnet: new Set([
    "--framework",
    "-f",
    CONFIGURATION_LONG,
    "-c",
    "--runtime",
    "-r",
    "--output",
    "-o",
    "--verbosity",
    "--source",
    "--packages",
  ]),
  git: new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--config-env",
  ]),
  go: new Set([
    "-C",
    "-mod",
    "-tags",
    "-ldflags",
    "-o",
    "-p",
    "-gcflags",
    "-asmflags",
    "-toolexec",
    "-buildmode",
    "-compiler",
    "-installsuffix",
  ]),
  gradle: new Set([
    "-p",
    "--project-dir",
    "-c",
    "--settings-file",
    "-b",
    "--build-file",
    "-g",
    "--gradle-user-home",
    "--init-script",
    "-I",
  ]),
  kubectl: new Set([
    "--context",
    "--kubeconfig",
    "--namespace",
    "-n",
    "--cluster",
    "--user",
    "--server",
    "--token",
    "--request-timeout",
    "--certificate-authority",
    "--client-certificate",
    "--client-key",
    "--as",
    "--as-group",
    "--as-uid",
    "--cache-dir",
    "--tls-server-name",
    "--username",
    "--password",
    "--proxy-url",
    "--profile",
    "--profile-output",
  ]),
  mvn: new Set(["-f", "--file", "-P", "--profile", "-s", "--settings", "-t", "--toolchains"]),
  npm: new Set([
    "--prefix",
    REGISTRY_LONG,
    "--loglevel",
    "--userconfig",
    "--cache",
    "--workspace",
    "--include-workspace-root",
    "--location",
    "--tag",
  ]),
  php: new Set(["-d", "-c", "-z", "-f"]),
  phpunit: new Set([
    "-c",
    CONFIGURATION_LONG,
    "--bootstrap",
    "--testsuite",
    "--filter",
    "--group",
    "--exclude-group",
    "--coverage-clover",
    "--log-junit",
  ]),
  pint: new Set(["--config", "--preset", "--cache-file", "--format"]),
  pest: new Set(["--colors", CONFIGURATION_LONG, "--testsuite", "--filter", "--group"]),
  pnpm: new Set([
    "-C",
    "--dir",
    "--filter",
    "--reporter",
    "--loglevel",
    "--prefix",
    REGISTRY_LONG,
    "--config",
    "--workspace",
    "--store-dir",
    "--virtual-store-dir",
    "--network-concurrency",
    "--child-concurrency",
  ]),
  python: new Set(["-X", "-W"]),
  python3: new Set(["-X", "-W"]),
  pytest: new Set([
    "-c",
    "--rootdir",
    "--confcutdir",
    "-o",
    "--override-ini",
    "-k",
    "-m",
    "--deselect",
    "--import-mode",
  ]),
  rake: new Set(["-f", "--rakefile", "-I", "--libdir", "-r", "--require"]),
  rspec: new Set([
    "-I",
    "--default-path",
    "-r",
    "--require",
    "--format",
    "-f",
    "--out",
    "-o",
    "--order",
  ]),
  ruff: new Set([
    "--config",
    "--select",
    "--ignore",
    "--extend-select",
    "--extend-ignore",
    "--target-version",
    "--line-length",
    "--output-format",
    "--exclude",
    "--extend-exclude",
    "--per-file-ignores",
    "--fixable",
    "--unfixable",
    "--src",
    "--cache-dir",
    "--stdin-filename",
  ]),
  yarn: new Set([
    "--cwd",
    REGISTRY_LONG,
    "--cache-folder",
    "--network-timeout",
    "--mutex",
    "--proxy",
    "--https-proxy",
  ]),
};

/** 透明 wrapper：整段前缀只做转发，`wrapper … rtk <cmd>` 与 `rtk <cmd>` 的执行语义相同。 */
const TRANSPARENT_WRAPPERS = new Set(["env", "command", "time", "nohup"]);

/**
 * 跳过工具自己的全局选项，停在子命令那一位。
 *
 * 三类都放行：`+toolchain` 这种不吃值的 token、`--flag=value` 这种自带取值的 token、
 * 以及 `TOOL_VALUES` 登记过「下一个词是取值」的 flag。未登记的 flag 只跳它自己——
 * 方向是「宁可把 flag 当 flag」，那最多让子命令认错成 flag、退回首词家族，不会把路径写进账本。
 * @param tokens - 一段命令切出来的词
 * @param from - 工具词之后那一位
 * @param tool - 工具名（查它的吃值选项表）
 * @returns 子命令的下标
 */
function skipToolOptions(tokens: readonly string[], from: number, tool: string): number {
  let index = from;
  while (index < tokens.length) {
    /* v8 ignore next —— 循环条件保证在范围内；`?? ""` 只为 noUncheckedIndexedAccess 成立。 */
    const token = tokens[index] ?? "";
    if (!token.startsWith("-") && !token.startsWith("+")) {
      return index;
    }
    if (token.startsWith("+") || token.includes("=")) {
      index += 1;
    } else {
      index += TOOL_VALUES[tool]?.has(token) === true ? 2 : 1;
    }
  }
  return index;
}

/**
 * 包装器自己的选项里，**下一个词是它的取值**的那些。
 *
 * `sudo -u bob cargo test` 的第一版会归一成 `-u`：`WRAPPERS` 只跳包装器本身，于是 `-u`
 * 被当成命令。这不是难看的问题——`-u` 会成为一个家族名，而家族名要进统计与建议。
 * 只登记「确实吃一个值」的选项：认错的代价是把用户或路径当成命令，比把它当成选项糟。
 */
const WRAPPER_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set([
    "-u",
    "-g",
    "-p",
    "-C",
    "-h",
    "-r",
    "-t",
    "-U",
    "--user",
    "--group",
    "--prompt",
    "--chdir",
    "--host",
    "--role",
    "--type",
    "--other-user",
  ]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};

/** `FOO=1` 形态的环境变量赋值。 */
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

/** 子命令形态：裸词、无路径分隔、无扩展名（`tests/x.py` 与 `test_foo.py` 都不是子命令）。 */
const SUBCOMMAND = /^[A-Za-z][\w:-]*$/u;

/** 可执行文件的扩展名：`rg.exe` 与 `rg` 是同一个家族。 */
const EXECUTABLE_EXT = /\.(?:exe|cmd|bat|ps1)$/iu;

/** 段内取词；连续空白与制表符都当分隔。 */
const WHITESPACE = /\s+/u;

/**
 * 跳过包装器自己的一串选项。
 *
 * 单独成函数是为了让 `firstRealWord` 的分支只剩两条：两条 while 套在一起时，认知复杂度
 * 会同时算上「包装器」与「选项」两层嵌套，而它们其实是两件事。
 * @param tokens - 一段命令切出来的词
 * @param from - 包装器之后那一位
 * @param wrapper - 包装器本身（查它有哪些吃值的选项）
 * @returns 选项之后的下标
 */
function skipWrapperOptions(tokens: readonly string[], from: number, wrapper: string): number {
  let index = from;
  while (index < tokens.length) {
    /* v8 ignore next —— 循环条件已经保证 `index` 在范围内，`?? ""` 只是为了在
       `noUncheckedIndexedAccess` 下让类型成立；与 `rewrittenFamilies` 里那条同口径。 */
    const option = tokens[index] ?? "";
    if (!option.startsWith("-")) {
      return index;
    }
    index += WRAPPER_VALUES[wrapper]?.has(option) === true ? 2 : 1;
  }
  return index;
}

/**
 * 前导里第一个真正「在跑什么」的词的下标。
 *
 * 跳过三类：环境变量赋值、包装器本身、包装器自己的选项（连同吃值选项后面那个词）。
 * @param tokens - 一段命令切出来的词
 * @returns 下标；整段都是噪音时等于 `tokens.length`
 */
function firstRealWord(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length) {
    /* v8 ignore next —— 同上：越界取不到，`?? ""` 是类型位的防御，不是一条真分支。 */
    const token = tokens[index] ?? "";
    if (ASSIGNMENT.test(token)) {
      index += 1;
    } else if (WRAPPERS.has(token)) {
      index = skipWrapperOptions(tokens, index + 1, token);
    } else {
      return index;
    }
  }
  return tokens.length;
}

/**
 * 一段命令的家族词序列。
 * @param segment - 一段命令原文
 * @returns 家族词（可能为空表）
 */
function familyWords(segment: string): readonly string[] {
  const tokens = segment.trim().split(WHITESPACE).filter(Boolean);
  const start = firstRealWord(tokens);
  const head = tokens[start] ?? "";
  // 可执行文件写成路径时只留文件名：`/usr/bin/rg` 与 `rg` 是同一个家族。
  // **两个分隔符都要认**：只切 `/` 的话，Windows 上 `C:\\tools\\rg.exe` 会整条成为家族名——
  // 那是把路径写进了统计（隐私）而且每个目录都成一个新家族。
  const first = head
    .slice(Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\")) + 1)
    .replace(EXECUTABLE_EXT, "");
  // 工具级前缀（`cargo +nightly`、`git -C /repo`）不是子命令：跳过它们再取第二词。
  const afterHead = skipToolOptions(tokens, start + 1, first);
  const words = tokens.slice(afterHead);
  const [second = "", third = ""] = words;
  if (PACKAGE_MANAGERS.has(first) && second === "run" && third !== "" && !third.startsWith("-")) {
    return [first, second, third];
  }
  // 第二个词只有像**子命令**才留：`pytest tests/test_api.py` 的第二词是文件路径，
  // 收进来等于把文件名写进账本（隐私口径），而且每个文件都成一个新家族。
  const twoWord = TWO_WORD.has(first) && SUBCOMMAND.test(second);
  return twoWord ? [first, second] : [first];
}

/**
 * 一条（可能复合的）命令的家族：只看**第一段**。
 *
 * 复合命令的第一段不一定是承载输出的那条（`cd /tmp && cargo test` 里 `cd` 是噪音），
 * 但「哪一段才是主角」没有可靠判据，统一取首段是可解释的选择：读者照做一次就能复现。
 * @param command - 命令原文
 * @returns 家族名；认不出时 `unknown`
 */
export function commandFamilyOf(command: string): string {
  const segments = splitCommand(command);
  const segment = segments?.[0]?.text ?? command;
  const words = familyWords(segment).filter((word) => word !== "");
  return words.length === 0 ? "unknown" : words.join(" ");
}

/**
 * 改写前后的命令里，**被 rtk 改写过的那几段**各自的原始家族。
 *
 * 判据是「同一位置、原文不同、新文本以 `rtk` 前插」，而不是比对字符串差异——rtk 的
 * 改写形态就是逐段前插（见 `lib/prefix-safety.ts` 的 `splitCommand` 注释），按位置对齐
 * 才能区分「rtk 改了这段」与「这段本来就叫 rtk」。
 * @param original - 模型原始命令
 * @param rewritten - rtk rewrite 的结果
 * @returns 被改写段的原始家族（按出现顺序）；对齐不成立时为空表
 */
/**
 * `rtk <命令>` 的前插形态：`rtk` 这个词之前可以有一段透明 wrapper。
 *
 * rtk 1.2.1 起 `env FOO=1 rtk git log`、`time rtk cargo test` 这类 wrapper 在中间的前插也会出现
 * （`rtk rewrite` 对带包装器的命令只改里面那一段）。判断要分两块：`rtk` 前后各是什么。
 */
interface RtkFront {
  /** `rtk` 之前那段（不含 `rtk` 本身）。 */
  readonly prefix: string;
  /** `rtk` 之后那段（已去掉前导空白）。 */
  readonly rest: string;
}

/**
 * 找出命令里第一个 `rtk` 词，并切出它前后的两段。
 *
 * 不用 `startsWith("rtk ")`：那样会把 `env FOO=1 rtk git log` 判成「不是 rtk 前插」，
 * 并对它做一次多余的回退。词边界按 `firstRealWord` 判，所以前面的赋值与包装器都按插件
 * 已有的口径剥掉。
 * @param segment - 一段命令原文
 * @returns 前插形态；`rtk` 不在命令里、或它后面没东西时 `undefined`
 */
export function rtkFrontOf(segment: string): RtkFront | undefined {
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of segment.matchAll(/\S+/gu)) {
    words.push(match[0]);
    starts.push(match.index);
    ends.push(match.index + match[0].length);
  }
  const start = firstRealWord(words);
  const startOffset = starts[start] ?? 0;
  const end = ends[start] ?? segment.length;
  const isRtkFront = words[start] === "rtk" && end < segment.length;
  return isRtkFront
    ? { prefix: segment.slice(0, startOffset), rest: segment.slice(end).trimStart() }
    : undefined;
}

/**
 * 前插里 `rtk` 之后的那段命令（`rtk` 之前什么都不带时它等于整条命令）。
 * @param segment - 一段命令原文
 * @returns 剩下那段；不是 rtk 前插时 `undefined`
 */
export function rtkRemainder(segment: string): string | undefined {
  return rtkFrontOf(segment)?.rest;
}

/**
 * 这段前缀是否只做转发（透明 wrapper + 环境变量赋值）。
 *
 * 认 `env` / `command` / `time` / `nohup` 与 `FOO=1`：它们不改变被包装命令在跑什么。
 * `sudo`、`nice`、`timeout`、`uv run` 不在此列——前两个换身份/优先级，后两个是
 * 另一个程序在跑这条命令，rtk 结果与它们的语义不能互相替代。
 * @param prefix - `rtk` 之前那段
 * @returns 是透明前缀就 `true`
 */
export function isTransparentPrefix(prefix: string): boolean {
  const tokens = prefix.trim().split(WHITESPACE).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    /* v8 ignore next —— 循环条件保证在范围内；`?? ""` 只为 noUncheckedIndexedAccess 成立。 */
    const token = tokens[index] ?? "";
    if (ASSIGNMENT.test(token)) {
      index += 1;
    } else if (TRANSPARENT_WRAPPERS.has(token)) {
      index = skipWrapperOptions(tokens, index + 1, token);
    } else {
      return false;
    }
  }
  return true;
}

/**
 * 这段命令是不是 `[透明前缀] rtk <命令>` 形态。
 *
 * 与 `rtkRemainder` 的差别只在两处：要求 `rtk` 之后还有命令（`rtk` 单独一个词不是改写结果），
 * 并要求前缀透明。
 * @param segment - 一段命令原文
 * @returns 是 rtk 前插就 `true`
 */
export function hasRtkFront(segment: string): boolean {
  const front = rtkFrontOf(segment);
  return front !== undefined && front.rest !== "" && isTransparentPrefix(front.prefix);
}
export function rewrittenFamilies(original: string, rewritten: string): readonly string[] {
  const before = splitCommand(original);
  const after = splitCommand(rewritten);
  if (before === undefined || after === undefined || before.length !== after.length) {
    return [];
  }
  const families: string[] = [];
  for (const [index, segment] of before.entries()) {
    /* v8 ignore next —— 两边的段数在上面判过相等，`after[index]` 一定在，`?.` 与 `?? ""`
       都是走不到的防御分支（与 `host.ts` 的 `v8 ignore next` 同一个口径：为了让「对不齐」
       这件事有个明确的退路，而不是靠 `!` 硬过）。 */
    const changed = after[index]?.text ?? "";
    if (hasRtkFront(changed) && segment.text !== changed) {
      families.push(commandFamilyOf(segment.text));
    }
  }
  return families;
}
