// test/apply.test.ts —— 总装那一层：五个服务面齐全才装、装配顺序、以及失败不该打掉压缩。
//
// 这一层刻意**不复用** `test/integration/host-stack.ts` 的半栈桩：那些桩只造四个服务
// （`HostContext` 面），而 `apply` 要的是 `HostServices`（多 settings / storageDomain /
// inject / effect / fiber）。两套桩分开，谁都不必为对方多造字段。
//
// 时钟与网络都用替身：`storageDomain.open` 是可控 Promise，`subprocess.spawn` 恒失败
// （版本探测探不到就是探不到，装配必须照常）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, it, onTestFinished } from "vitest";

// `Config` 是 schemastery 的 schema 对象，但名字大写开头、直接调用会撞 `eslint(new-cap)`
// （它以为你在不 new 的情况下调构造函数）。导入时改名是零成本的解法。
import plugin, {
  Config as configSchema,
  createLocaleMessages,
  diagOf,
  formsOr,
  formsReaderOf,
  withDefault,
  loggerOf,
  pipeReadersOf,
  prefixReadersOf,
} from "../host.ts";
import type { HostServices } from "../host.ts";
import { DEFAULT_ENABLED_FILTERS } from "../lib/command-filter.ts";
import { RTK_STATS_SERVICE_KEY } from "../lib/stats-remote.ts";
import type { LegacyStatsDomain } from "../lib/stats-store.ts";
import type { StatsOverview } from "../lib/insights-shape.ts";
import { unbuildableDir } from "./unbuildable.ts";

interface Recorded {
  readonly injects: { readonly deps: readonly string[] }[];
  readonly effects: string[];
  readonly configure: {
    readonly presentation: { readonly auto?: boolean };
    readonly owner: unknown;
  }[];
  readonly disposers: (() => void)[];
  readonly registered: Map<string, unknown>;
  readonly warns: (readonly unknown[])[];
  /** systemPrompt 段注册与 skill 注册的轨迹（0.2.2 起两件事都在 `apply` 里发生）。 */
  readonly sections: { readonly name: string; readonly order: number; readonly text: string }[];
  readonly skills: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
  }[];
}

/** `tools/post-execute` 的事件名（本文件多处断言它挂没挂）。 */
/** 默认启用名单里的那个 filter：三处断言共用这条字面量。 */
const FILTER_CARGO = "cargo-test";

/** 开库失败那句 warn 的锚点（三处断言共用，别各写一份）。 */
const OPEN_FAILED = "cannot open the stats tables";

const POST_EXECUTE = "tools/post-execute";
/** hook 用例的输入行：40 个字符，40 行刚好过 `minBytes` 的默认 256。 */
const LONG_LINE = "line of build output, padded to forty chars\n";
/** 假 hook 的产出：行数与输入相同（不触发折叠判据）、每行更短（真省了字节）。 */
const CLEANED = "clean\n".repeat(40);

/** `agent/created` 的事件名（C 形态的判据）。 */
const AGENT_CREATED = "agent/created";

/** 占位实现：只需要「存在且是可调用函数」，不需要任何行为。 */
function noop(): void {
  void 0;
}

/**
 * 空表的 `get`：空表就是「没有这条记录」，所以恒回 `undefined`。
 * 不用 `noop`：它的返回类型是 `void`，而 `LegacyStatsTable.get` 要的是
 * `LegacyAccumulator | undefined`——`void` 不等于 `undefined`（`strictNullChecks` 下两者在
 * 返回值位置不可互换）。
 */
const noRecord = (): undefined => void 0;

/** 默认的旧账本域：空表、close 幂等——只为不污染跑测输出，不承担任何断言。 */
async function silentDomain(): Promise<LegacyStatsDomain> {
  return {
    table: () => ({ get: noRecord }),
    close: () => Promise.resolve(),
  };
}

/** 子进程 spawn 的最小可读面：这一层只关心 argv 与喂进去的 stdin。 */
interface SpawnSpec {
  readonly argv: readonly string[];
  readonly stdio: { readonly stdin?: { readonly data?: string } | "ignore" };
}

/** 等一小段：`apply` 里启动的存储动作是异步的，用例得让它落地。 */
/**
 * 按**逆序**把注册的效应逐个跑掉，并等每一个交回的东西落定。
 *
 * 为什么删临时目录之前必须先跑它：装配会异步开一个 store，那条连接建出 `history.db-wal`
 * 与 `-shm`，直接 `rmSync` 与它撞上会抛 `ENOTEMPTY`（目录里恰好又冒出一个文件）。
 * 逆序是契约（宿主也是逆序撤），这里照同一个次序来，才不会出现「测试比宿主宽松」。
 *
 * 用递归而不是 `for … await`：后者撞 `no-await-in-loop`，而 `reduce` 又撞
 * `unicorn(no-array-reduce)`——两条规则各自都对，只是不许在同一个函数里凑。
 * @param disposers - 注册顺序的撤销函数
 */
async function disposeAll(disposers: readonly (() => unknown)[]): Promise<void> {
  const last = disposers.at(-1);
  if (last !== undefined) {
    await Promise.resolve(last());
  }
  const rest = disposers.slice(0, -1);
  if (rest.length > 0) {
    await disposeAll(rest);
  }
}

/** `eventually` 的递归体：用递归而不是 `for … await`（后者撞 `no-await-in-loop`）。 */
async function poll(ready: () => boolean, deadline: number): Promise<void> {
  if (ready() || Date.now() >= deadline) {
    return;
  }
  await sleep(2);
  await poll(ready, deadline);
}

/**
 * 轮询到条件成立为止（默认两秒预算）。
 *
 * 为什么不是 `await sleep(10)`：装配里的「读旧账本 → 开统计库 → 探 rtk 版本」都是 fire-and-forget
 * 的异步链，固定等一小段等于赌它跑得完。门禁并行 52 个 worker 且开覆盖率时，一次开库超过 10ms
 * 是常态，于是同一条用例在本机绿、在 CI 红（本轮门禁就是这么红的）。
 * 超时**不抛**：条件不成立时那把差异留给调用点的断言去讲，报错信息才有内容。
 * @param ready - 条件
 * @param budgetMs - 预算，默认两秒
 */
async function eventually(ready: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  await poll(ready, deadline);
}

/**
 * 把记录下来的 warn 调用摊成一行一条。
 * @param seen - 装配期记录
 * @returns 每行一条
 */
function warnLines(seen: Recorded): string[] {
  return seen.warns.map((args) => args.map(String).join(" "));
}

/**
 * 六服务齐全的宿主替身。
 *
 * `settings.describe()` 每次现调，所以用例可以在装配后改文案语言再读 thunk——这正是
 * 「用户切语言无需重载插件」那条判据的形状。
 */
