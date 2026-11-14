// test/apply.test.ts —— 总装那一层：六个服务面齐全才装、装配顺序、以及失败不该打掉压缩。
//
// 这一层刻意**不复用** `test/integration/host-stack.ts` 的半栈桩：那些桩只造四个服务
// （`HostContext` 面），而 `apply` 要的是 `HostServices`（多 settings / storageDomain /
// inject / effect / fiber）。两套桩分开，谁都不必为对方多造字段。
//
// 时钟与网络都用替身：`storageDomain.open` 是可控 Promise，`subprocess.spawn` 恒失败
// （版本探测探不到就是探不到，装配必须照常）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  withDefault,
  loggerOf,
  makeCountRewrite,
  pipeReadersOf,
  prefixReadersOf,
} from "../host.ts";
import type { HostServices } from "../host.ts";
import { DEFAULT_ENABLED_FILTERS } from "../lib/command-filter.ts";
import { RTK_STATS_SERVICE_KEY } from "../lib/stats-remote.ts";
import type { StatsDomain } from "../lib/stats-store.ts";
import type { StatsSummary } from "../lib/stats-shape.ts";

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
}

/** `tools/post-execute` 的事件名（本文件多处断言它挂没挂）。 */
const POST_EXECUTE = "tools/post-execute";

/** `agent/created` 的事件名（C 形态的判据）。 */
const AGENT_CREATED = "agent/created";

/**
 * C 形态只在 POSIX 上存在，凡是断言「C 形态装没装」的用例都是 POSIX-only。
 *
 * `prefixSupportedOn("win32")` 判否、`installPrefixShadow` 在平台门禁处直接 return —— 这是
 * spec §7.2 的保守档（rtk 的 Windows 分发面与 pwsh 命令形态都没在真机验过，而前缀形态把命令
 * 写坏是「本来能跑的命令不能跑」），不是缺陷。所以同一个 `events` 在 Windows 上**因为平台**
 * 就是空的：不标注的话，这些用例要么整片红（断言「装了」），要么因为错的理由通过（断言「没装」）。
 *
 * 平台判定本身由 `test/platform/platform.test.ts` 显式注入 win32 覆盖，遮蔽层的行为面由
 * `test/prefix-integration.test.ts`（同样 POSIX-only）覆盖。
 */
const POSIX_ONLY = process.platform !== "win32";

/** 占位实现：只需要「存在且是可调用函数」，不需要任何行为。 */
function noop(): void {
  void 0;
}

/**
 * 空表的 `get`：空表就是「没有这条记录」，所以恒回 `undefined`。
 * 不用 `noop`：它的返回类型是 `void`，而 `StatsTable.get` 要的是 `StatsAccumulator | undefined`
 * ——`void` 不等于 `undefined`（`strictNullChecks` 下两者在返回值位置不可互换）。
 */
const noRecord = (): undefined => void 0;

/** 默认的域：打开即成功、close 幂等——只为不污染跑测输出，不承担任何断言。 */
async function silentDomain(): Promise<StatsDomain> {
  return {
    table: () => ({
      get: noRecord,
      put: () => Promise.resolve(),
    }),
    close: () => Promise.resolve(),
  };
}

/** 子进程 spawn 的最小可读面：这一层只关心 argv 与喂进去的 stdin。 */
interface SpawnSpec {
  readonly argv: readonly string[];
  readonly stdio: { readonly stdin?: { readonly data?: string } | "ignore" };
}