function makeHost(
  overrides: {
    readonly locale?: unknown;
    readonly open?: () => Promise<LegacyStatsDomain>;
    /**
     * 子进程面；默认恒抛 ENOENT（= 这台机器上没装 rtk）。
     *
     * 收 `spec` 而不是无参：B 形态那条走线要区分 `rtk --version`（装配期探测）与
     * `rtk pipe`（压缩），也就要看 argv；同时要能读回喂给 pipe 的 stdin。
     */
    readonly spawn?: (spec: SpawnSpec) => never | Record<string, unknown>;
    /** 去掉 logger 服务，走 `loggerOf` 的 console 回退那条兼容路径。 */
    readonly omitLogger?: boolean;
    /**
     * `dshHomePath` 指向的根；缺省造一个临时目录并预建 `rtk/` 子目录。
     *
     * 给死路径（例如 `/dev/null/nope`）是「库开不出来」那条路径的入口——那时子目录不被预建，
     * `openSqlite` 只能失败。
     */
    readonly homeDir?: string;
    /**
     * `sandboxPolicy` 服务（可选）：给 `{ defaultMode: "read-only" }` 能让
     * `sandboxModeOf` 读到只读，从而验「只读时不读 rtk 账本」这条走线。
     */
    readonly sandboxPolicy?: unknown;
  } = {},
): {
  readonly host: HostServices;
  readonly seen: Recorded;
  readonly setLocale: (value: unknown) => void;
} {
  const seen: Recorded = {
    injects: [],
    effects: [],
    configure: [],
    disposers: [],
    registered: new Map<string, unknown>(),
    warns: [] as (readonly unknown[])[],
    sections: [],
    skills: [],
  };
  // `settings.describe()` 交回的是**命名空间的设置对象**，语言偏好在它的 `preference` 字段里
  // （shared 的 `resolveLocalePreference` 就按这个字段读）——不是裸字符串。
  let preference: unknown = overrides.locale;
  // 账本位置：插件按 **`$DSH_HOME/rtk/history.db`** 算（家目录走官方 `resolveDshHome`），
  // 所以替身用 `DSH_HOME` 把它钉到沙箱里。
  //
  // **必须钉**，而且必须指到临时目录：不钉的话每次跑门禁都会落到用户真实的
  // `~/.dsh/rtk/history.db` 上，把 `dsh_*` 表建进用户自己的账本（早期版本踩过一次真实污染）。
  // 预建 `rtk/` 子目录是为了让「库打得开」成为默认——开不出来那条路径由显式传死路径的用例走。
  const homeRoot = overrides.homeDir ?? mkdtempSync(path.join(tmpdir(), "rtk-home-"));
  if (overrides.homeDir === undefined) {
    mkdirSync(path.join(homeRoot, "rtk"), { recursive: true, mode: 0o700 });
    // 收摊顺序要**先关库再删目录**：装配会异步开一个 store，它建出 `history.db-wal`
    // 与 `-shm`；直接 `rmSync` 与那条连接的写入撞上，实测会抛 `ENOTEMPTY`（目录里
    // 恰好又冒出一个文件）。所以先按注册逆序跑一遍 disposer（`openInsightsStore` 挂的
    // 那个会 close），再删；`maxRetries` 兜住「关掉这一瞬间还有一次 WAL checkpoint」。
    onTestFinished(async () => {
      // 先等异步开库那一趟落定再删。`apply` 里是 `void insights.load()`，测试收尾时它可能
      // 还在飞；先删目录、它随后醒来，`ensureParentDir` 与 SQLite 会把 `rtk/history.db`
      // 重新建出来——临时目录就这么漏了（实测全量并行 + 覆盖率时一次漏 5~8 个，
      // 单文件跑永远漏不出来）。
      await eventually(
        () =>
          seen.effects.includes("rtk: insights store") ||
          warnLines(seen).some((line) => line.includes(OPEN_FAILED)),
      );
      await disposeAll(seen.disposers);
      rmSync(homeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
  }
  // 真 profile 里 spillStore 是常驻服务：压缩前原文落库、模型按 locator 取回。没有它时
  // 新策略会把有损压缩整条放弃，`apply` 那条「走真监听器」的用例就永远到不了换值那一步。
  // 这里按官方 SaveTextSpill → SpillRef 的形状给一份替身（locator 固定、字节按原文算）。
  seen.registered.set("spillStore", {
    saveText: (input: unknown) => {
      const { content } = input as { content?: unknown };
      const text = typeof content === "string" ? content : "";
      return Promise.resolve({
        locator: "/tmp/dsh-spill/apply-fixture.txt",
        bytes: Buffer.byteLength(text, "utf8"),
        retrievalHint: "Use read with offset/limit, or grep this path to search within it.",
      });
    },
  });
  const savedHome = process.env["DSH_HOME"];
  process.env["DSH_HOME"] = homeRoot;
  onTestFinished(() => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, "DSH_HOME");
    } else {
      process.env["DSH_HOME"] = savedHome;
    }
  });
  const settings = {
    describe: (): { readonly ns: string; readonly value: unknown }[] => [
      { ns: "locale", value: { preference } },
    ],
    configure: (presentation: { readonly auto?: boolean }, owner?: unknown): (() => void) => {
      seen.configure.push({ presentation, owner });
      return noop;
    },
  };
  // 旧累计账本的存储设施。它**不再是 `HostServices` 的必需位**（Insights 之后统计落在两本
  // 自有账本上），只在迁移那一步经 `get("storageDomain")` 取一次。默认给一份空表：
  // 默认失败会让**每条**用例都往 stderr 打一行 warn，跑测输出里全是噪音。
  const storageDomain = { open: overrides.open ?? silentDomain };
  const host = {
    settings,
    storageDomain,
    tools: { get: (): undefined => undefined },
    // 版本探测走这里：默认 ENOENT 直接抛，等同「PATH 上没有 rtk」。
    subprocess: {
      spawn:
        overrides.spawn ??
        ((): never => {
          throw new Error("ENOENT: rtk");
        }),
    },
    workingDirectory: { ensure: async (): Promise<string> => process.cwd() },
    // 常驻摘要段的注册口：收下 name/order/text（`apply` 里那一次），由用例断言。
    systemPrompt: {
      section: (section: {
        readonly name: string;
        readonly order: number;
        readonly text: string;
      }) => {
        seen.sections.push({ name: section.name, order: section.order, text: section.text });
        return noop;
      },
    },
    // 具名 logger：默认把 warn 收进 `seen.warns`（这是 spec §7.1「探测失败要留一条痕迹」
    // 唯一可断言的面）。`omitLogger` 时整位缺失，走 console 回退那条兼容路径。
    ...(overrides.omitLogger === true
      ? {}
      : {
          logger: (): { warn: (...args: unknown[]) => void } => ({
            warn: (...args: unknown[]) => {
              seen.warns.push(args);
            },
          }),
        }),
    get: (name: string): unknown => {
      if (name === "storageDomain") {
        return storageDomain;
      }
      if (name === "skills") {
        return {
          register: (skill: {
            readonly name: string;
            readonly description: string;
            readonly content: string;
          }): (() => void) => {
            seen.skills.push({
              name: skill.name,
              description: skill.description,
              content: skill.content,
            });
            return noop;
          },
        };
      }
      return name === "sandboxPolicy" ? overrides.sandboxPolicy : seen.registered.get(name);
    },
    on: (): (() => void) => noop,
    // 第二参叫 `attach` 而不是 `callback`：`promise(prefer-await-to-callbacks)` 按形参名判
    // node 风格回调，而这里 `inject` 的契约本来就是同步回调、不是「等它完成」。
    inject: (deps: readonly string[], attach: (child: unknown) => void): void => {
      seen.injects.push({ deps });
      attach({ settings, effect: host.effect });
    },
    effect: (factory: () => unknown, label?: string): (() => void) => {
      seen.effects.push(label ?? "");
      const product = factory();
      const dispose = typeof product === "function" ? (product as () => void) : noop;
      seen.disposers.push(dispose);
      return dispose;
    },
    fiber: { id: "rtk-fiber" },
    reflect: {
      provide: (name: string, instance: unknown): (() => void) => {
        seen.registered.set(name, instance);
        return () => {
          seen.registered.delete(name);
        };
      },
    },
  };
  return {
    host: host as unknown as HostServices,
    seen,
    setLocale: (value) => {
      preference = value;
    },
  };
}

/** 装配一次（`apply` 同步；它内部启动的异步动作由用例自己等）。 */
function applyTo(host: HostServices, config: Parameters<typeof plugin.apply>[1]): void {
  const run = plugin.apply as unknown as (ctx: unknown, cfg: unknown) => void;
  run(host, config);
}

/**
 * 让 `findOnPath("rtk")` 在本条用例里命中。
 *
 * C 形态的装配期门禁只剩一条：「PATH 上找得到 rtk」。断言「装配动作发生了」的用例若不自己
 * 把 rtk 造出来，判据就变成「跑测那台机器装没装 rtk」：同一份代码在两处可能给出两个结论。
 * 本仓真实踩过这一格（CI 三平台全红、本地全绿）——CI 现在会装 rtk，但夹具仍必须自足，
 * 不能反过来依赖它。
 *
 * 造的是真可执行文件（`findOnPath` 的 `X_OK` 与 `isFile` 两判都要过），但它不会被 spawn：
 * `makeHost` 的子进程替身恒抛 ENOENT，版本探测自然探不到，与「装了但探不到版本」同形。
 */
function withRtkOnPath(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "rtk-on-path-"));
  writeFileSync(path.join(dir, "rtk"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const saved = process.env["PATH"];
  process.env["PATH"] = `${dir}${path.delimiter}${saved ?? ""}`;
  onTestFinished(() => {
    process.env["PATH"] = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("apply 的前置校验", () => {
  it.each(["settings", "tools", "subprocess", "workingDirectory", "systemPrompt"] as const)(
    "缺 %s 就 fail-fast，不装半套",
    (drop) => {
      const { host } = makeHost();
      const broken = Object.fromEntries(
        Object.entries(host as unknown as Record<string, unknown>).filter(([key]) => key !== drop),
      );
      assert.throws(
        () => {
          applyTo(broken as unknown as HostServices, configSchema({}));
        },
        /required services/u,
        `少了 ${drop} 还能装下去，等于把错误推到第一次调用`,
      );
    },
  );

  it("服务在但方法不在也算缺（有对象不等于有方法）", () => {
    const { host } = makeHost();
    const broken = { ...host, settings: { describe: () => [] } };
    assert.throws(() => {
      applyTo(broken as unknown as HostServices, configSchema({}));
    }, /required services/u);
  });

  it("最外一层不是记录时同样抛错，而不是 TypeError 穿透", () => {
    assert.throws(() => {
      applyTo(5 as unknown as HostServices, configSchema({}));
    }, /required services/u);
    assert.throws(() => {
      applyTo(null as unknown as HostServices, configSchema({}));
    }, /required services/u);
  });
});

/** 收日志的假 facade（形状与 `ctx.logger(name)` 的返回值一致）。 */
function collector(): { readonly lines: string[]; readonly log: Parameters<typeof diagOf>[1] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (...args) => {
        lines.push(args.map(String).join(" "));
      },
      warn: () => {
        // warn 这一支本组用例不关心（装配期 warn 另有专门用例）。
      },
    },
  };
}

describe("诊断日志与按形态分账的接线", () => {
  it("volatile 的兜底口径：undefined 落回默认值，有值原样透传", () => {
    assert.equal(withDefault(undefined, false), false);
    assert.equal(withDefault(true, false), true);
    assert.deepEqual(withDefault<readonly string[]>(undefined, []), []);
    assert.equal(withDefault(undefined, 256), 256);
  });

  it("enabledForms 读到空引用时三处装配共用同一份兜底（只有 prefix）", () => {
    // 三处（status / C / B）各写一份字面量时这条断言证不了：改默认值只改到一处。
    assert.deepEqual([...formsOr(undefined)], ["prefix"]);
    assert.deepEqual([...formsOr(["prefix", "pipe"])], ["prefix", "pipe"]);
  });

  it("logFilterMode 为 off 时不造日志函数（热路径连字符串都不拼）", () => {
    const fake = collector();
    assert.equal(diagOf("off", fake.log), undefined);
    assert.equal(fake.lines.length, 0);
  });

  it("logFilterMode 为 on 时交给 logger.info", () => {
    const fake = collector();
    const diag = diagOf("on", fake.log);
    assert.ok(diag !== undefined);
    diag("[rtk] pipe cargo-test: 100B -> 10B");
    assert.deepEqual(fake.lines, ["[rtk] pipe cargo-test: 100B -> 10B"]);
  });

  it("ctx 有 logger 时用它，没有时回退 console（不影响装载）", () => {
    const lines: string[] = [];
    const withLogger = {
      logger: (name: string) => ({
        info: (...args: unknown[]) => {
          lines.push(`${name}:${args.map(String).join(" ")}`);
        },
        warn: () => {
          // 同上：形状补齐，行为不参与这一组断言。
        },
      }),
    };
    loggerOf(withLogger as unknown as Parameters<typeof loggerOf>[0]).info("hello");
    assert.deepEqual(lines, ["rtk:hello"]);

    // 回退分支：异常 ctx / 测试替身没有 logger 时不能抛。这里临时接住 console.info。
    const saved = console.info;
    const seen: string[] = [];
    console.info = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      loggerOf({} as unknown as Parameters<typeof loggerOf>[0]).info("fallback");
    } finally {
      console.info = saved;
    }
    assert.deepEqual(seen, ["fallback"]);
  });
});

describe("apply 的装配动作", () => {
  it("设置页经注入子上下文挂，owner 是本插件 fiber（否则插件卸载时清不掉）", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    assert.deepEqual(
      seen.injects.map((entry) => entry.deps),
      [["settings"]],
    );
    // 回调里那三层转手是承重的：inject → effect → configure，缺一层就不会随本 fiber 回收。
    assert.equal(seen.effects[0], "rtk: settings page");
    assert.deepEqual(seen.configure, [{ presentation: { auto: false }, owner: host.fiber }]);
  });

  it("常驻摘要经 systemPrompt.section 注册：段名与 order 各就各位、正文是当前语言的摘要", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    assert.equal(seen.sections.length, 1, "摘要段只该注册一次");
    const [section] = seen.sections;
    assert.ok(section !== undefined, "摘要段没注册上");
    assert.equal(section.name, "rtk-usage");
    // order 1565 写死在这里：它落在 zg 1550 / ocr 1555 / lesson-loop 1560 之后、jobs 1600 之前，
    // 改它要有人显式说一声（撞车不会报错，只会让段落次序变）。
    assert.equal(section.order, 1565);
    assert.ok(section.text.includes("rtk bypass"), "摘要正文少了唯一那条逃生写法");
  });

  it("口径全文注册成 skill `rtk`：正文与目录说明都取自当前语言的字典", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    assert.equal(seen.skills.length, 1, "全文只该注册一次");
    const [skill] = seen.skills;
    assert.ok(skill !== undefined, "skill 没注册上");
    assert.equal(skill.name, "rtk");
    assert.ok(skill.content.includes("# dsh-rtk"), "正文不是口径全文");
    assert.ok(skill.description.length > 0, "目录说明为空会让模型没有加载的理由");
  });

  it("skill 服务缺席时装配照常：摘要段已注册、skill 一条没有", () => {
    const { host, seen } = makeHost();
    // 抹掉 `skills` 服务：精简 profile 就是这个形状。
    const bare = {
      ...host,
      get: (name: string): unknown => (name === "skills" ? undefined : host.get(name)),
    } as unknown as HostServices;
    assert.doesNotThrow(() => {
      applyTo(bare, configSchema({}));
    });
    assert.equal(seen.sections.length, 1);
    assert.deepEqual(seen.skills, []);
  });

  it("同一作用域第二次装配让路：不重复注册、不抛错（market 热挂 + bundle 层双路径）", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    const injectsAfterFirst = seen.injects.length;
    const effectsAfterFirst = seen.effects.length;
    const registeredAfterFirst = seen.registered.size;
    const warnsAfterFirst = seen.warns.length;
    // 第一次装配经 `reflect.provide` 把单实例锁写进服务表；第二次同一个 host 读得到它 ⇒ 让路。
    assert.doesNotThrow(() => {
      applyTo(host, configSchema({}));
    }, "让路那一份不该抛：撞名抛错正是这条锁要挡掉的形态");
    assert.equal(seen.injects.length, injectsAfterFirst, "第二次不该再挂注入回调");
    assert.equal(seen.effects.length, effectsAfterFirst, "第二次不该再挂效应");
    assert.equal(seen.registered.size, registeredAfterFirst, "第二次不该再注册读取面");
    assert.equal(seen.warns.length, warnsAfterFirst + 1, "让路时留一条日志");
  });

  it("统计读面注册到 rtkStats（服务键 = 线上命名空间）", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    assert.equal(seen.registered.has(RTK_STATS_SERVICE_KEY), true);
  });

  it("storageDomain 打不开时只 warn 一句、装配照常走完（旧账本读不到不等于统计不可用）", async () => {
    // 迁移读的是**旧累计账本**，它读不到只意味着「新账本里没有这份快照」——而新账本照常记。
    // 所以这里的判据是「warn 一句 + 装配没被打断」，与「只留在内存」那种降级说法不同。
    const { host, seen } = makeHost({ open: () => Promise.reject(new Error("backend offline")) });
    applyTo(host, configSchema({}));
    await eventually(() =>
      warnLines(seen).some((line) => line.includes("cannot read the legacy accumulator")),
    );
    const lines = warnLines(seen);
    const failure = lines.find((line) => line.includes("cannot read the legacy accumulator"));
    assert.ok(failure !== undefined, `没留下读旧账本失败那句话：${lines.join(" | ")}`);
    assert.match(failure, /backend offline/u);
    assert.equal(seen.registered.has(RTK_STATS_SERVICE_KEY), true);
  });

  it("storageDomain 打得开就就地读一次并按 close 归还（读完不占域名）", async () => {
    let closed = 0;
    const { host, seen } = makeHost({
      open: (): Promise<LegacyStatsDomain> =>
        Promise.resolve({
          table: () => ({ get: noRecord }),
          close: (): Promise<void> => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    });
    applyTo(host, configSchema({}));
    await eventually(() => closed === 1);
    // 与旧那版不同：迁移**不挂 disposer**——它在开库那一步读完就关，避免同名域一直占着名字
    // 到进程结束（第二次装配会撞 `already-open`）。
    assert.equal(seen.effects.includes("rtk: stats domain"), false);
    assert.equal(closed, 1);
  });

  it("统计表开不出来时经具名 logger 留一行，装配照常走完", async () => {
    // 这一条走的是 `insights.warn` 那个回调（`host.ts` 里 `loggerOf(host).warn`）：
    // 账本路径的父级是一个普通文件，`openSqlite` 只能失败。判据是那句话**到了 logger**，
    // 而不是到了 console——装配层用的是具名 logger，回退到 console 是另一条路径。
    const { host, seen } = makeHost({ homeDir: unbuildableDir() });
    applyTo(host, configSchema({}));
    await eventually(() => warnLines(seen).some((line) => line.includes(OPEN_FAILED)));
    const lines = warnLines(seen);
    const failure = lines.find((line) => line.includes(OPEN_FAILED));
    assert.ok(failure !== undefined, `没留下开库失败那句话：${lines.join(" | ")}`);
    assert.match(failure, /report it as unavailable/u);
    // 统计库开不出来不该打掉装配：服务照常注册。
    assert.equal(seen.registered.has(RTK_STATS_SERVICE_KEY), true);
  });

  it("status() 现读：探不到版本时给 null 而不是「没装」的假值", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({ enabled: true, enabledForms: ["prefix", "pipe"] }));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => {
        readonly rtkPath: string | null;
        readonly rtkVersion: string | null;
        readonly enabled: boolean;
        readonly forms: readonly string[];
      };
    };
    const status = service.status();
    assert.equal(status.enabled, true);
    assert.deepEqual(status.forms, ["prefix", "pipe"]);
    // 版本探测走的是被替身的 subprocess（恒抛），所以版本一律 null。
    assert.equal(status.rtkVersion, null);
    // PATH 上有没有 rtk 取决于这台机器：判据是「要么 null，要么绝对路径」。
    assert.equal(status.rtkPath === null || path.isAbsolute(status.rtkPath), true);
  });

  it("探到版本时 status() 同时交出原文与 supported（两句话才分得开「没装」与「太旧」）", async () => {
    // 这一条走的是上面那条的**另一侧**：`probeVersion` 里 `probed === undefined` 的三元
    // 两支都得有人走，否则「探到了」那半永远没有用例——而卡片上「版本过低」那句话正靠它。
    const { host, seen } = makeHost({
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: {
            readFrom: () => ({ text: "rtk 1.2.1", nextOffset: 10, lossy: false }),
          },
        },
        terminate: noop,
      }),
    });
    // PATH 上可能真装着 rtk：这条用例判的是版本面，不是「装没装」，所以把两件事分开断言。
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => {
        readonly rtkVersion: string | null;
        readonly supported: boolean | null;
      };
    };
    await eventually(() => service.status().rtkVersion !== null);
    const status = service.status();
    assert.equal(status.rtkVersion, "rtk 1.2.1");
    assert.equal(status.supported, true);
  });

  it("探到的版本低于下限时 supported 是 false（不是 null）", async () => {
    // 三态的意义全在这一格上：`null` 是「没探到」，`false` 是「探到了但太旧」。卡片给前者
    // 安装命令、给后者升级指引，合成就没法把话说对。
    const { host, seen } = makeHost({
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: {
            readFrom: () => ({ text: "rtk 0.9.0", nextOffset: 10, lossy: false }),
          },
        },
        terminate: noop,
      }),
    });
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => { readonly supported: boolean | null };
    };
    await eventually(() => service.status().supported !== null);
    assert.equal(service.status().supported, false);
  });

  it("探不到 rtk 时记一条 warn（否则「开了开关没效果」是零线索）", async () => {
    // 判据是 warn 的**正文**，不是「有几条」：条数会随装配步数变，而这句话是 spec §7.1
    // 要求用户能在日志里看到的那一句。
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    await eventually(() => seen.warns.length > 0);
    assert.equal(seen.warns.length, 1);
    const [first] = seen.warns;
    assert.ok(first !== undefined);
    assert.ok(String(first[0]).includes("rtk not found on PATH"), String(first[0]));
  });

  it("探到但低于下限时 warn 点名版本与下限（与「没装」是两句不同的话）", async () => {
    const { host, seen } = makeHost({
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: "rtk 0.9.0", nextOffset: 10, lossy: false }) },
        },
        terminate: noop,
      }),
    });
    applyTo(host, configSchema({}));
    await eventually(() => seen.warns.length > 0);
    assert.equal(seen.warns.length, 1);
    const text = String(seen.warns[0]?.[0]);
    assert.ok(text.includes("rtk 0.9.0"), text);
    assert.ok(text.includes("minimum supported version"), text);
    assert.ok(!text.includes("not found on PATH"), "太旧不该报成没装");
  });

  it("探到且够新时一条 warn 都不记（正常状态不打扰日志）", async () => {
    const { host, seen } = makeHost({
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: "rtk 1.2.1", nextOffset: 10, lossy: false }) },
        },
        terminate: noop,
      }),
    });
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => { readonly rtkVersion: string | null };
    };
    // 这里要等的是「探测跑完了」，不是「时间过去了」：`probeRtkVersion` 是 fire-and-forget，
    // 固定等一小段在慢机器上会在探测落地**之前**就断言「一条都没有」——那等于把漏报当通过。
    await eventually(() => service.status().rtkVersion !== null);
    // 先确认探测**真的落地了**，再断「一条 warn 都没有」：只断后者的话，探测还没跑完时
    // 它天然成立，漏报会被当成通过。
    assert.equal(service.status().rtkVersion, "rtk 1.2.1");
    assert.equal(seen.warns.length, 0);
  });

  it("装配期问一次 rtk pipeline validate：rc=1 时把 E000/W025 写进 warn", async () => {
    // rtk 对坏 pipeline 是静默降级：装配写出的 pipeline.toml 坏掉时，`rtk hook` 仍回 0，
    // 只剩 pipeline-status.json 里一行没人读的诊断。这一条钉住「插件自己在装配期问出来」。
    let spawns = 0;
    const { host, seen } = makeHost({
      spawn: () => {
        spawns += 1;
        const failed = spawns > 1;
        const text = failed
          ? "E000 not valid TOML\nW025 ... has errors and is not loaded — your other pipeline files stay active"
          : "rtk 1.2.1";
        return {
          done: Promise.resolve({ exitCode: failed ? 1 : 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          },
          terminate: noop,
        };
      },
    });
    applyTo(host, configSchema({}));
    // 判据是 warn 的正文，不是条数：版本探测成功不记 warn，校验失败那条是唯一一条。
    await eventually(() =>
      warnLines(seen).some((line) => line.includes("rejected by rtk pipeline validate")),
    );
    const [only] = warnLines(seen);
    assert.ok(only !== undefined);
    assert.ok(only.includes("E000 not valid TOML"), only);
    assert.equal(spawns, 2, "版本探测 + 一次校验");
  });

  it("校验失败但 rtk 没给诊断时写 no diagnostics，而不是留一对空括号", async () => {
    // rc=1 且 stdout 为空：成因可能是权限、超时或 rtk 自己没话说。空括号读起来像插件漏了正文。
    let spawns = 0;
    const { host, seen } = makeHost({
      spawn: () => {
        spawns += 1;
        const failed = spawns > 1;
        const text = failed ? "" : "rtk 1.2.1";
        return {
          done: Promise.resolve({ exitCode: failed ? 1 : 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          },
          terminate: noop,
        };
      },
    });
    applyTo(host, configSchema({}));
    await eventually(() =>
      warnLines(seen).some((line) => line.includes("rejected by rtk pipeline validate")),
    );
    const [only] = warnLines(seen);
    assert.ok(only?.includes("(no diagnostics)") === true, String(only));
  });

  it("版本过旧时不 spawn pipeline validate（否则「没装/太旧」会被报成 TOML 坏了）", async () => {
    let spawns = 0;
    const { host, seen } = makeHost({
      spawn: () => {
        spawns += 1;
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: {
              readFrom: () => ({ text: "rtk 0.9.0", nextOffset: 10, lossy: false }),
            },
          },
          terminate: noop,
        };
      },
    });
    applyTo(host, configSchema({}));
    await eventually(() => seen.warns.length > 0);
    const text = warnLines(seen).join("\n");
    assert.ok(text.includes("minimum supported version"), text);
    assert.ok(!text.includes("pipeline validate"), text);
    assert.equal(spawns, 1, "只问了版本，没有第二条 spawn");
  });

  it("没有 logger 服务时回退 console.warn，而不是把这条痕迹丢掉", async () => {
    // 手接 console.warn 而不是用 spy 库：这一条要证的只是「回退路径确实写了」，
    // 而 vitest 的 spy 在这里用不上（本仓只从 vitest 取 describe/it/onTestFinished，
    // 引 `vi` 会顺带把整个 mock 命名空间拖进这条门禁的依赖面）。
    const original = console.warn;
    const calls: (readonly unknown[])[] = [];
    console.warn = (...args: unknown[]): void => {
      calls.push(args);
    };
    try {
      const { host } = makeHost({ omitLogger: true });
      applyTo(host, configSchema({}));
      await eventually(() => calls.length > 0);
    } finally {
      console.warn = original;
    }
    assert.equal(calls.length, 1);
    assert.ok(String(calls[0]?.[0]).includes("rtk not found on PATH"));
  });

  it("overview() 读的是那份延迟账本（先内存，初始为零）", async () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly overview: () => Promise<StatsOverview>;
    };
    const before = await service.overview();
    // 两类账本都还是空的：prefix 的计数来自插件库（延迟打开，此时为内存空表），
    // pipe 同源。断两个形态而不是只断一个 —— 只看 prefix 会漏掉「pipe 分支根本没接上」。
    assert.equal(before.today.prefix.commands, 0);
    assert.equal(before.today.pipe.commands, 0);
  });

  it("部署默认模式是只读时，overview() 的 prefix 判 readonly 且不去开 rtk 的库", async () => {
    // 这条串起了三段：host 的 `get("sandboxPolicy")` → `sandboxModeOf` 读 `defaultMode`
    // → service 的 `readLedger` 提前返回。只读时账本目录可能根本不存在，真去开还会
    // 撞「文件不存在」，所以「不读」本身就是正确行为，不能只当成省一次 IO。
    const { host, seen } = makeHost({ sandboxPolicy: { defaultMode: "read-only" } });
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly overview: () => Promise<StatsOverview>;
    };
    const before = await service.overview();
    assert.equal(before.availability.prefix, "readonly");
    // 计数不受影响：只读的是沙箱，不是插件的账本。
    assert.equal(before.today.prefix.commands, 0);
  });

  it("pipe 页在库打开后会去读现配的 enabledFilters（不是装配时的快照）", async () => {
    // 这条专门压 apply 里那个 `enabledFilters: () => [...withDefault(...)]` 闭包：
    // 它是「用户改了 filter 名单，页面建议跟着变」的唯一通路。写成装配期算好的数组
    // 也能让别的用例全绿，但改配置后建议就冻在旧名单上——所以必须由一次真实读来钉住。
    const { host, seen } = makeHost();
    applyTo(host, configSchema({ enabledFilters: [FILTER_CARGO] }));
    // 等库真的开出来：`insights.load()` 是 fire-and-forget，`store()` 在它落地前恒为 undefined，
    // 而 undefined 会让 availability.pipe 报 unavailable——固定等一小段就是在赌它跑得完。
    await eventually(() => seen.effects.includes("rtk: insights store"));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly insights: (request: { form: "pipe"; rangeDays: 7; granularity: "day" }) => Promise<{
        readonly availability: { readonly pipe: string };
      }>;
    };
    const page = await service.insights({ form: "pipe", rangeDays: 7, granularity: "day" });
    // 库在临时目录里确实打开了，所以这里不是「库缺席所以没读」那条路。
    assert.equal(page.availability.pipe, "ok");
  });
});