/** 等一小段：`apply` 里启动的存储动作是异步的，用例得让它落地。 */
async function settle(): Promise<void> {
  await sleep(10);
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
    readonly open?: () => Promise<StatsDomain>;
    /**
     * 子进程面；默认恒抛 ENOENT（= 这台机器上没装 rtk）。
     *
     * 收 `spec` 而不是无参：B 形态那条走线要区分 `rtk --version`（装配期探测）与
     * `rtk pipe`（压缩），也就要看 argv；同时要能读回喂给 pipe 的 stdin。
     */
    readonly spawn?: (spec: SpawnSpec) => never | Record<string, unknown>;
    /** 去掉 logger 服务，走 `loggerOf` 的 console 回退那条兼容路径。 */
    readonly omitLogger?: boolean;
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
  };
  // `settings.describe()` 交回的是**命名空间的设置对象**，语言偏好在它的 `preference` 字段里
  // （shared 的 `resolveLocalePreference` 就按这个字段读）——不是裸字符串。
  let preference: unknown = overrides.locale;
  const settings = {
    describe: (): { readonly ns: string; readonly value: unknown }[] => [
      { ns: "locale", value: { preference } },
    ],
    configure: (presentation: { readonly auto?: boolean }, owner?: unknown): (() => void) => {
      seen.configure.push({ presentation, owner });
      return noop;
    },
  };
  const host = {
    settings,
    storageDomain: {
      // 默认给一份能打开、能关掉的域：打不开那条路径由专门那条用例显式传 `open` 进来测。
      // 反过来（默认失败）会让**每条**用例都往 stderr 打一行 warn，跑测输出里全是噪音。
      open: overrides.open ?? silentDomain,
    },
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
    get: (name: string): unknown => seen.registered.get(name),
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
 * C 形态的装配期门禁第三条就是「PATH 上找得到 rtk」。断言「装配动作发生了」的用例若不自己
 * 把 rtk 造出来，判据就变成「跑测那台机器装没装 rtk」：开发机装着、CI runner 上没装，**同一份
 * 代码在两处给出两个结论**。本仓真实踩过这一格（CI 三平台全红、本地全绿）。
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
  it.each(["settings", "storageDomain", "tools", "subprocess", "workingDirectory"] as const)(
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

  it("改写的记账走 accumulate({ form: 'prefix' })：只加命令数，不碰字节", () => {
    const calls: unknown[] = [];
    const stats = {
      accumulate: (input: unknown): void => {
        calls.push(input);
      },
    } as unknown as Parameters<typeof makeCountRewrite>[0];
    makeCountRewrite(stats)();
    assert.deepEqual(calls, [{ form: "prefix" }]);
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

  it("统计读面注册到 rtkStats（服务键 = 线上命名空间）", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    assert.equal(seen.registered.has(RTK_STATS_SERVICE_KEY), true);
  });

  it("storageDomain 打不开也照样装完，并且 warn 一句说清楚只影响统计", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.join(" "));
    };
    onTestFinished(() => {
      console.warn = original;
    });
    const { host } = makeHost({ open: () => Promise.reject(new Error("backend offline")) });
    applyTo(host, configSchema({}));
    await settle();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /只留在内存/u);
    assert.match(warnings[0] ?? "", /backend offline/u);
  });

  it("storageDomain 打得开就挂一个 disposer 收域句柄（谁 open 谁 close）", async () => {
    let closed = 0;
    const { host, seen } = makeHost({
      open: (): Promise<StatsDomain> =>
        Promise.resolve({
          table: () => ({
            get: noRecord,
            put: () => Promise.resolve(),
          }),
          close: (): Promise<void> => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    });
    applyTo(host, configSchema({}));
    assert.equal(seen.effects.includes("rtk: stats domain"), false, "disposer 要等 open 落地才挂");
    await settle();
    assert.equal(seen.effects.includes("rtk: stats domain"), true);
    // 卸载时按注册逆序跑的清理函数里就有 close。
    for (const dispose of seen.disposers) {
      dispose();
    }
    assert.equal(closed, 1);
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
    assert.equal(status.rtkPath === null || status.rtkPath.endsWith("rtk"), true);
  });

  it("探到版本时 status() 同时交出原文与 supported（两句话才分得开「没装」与「太旧」）", async () => {
    // 这一条走的是上面那条的**另一侧**：`probeVersion` 里 `probed === undefined` 的三元
    // 两支都得有人走，否则「探到了」那半永远没有用例——而卡片上「版本过低」那句话正靠它。
    const { host, seen } = makeHost({
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: {
            readFrom: () => ({ text: "rtk 1.2.0", nextOffset: 10, lossy: false }),
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
    await settle();
    const status = service.status();
    assert.equal(status.rtkVersion, "rtk 1.2.0");
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
    await settle();
    assert.equal(service.status().supported, false);
  });

  it("探不到 rtk 时记一条 warn（否则「开了开关没效果」是零线索）", async () => {
    // 判据是 warn 的**正文**，不是「有几条」：条数会随装配步数变，而这句话是 spec §7.1
    // 要求用户能在日志里看到的那一句。
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    await settle();
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
    await settle();
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
          stdout: { readFrom: () => ({ text: "rtk 1.2.0", nextOffset: 10, lossy: false }) },
        },
        terminate: noop,
      }),
    });
    applyTo(host, configSchema({}));
    await settle();
    assert.equal(seen.warns.length, 0);
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
      await settle();
    } finally {
      console.warn = original;
    }
    assert.equal(calls.length, 1);
    assert.ok(String(calls[0]?.[0]).includes("rtk not found on PATH"));
  });

  it("summary() 走的是那份延迟账本（先内存，初始为零）", () => {
    const { host, seen } = makeHost();
    applyTo(host, configSchema({}));
    const service = seen.registered.get(RTK_STATS_SERVICE_KEY) as {
      readonly summary: () => StatsSummary;
    };
    const before = service.summary();
    assert.equal(before.commands, 0);
    assert.equal(before.savedBytes, 0);
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

describe("形态开关决定装哪条链", () => {
  it("enabledForms 不含 pipe 时 B 形态不装（默认配置就是这一档）", () => {
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, configSchema({ enabled: true, enabledForms: ["prefix"] }));
    assert.equal(events.includes(POST_EXECUTE), false);
  });

  it("enabledForms 含 pipe 时 B 形态挂上（它的门禁只有形态开关）", () => {
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, configSchema({ enabled: true, enabledForms: ["prefix", "pipe"] }));
    assert.equal(events.includes(POST_EXECUTE), true);
  });

  it.skipIf(!POSIX_ONLY)("enabledForms 不含 prefix 时 C 形态不装", () => {
    // 同样要先把 rtk 造出来：不造的话这条负例在没装 rtk 的机器上**因为错的理由**通过
    // （门禁第三条就把它挡掉了），而它要证的是「形态开关单独就能挡住装配」。
    //
    // 同理也必须是 POSIX-only：Windows 上平台门禁先把它挡掉，这条负例就成了「因为平台而通过」，
    // 与它声称的判据（形态开关）无关。
    withRtkOnPath();
    const { host: base } = makeHost();
    const { host, events } = recording(base);
    applyTo(host, configSchema({ enabled: true, enabledForms: ["pipe"] }));
    assert.equal(events.includes(AGENT_CREATED), false);
  });

  it.skipIf(!POSIX_ONLY)(
    "用户开关默认关闭时：C 形态照装（开关运行期才判），B 形态不装（形态不含 pipe）",
    () => {
      // 「默认关」不等于「不装」。`enabled` 是 volatile，用户是在卡片上打开它的，而 `apply` 只跑
      // 一次——装配期若按 `enabled` 早退，用户之后打开开关就没有任何东西会去补装，默认路径整条
      // 不通。所以装配期只判形态与环境，总开关留给执行期现读。
      //
      // 「环境」那一条是 PATH 上找得到 rtk：不自己造，这条断言测的就是跑测那台机器。
      // 平台那一条（win32 不装）不在本用例的判据里，见 `POSIX_ONLY`。
      withRtkOnPath();
      const { host: base } = makeHost();
      const { host, events } = recording(base);
      applyTo(host, configSchema({}));
      assert.deepEqual(events, [AGENT_CREATED]);
    },
  );
});
/**
 * 九个 volatile 全返空引用的配置。
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
    ["enabled", false],
    ["denyCommands", []],
    ["warnHint", true],
    ["rewriteHostEnv", ""],
    ["enabledFilters", ["cargo-test"]],
    ["minBytes", 256],
    ["minGainRatio", 0.95],
    ["stdoutCapBytes", 64_000],
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
  it.skipIf(!POSIX_ONLY)(
    "九个 volatile 全空时装配照常完成：形态退到默认 ['prefix'] 只装 C 形态，总开关不在装配期判",
    () => {
      // 同上两条：C 形态的门禁第三条是 PATH 上有 rtk（不造出来这条判据就跟着跑测机器走），
      // 而平台那一条（win32 整层不装）不在本用例的判据里，见 `POSIX_ONLY`。
      withRtkOnPath();
      const { host: base } = makeHost();
      const { host, events } = recording(base);
      applyTo(host, emptyVolatileConfig());
      assert.deepEqual(
        events,
        [AGENT_CREATED],
        "空引用等于「没配」：形态退默认、总开关留待执行期现读",
      );
    },
  );

  it("status() 把空引用读成默认值：enabled=false、forms=['prefix']", () => {
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
    const readers = prefixReadersOf(config);
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.denyCommands()], []);
    assert.equal(readers.warnHint(), true);
    assert.equal(readers.rewriteHostEnv(), "");
    set("enabled", true);
    set("denyCommands", ["gh"]);
    set("warnHint", false);
    set("rewriteHostEnv", "openclaw");
    assert.equal(readers.enabled(), true);
    assert.deepEqual([...readers.denyCommands()], ["gh"]);
    assert.equal(readers.warnHint(), false);
    assert.equal(readers.rewriteHostEnv(), "openclaw");
  });

  it("b 形态的五位：改配置之后取值函数读到的是新值", () => {
    const { config, set } = liveConfig();
    const readers = pipeReadersOf(config);
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.enabledFilters()], ["cargo-test"]);
    assert.equal(readers.minBytes(), 256);
    assert.equal(readers.minGainRatio(), 0.95);
    assert.equal(readers.stdoutCapBytes(), 64_000);
    set("enabled", true);
    set("enabledFilters", ["pytest"]);
    set("minBytes", 1);
    set("minGainRatio", 0.5);
    set("stdoutCapBytes", 100);
    assert.equal(readers.enabled(), true);
    assert.deepEqual([...readers.enabledFilters()], ["pytest"]);
    assert.equal(readers.minBytes(), 1);
    assert.equal(readers.minGainRatio(), 0.5);
    assert.equal(readers.stdoutCapBytes(), 100);
  });

  it("退化态（volatile 交回空引用）下两层各自的兜底与 schema 的默认值同值", () => {
    // 这两份兜底散在 `apply` 里时没有任何判据：只有「volatile 读到空引用」那种退化态
    // 才会走它们，而正常装出来的行为一模一样。
    const readers = prefixReadersOf(emptyVolatileConfig());
    assert.equal(readers.enabled(), false);
    assert.deepEqual([...readers.denyCommands()], []);
    assert.equal(readers.warnHint(), true);
    assert.equal(readers.rewriteHostEnv(), "");
    const pipes = pipeReadersOf(emptyVolatileConfig());
    assert.equal(pipes.enabled(), false);
    assert.deepEqual([...pipes.enabledFilters()], [...DEFAULT_ENABLED_FILTERS]);
    assert.equal(pipes.minBytes(), 256);
    assert.equal(pipes.minGainRatio(), 0.95);
    assert.equal(pipes.stdoutCapBytes(), 64_000);
  });

  it("c/b 两层读同一个 enabled：一处开关不能只作用于其中一层", () => {
    const { config, set } = liveConfig();
    const prefix = prefixReadersOf(config);
    const pipe = pipeReadersOf(config);
    set("enabled", true);
    assert.equal(prefix.enabled(), pipe.enabled(), "两层的总开关必须是同一个判据");
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
            stdout: { readFrom: () => ({ text: "rtk 1.2.0", nextOffset: 9, lossy: false }) },
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
      configSchema({ enabled: true, enabledForms: ["prefix", "pipe"] }),
    );
    assert.ok(listener !== undefined, "开了 pipe 形态却没挂监听器");
    const exec = { callId: "call-1", name: "bash", arguments: { command: "cargo test" } };
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