describe("createLocaleMessages", () => {
  it("不设 locale 偏好时回默认语言，切到 en 后同一个 thunk 立刻改口", () => {
    const { host, setLocale } = makeHost();
    const messages = createLocaleMessages(host);
    const zh = messages().cargoTestWarnHint;
    setLocale("en-US");
    const en = messages().cargoTestWarnHint;
    assert.notEqual(zh, en, "切语言后 thunk 还是旧文案 ⇒ 用户要重载插件");
    assert.match(en, /cargo build/u);
  });

  it("非法 locale 值回退默认语言，而不是抛错", () => {
    const { host } = makeHost({ locale: "klingon" });
    assert.match(createLocaleMessages(host)().cargoTestWarnHint, /cargo build/u);
  });
});

/**
 * 记下所有 `ctx.on` 的事件名（装配期注册了哪些监听）。
 *
 * 放在模块层而不是 describe 里面：`unicorn(consistent-function-scoping)` 要求不捕获外层变量的
 * 函数提到最外层——它确实一个都不捕获（只吃入参）。
 */
function recording(host: HostServices): { readonly host: HostServices; readonly events: string[] } {
  const events: string[] = [];
  const wrapped = {
    ...host,
    on: (name: string): (() => void) => {
      events.push(name);
      return noop;
    },
  } as unknown as HostServices;
  return { host: wrapped, events };
}

describe("形态常驻与运行期门禁", () => {
  it("b 形态常驻：enabledForms 不含 pipe 时监听器也注册", () => {
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, configSchema({ enabled: true, enabledForms: ["prefix"] }));
    assert.equal(events.includes(POST_EXECUTE), true);
  });

  it("c 形态常驻：enabledForms 只有 pipe 时也注册 agent/created", () => {
    // 先把 rtk 造出来：不造的话这台机器上「找不到 rtk」会先挡掉装配，测出来的
    // 就不是「形态不再决定装不装」这条判据。三个平台都只剩 rtk 这一道装配门禁。
    withRtkOnPath();
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, configSchema({ enabled: true, enabledForms: ["pipe"] }));
    assert.equal(events.includes(AGENT_CREATED), true);
  });

  it("默认配置 enabled 无静态值，两层都常驻", () => {
    // 默认开启由版本探测结果兜底，不是 schema 静态默认；两层常驻是热切换的承重结构。
    withRtkOnPath();
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    const config = configSchema({});
    assert.equal(config.enabled.get(), undefined);
    applyTo(host, config);
    assert.deepEqual(events, [AGENT_CREATED, POST_EXECUTE]);
  });
});
/**
 * 十一个 volatile 全返空引用的配置。
 *
 * 官方 `Volatile.get()` 的 d.ts 原文是「including undefined for an absent value」——
 * 条目没被 volatile 投影、或宿主退化时，交回来的就是空引用。那些 `.get()` 后面的 `?? 默认`
 * 因此是**必要分支**，不是防御性代码。
 */
function emptyVolatileConfig(): Parameters<typeof plugin.apply>[1] {
  const absent = { get: (): undefined => undefined };
  return {
    enabled: absent,
    enabledForms: absent,
    denyCommands: absent,
    enabledFilters: absent,
    minBytes: absent,
    minGainRatio: absent,
    stdoutCapBytes: absent,
    windowHeadLines: absent,
    windowTailLines: absent,
    warnHint: absent,
    rewriteHostEnv: absent,
    pipeTimeoutMs: 3000,
    rewriteTimeoutMs: 2000,
    rewriteCacheSize: 256,
    vitestMaxMajor: 5,
    logFilterMode: "off",
  };
}

/**
 * 可变的配置替身：`set` 改值之后，**之前已经交出去的**取值函数必须立刻读到新值。
 *
 * 这是 volatile 语义的唯一判据面：装配期若做快照，用例读到的就永远是装配那一刻的值。
 */
function liveConfig(): {
  readonly config: Parameters<typeof plugin.apply>[1];
  readonly set: (key: string, value: unknown) => void;
} {
  const slots = new Map<string, unknown>([
    ["enabled", true],
    ["enabledForms", ["prefix"]],
    ["denyCommands", []],
    ["warnHint", true],
    ["rewriteHostEnv", ""],
    ["enabledFilters", [FILTER_CARGO]],
    ["minBytes", 256],
    ["minGainRatio", 0.95],
    ["stdoutCapBytes", 64_000],
    // 窗口那两位也要在槽里：`liveConfig` 只给列进这张表的键装上 `{get}`，
    // 漏了它们会退到 `base` 的 `absent`，于是 `set` 写得进去而读取点永远拿兜底值——
    // 症状正是「改了卡片不生效」，而正常路径上看不出来。
    ["windowHeadLines", 50],
    ["windowTailLines", 200],
  ]);
  const base = emptyVolatileConfig() as unknown as Record<string, unknown>;
  const config = {
    ...base,
    ...Object.fromEntries(
      Array.from(slots, ([key]) => [key, { get: (): unknown => slots.get(key) }]),
    ),
  } as unknown as Parameters<typeof plugin.apply>[1];
  return {
    config,
    set: (key, value) => {
      slots.set(key, value);
    },
  };
}

describe("volatile 读到空引用时不崩（宿主的退化态）", () => {
  it("十一个 volatile 全空时装配照常完成：形态退到默认 ['prefix']，两层都常驻", () => {
    // 装配期门禁只剩 PATH 上有 rtk（不造出来这条判据就跟着跑测机器走）。
    withRtkOnPath();
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, emptyVolatileConfig());
    assert.deepEqual(
      events,
      [AGENT_CREATED, POST_EXECUTE],
      "空引用等于「没配」：形态退默认，两层仍常驻，运行期再判形态与总开关",
    );
  });

  it("status() 在受支持版本探测回来前把空 enabled 读成 false", () => {
    const { host, seen } = makeHost();
    applyTo(host, emptyVolatileConfig());
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => { readonly enabled: boolean; readonly forms: readonly string[] };
    };
    const status = service.status();
    assert.equal(status.enabled, false);
    assert.deepEqual(status.forms, ["prefix"]);
    // 复制语义：读面每次交回的数组是独立的一份，就地改它不会反改配置。
    status.forms.push("pipe");
    assert.deepEqual((service.status() as { readonly forms: readonly string[] }).forms, ["prefix"]);
  });
});
describe("volatile 的取值函数：装配期交出去的是「怎么读」，不是「读到的值」", () => {
  it("c 形态的四位：改配置之后取值函数读到的是新值（不是装配那一刻的快照）", () => {
    const { config, set } = liveConfig();
    const readers = prefixReadersOf(config, () => true);
    assert.equal(readers.enabled(), true);
    assert.deepEqual([...readers.denyCommands()], []);
    assert.equal(readers.warnHint(), true);
    assert.equal(readers.rewriteHostEnv(), "");
    set("enabled", false);
    set("denyCommands", ["gh"]);
    set("warnHint", false);
    set("rewriteHostEnv", "openclaw");
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.denyCommands()], ["gh"]);
    assert.equal(readers.warnHint(), false);
    assert.equal(readers.rewriteHostEnv(), "openclaw");
  });

  it("b 形态的七位：改配置之后取值函数读到的是新值", () => {
    const { config, set } = liveConfig();
    const readers = pipeReadersOf(config, () => true);
    assert.equal(readers.enabled(), true);
    assert.deepEqual([...readers.enabledFilters()], [FILTER_CARGO]);
    assert.equal(readers.minBytes(), 256);
    assert.equal(readers.minGainRatio(), 0.95);
    assert.equal(readers.stdoutCapBytes(), 64_000);
    assert.equal(readers.windowHeadLines(), 50);
    assert.equal(readers.windowTailLines(), 200);
    set("enabled", false);
    set("enabledFilters", ["pytest"]);
    set("minBytes", 1);
    set("minGainRatio", 0.5);
    set("stdoutCapBytes", 100);
    set("windowHeadLines", 5);
    set("windowTailLines", 7);
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.enabledFilters()], ["pytest"]);
    assert.equal(readers.minBytes(), 1);
    assert.equal(readers.minGainRatio(), 0.5);
    assert.equal(readers.stdoutCapBytes(), 100);
    assert.equal(readers.windowHeadLines(), 5);
    assert.equal(readers.windowTailLines(), 7);
  });

  it("退化态（volatile 交回空引用）下 enabled 跟随就绪探测，而不是写死 true", () => {
    // 这两份兜底散在 `apply` 里时没有任何判据：只有「volatile 读到空引用」那种退化态
    // 才会走它们，而正常装出来的行为一模一样。
    const readers = prefixReadersOf(emptyVolatileConfig(), () => false);
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.denyCommands()], []);
    assert.equal(readers.warnHint(), true);
    assert.equal(readers.rewriteHostEnv(), "");
    const pipes = pipeReadersOf(emptyVolatileConfig(), () => true);
    assert.equal(pipes.enabled(), true);
    assert.deepEqual([...pipes.enabledFilters()], [...DEFAULT_ENABLED_FILTERS]);
    assert.equal(pipes.minBytes(), 256);
    assert.equal(pipes.minGainRatio(), 0.95);
    assert.equal(pipes.stdoutCapBytes(), 64_000);
    // 窗口那两位与 rtk `cap` 的 HEAD_LINES / TAIL_LINES 同值：退化态下也要落到同一组数，
    // 否则「卡片没读到」会静默变成另一种切法。
    assert.equal(pipes.windowHeadLines(), 50);
    assert.equal(pipes.windowTailLines(), 200);
  });

  it("c/b 两层读同一个 enabled：一处开关不能只作用于其中一层", () => {
    const { config, set } = liveConfig();
    const prefix = prefixReadersOf(config, () => true);
    const pipe = pipeReadersOf(config, () => true);
    set("enabled", false);
    assert.equal(prefix.enabled(), pipe.enabled(), "两层的总开关必须是同一个判据");
  });

  it("formsReaderOf 每次现读 enabledForms（形态热切换的数据面）", () => {
    const { config, set } = liveConfig();
    const forms = formsReaderOf(config);
    assert.deepEqual([...forms()], ["prefix"]);
    set("enabledForms", ["prefix", "pipe"]);
    assert.deepEqual([...forms()], ["prefix", "pipe"]);
  });

  it("enabled 未显式设置时跟随就绪探测：ready 翻转后下一次读取就变", () => {
    const { config, set } = liveConfig();
    set("enabled", undefined);
    let ready = false;
    const readers = prefixReadersOf(config, () => ready);
    assert.equal(readers.enabled(), false);
    ready = true;
    assert.equal(readers.enabled(), true);
    set("enabled", false);
    assert.equal(readers.enabled(), false, "显式 false 必须压过 ready=true");
  });
});

describe("b 形态的走线（经 apply 装配之后才拿得到的那一份依赖）", () => {
  /**
   * `apply` 里 B 形态的 `fs.readFile` 是就地写的箭头（`readFile(target, "utf8")`）——它只有在
   * **真实监听器**被调用、且回执是「截断过、带 spillPath」时才跑到。直接测 `installPostExecuteListener`
   * 接不到这一份：那里的 `fs` 是测试自己塞的桩。所以这条用例从 `apply` 拿监听器。
   */
  it("截断输出先按 spillPath 读回全文再压（喂给 pipe 的是全文，不是那截尾巴）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rtk-apply-"));
    const spillPath = path.join(dir, "spill.txt");
    // 真实的截断回执长这样：`stdout.text` 是被留下的一大段**尾部**（宿主按字节帽截尾），
    // 全文在 spill 文件里。两侧都给足长度，否则 `minBytes` 与 low-gain 会先把这条链挡掉。
    const head = "log line\n".repeat(200);
    const tail = "log line\n".repeat(200);
    writeFileSync(spillPath, `${head}${tail}running 1 test\ntest result: ok. 1 passed; 0 failed\n`);
    // 假 rtk：`--version` 回一行版本串，`pipe` 回一段压小的摘要，并把喂进来的 stdin 记下来。
    const piped: string[] = [];
    const { host } = makeHost({
      spawn: (spec: SpawnSpec) => {
        if (spec.argv[1] === "pipe") {
          // `stdio.stdin` 在本包的 pipe 路径上恒是 `{data}`（`runRtkPipe` 就是这么传的），
          // 所以这里直接取 `data`；另两种形状由 `lib/cli.ts` 自己的用例覆盖。
          const { stdin } = spec.stdio;
          piped.push(typeof stdin === "object" ? (stdin.data ?? "") : "");
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: {
                readFrom: () => ({
                  text: "test result: ok. 1 passed; 0 failed",
                  nextOffset: 0,
                  lossy: false,
                }),
              },
            },
            terminate: noop,
          };
        }
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: "rtk 1.2.1", nextOffset: 9, lossy: false }) },
          },
          terminate: noop,
        };
      },
    });
    let listener:
      | ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    const wrapped = {
      ...host,
      on: (name: string, handler: never): void => {
        if (name === POST_EXECUTE) {
          listener = handler as typeof listener;
        }
      },
    };
    applyTo(
      wrapped as unknown as HostServices,
      // filter 显式给：默认集合装的是前缀层交不出去的那几条（git-log/git-diff/…），
      // 这条用例要吃的是 `cargo-test` 这一支，靠默认值会连 pipe 都不 spawn。
      configSchema({
        enabled: true,
        enabledForms: ["prefix", "pipe"],
        enabledFilters: [FILTER_CARGO],
      }),
    );
    assert.ok(listener !== undefined, "开了 pipe 形态却没挂监听器");
    // 会话身份是 spill 的 owner：没有 agent 时没有取回通道，有损压缩会被整条放弃。
    const exec = {
      callId: "call-1",
      name: "bash",
      arguments: { command: "cargo test" },
      agent: { id: "apply-session" },
    };
    const result = {
      isError: false,
      content: [],
      value: {
        kind: "foreground",
        exitCode: 0,
        stdout: { text: tail, truncated: true, spillPath },
        stderr: { text: "" },
      },
    };
    const decision = await listener(exec, result, () => Promise.resolve({ kind: "accept" }));
    // 两条判据缺一不可：
    //   ① `fs.readFile` 真的跑了——喂给 pipe 的 stdin 必须是**全文**（含只有文件里才有的那段 head），
    //      而不是回执里那截尾巴。这条守在 `apply` 内联的 `readFile(target, "utf8")` 上；
    //   ② 压缩结果真的替换进了 value 的 `stdout.text`（不是「原样放行」那种什么都证明不了的绿）。
    assert.equal(piped.length, 1, "pipe 没被调用：读全文这条链没走到");
    assert.ok(String(piped[0]).includes(head), "喂给 pipe 的不是全文（spillPath 那段没读回来）");
    const accepted = decision as {
      readonly kind: string;
      readonly value?: { readonly stdout?: { readonly text?: string } };
    };
    assert.equal(accepted.kind, "accept");
    assert.equal(accepted.value?.stdout?.text, "test result: ok. 1 passed; 0 failed");
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `hook: () => hookEnv` 这一句只在**监听器真的走到「无 filter」那条路**时被求值，所以
   * 前面所有用例都没碰到它（覆盖率在那一行留着洞）。它同时钉住装配期那一步：
   * `$DSH_HOME/rtk/config/pipeline.toml` 真的被写出来了，内容是 `pipelineToml()` 那份。
   */
  it("装配期写出一份 pipeline.toml，且无 filter 的长输出会真的走 rtk hook", async () => {
    const hookCalls: string[] = [];
    const { host } = makeHost({
      spawn: (spec: SpawnSpec) => {
        if (spec.argv[1] === "hook") {
          const { stdin } = spec.stdio;
          hookCalls.push(typeof stdin === "object" ? (stdin.data ?? "") : "");
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: {
                readFrom: () => ({
                  // `rtk hook claude` 的回执：清洗后的正文在 `updatedToolOutput.stdout` 里。
                  // 故意保留同样的行数、只把每行压短：行数不塌缩才是这条用例想验的路径
                  // （护栏会把「行数塌缩」判成 `folded-entries`，那条需要有 spill 通道才放行，
                  // 而这里要验的是「换值真的发生了」）。
                  text: JSON.stringify({
                    hookSpecificOutput: { updatedToolOutput: { stdout: CLEANED } },
                  }),
                  nextOffset: 0,
                  lossy: false,
                }),
              },
            },
            terminate: noop,
          };
        }
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: "rtk 1.2.1", nextOffset: 9, lossy: false }) },
          },
          terminate: noop,
        };
      },
    });
    let listener:
      | ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    applyTo(
      {
        ...host,
        on: (name: string, handler: never): void => {
          if (name === POST_EXECUTE) {
            listener = handler as typeof listener;
          }
        },
      } as unknown as HostServices,
      // 两项都显式列出：它们现在都在默认集合里，但这条用例验的是「这两条路真的接上了」，
      // 不该随着默认值漂移而变成另一种测法。
      configSchema({ enabled: true, enabledForms: ["pipe"], enabledFilters: ["hook", "window"] }),
    );
    assert.ok(listener !== undefined, "开了 pipe 形态却没挂监听器");
    // 配置在装配期就写好了：这条路径不许等到第一次调用才建。
    const toml = readFileSync(
      path.join(process.env["DSH_HOME"] ?? "", "rtk", "config", "pipeline.toml"),
      "utf8",
    );
    assert.ok(toml.includes('extends = "rtk:posthook"'), toml);
    assert.ok(toml.includes('name = "dsh-clean"'), toml);
    // 一条既不在 `PIPE_TABLE` 里、又是日志目标的命令：走「无 filter → hook」那条路。
    const body = `${LONG_LINE.repeat(40)}[exit code: 0]`;
    const exec = {
      callId: "call-hook",
      name: "bash",
      arguments: { command: "cat build.log" },
      agent: { id: "apply-hook-session" },
    };
    const result = {
      isError: false,
      content: [],
      value: {
        kind: "foreground",
        exitCode: 0,
        stdout: { text: body, truncated: false },
        stderr: { text: "" },
      },
    };
    const decision = await listener(exec, result, () => Promise.resolve({ kind: "accept" }));
    assert.equal(hookCalls.length, 1, "无 filter 的长输出没走清理链");
    assert.equal(hookCalls[0]?.includes(LONG_LINE.trim()), true, "喂给 hook 的不是正文");
    const accepted = decision as {
      readonly kind: string;
      readonly value?: { readonly stdout?: { readonly text?: string } };
    };
    assert.equal(accepted.kind, "accept");
    // 退出 marker 是**另一段**（`extractBody` 把它从 stdout 里切走），压完之后 `reassemble`
    // 原样拼回去——所以期望值是「压后的正文 + 换行 + marker」，不是把 marker 也喂给 hook。
    assert.equal(accepted.value?.stdout?.text, `${CLEANED}\n[exit code: 0]`);
  });

  it("path 上没有 rtk 时 status() 的 rtkPath 是 null（不是空串、不是抛错）", () => {
    // 本机装了 rtk，`findOnPath` 就会一直回真路径 ⇒ `?? null` 右侧永远取不到。
    // 把 PATH 临时清空是唯一能走到那一侧的办法，而它也正是产品要答的问题：
    // 「没装 rtk」与「装了但探不到版本」是两件事，卡片的这一行必须能分开说。
    const original = process.env["PATH"];
    process.env["PATH"] = "";
    onTestFinished(() => {
      process.env["PATH"] = original;
    });
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly status: () => { readonly rtkPath: string | null };
    };
    assert.equal(service.status().rtkPath, null);
  });
});
