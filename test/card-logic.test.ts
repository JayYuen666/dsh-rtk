// 卡片纯逻辑的单测：快照投影、草稿读数、九字段投影。
//
// 替身只实现本卡用到的那几位（`getSnapshot` / `subscribe`），**不抄官方的完整 ConfigForm**：
// 官方接口六个成员全必选，而卡片只用两个，抄全等于给自己加一处会漂的重复声明。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  FORM_MODES,
  cardStore,
  draftFields,
  draftOf,
  formModeOf,
  formsOf,
  hasDraft,
  hintOf,
  numberOf,
  stringListOf,
} from "../lib/card-logic.ts";
import type { CardSnapshot, SettingScope } from "../lib/card-logic.ts";

// 这两个字面量在断言里出现十几次：提成常量后，改动只需动一处（也让
// `sonarjs(no-duplicate-string)` 不再把它们当「散落的同一个魔法值」）。
// 空退订具名化：`() => () => {}` 会撞 `eslint(no-empty-function)`，
// 而 `() => () => undefined` 撞 `unicorn(no-useless-undefined)`——一条具名 noop 两边都过。
const noop = (): void => undefined;

const PREFIX = "prefix";
const PREFIX_PIPE = "prefix+pipe";
const PIPE = "pipe";

/**
 * 同形替身：官方 ConfigForm 的快照是 `{status, value, base, user, revision, writable}`，值在 value 里。
 *
 * **快照引用必须缓存**——这是官方契约里承重的一条，不是替身的实现细节：真实 `ConfigForm`
 * 只在状态真的变了之后才换快照对象，`useSyncExternalStore` 才靠引用相等判「没变」。
 * 每次 `getSnapshot()` 都新建对象的替身会让「不变则复用投影」这条永远命中不了，
 * 于是被测的缓存看起来像没生效（第一版替身就犯了这个错，红的是替身而不是 `cardStore`）。
 */
function scope(
  initial: Record<string, unknown>,
  writable = true,
): SettingScope & { readonly push: (value: Record<string, unknown>) => void } {
  let value = initial;
  let revision = 1;
  const status: CardSnapshot["status"] = "ready";
  const listeners = new Set<() => void>();
  let snap = { status, writable, value, base: undefined, user: undefined, revision };
  const form = {
    getSnapshot: () => snap,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(next: Record<string, unknown>) {
      value = next;
      revision += 1;
      // 状态变了才换快照：换的是对象本身，这正是 `cardStore` 的缓存键。
      snap = { status, writable, value, base: undefined, user: undefined, revision };
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return form as unknown as SettingScope & {
    readonly push: (value: Record<string, unknown>) => void;
  };
}

describe("cardStore", () => {
  it("值取自 snap.value，不是快照顶层", () => {
    const store = cardStore(scope({ minBytes: 256 }));
    assert.equal(store.getSnapshot().value["minBytes"], 256);
  });

  it("首个快照之前是 loading + 空值（不是崩）", () => {
    const pending = {
      getSnapshot: () => ({
        status: "loading",
        writable: false,
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
      }),
      // 空退订：替身没有订阅者，返回一个什么都不做的 disposer 就是全部义务。
      subscribe: () => noop,
    };
    const snap = cardStore(pending as unknown as SettingScope).getSnapshot();
    assert.equal(snap.status, "loading");
    assert.deepEqual(snap.value, {});
  });

  it("同一份快照复用投影（引用相等），新快照换引用", () => {
    const source = scope({ minBytes: 1 });
    const store = cardStore(source);
    const first = store.getSnapshot();
    assert.equal(store.getSnapshot(), first);
    source.push({ minBytes: 2 });
    const second = store.getSnapshot();
    assert.notEqual(second, first);
    assert.equal(second.value["minBytes"], 2);
  });

  it("订阅原样透传给 scope", () => {
    const source = scope({});
    let hits = 0;
    const off = cardStore(source).subscribe(() => {
      hits += 1;
    });
    source.push({});
    assert.equal(hits, 1);
    off();
    source.push({});
    assert.equal(hits, 1);
  });
});

describe("草稿读数", () => {
  it("草稿优先于已提交值", () => {
    assert.equal(draftOf({ minBytes: 99 }, { minBytes: 256 }, "minBytes"), 99);
    assert.equal(draftOf({}, { minBytes: 256 }, "minBytes"), 256);
  });

  it("只判自有属性（原型链上的同名成员不算）", () => {
    assert.equal(hasDraft({}, "toString"), false);
    assert.equal(draftOf({}, {}, "constructor"), undefined);
  });

  it("stringListOf 去空白、丢空项、保持顺序", () => {
    assert.deepEqual(stringListOf(" gh , npm ,  ,cargo"), ["gh", "npm", "cargo"]);
    assert.deepEqual(stringListOf([]), []);
    assert.deepEqual(stringListOf(""), []);
    assert.deepEqual(stringListOf(42), []);
  });

  it("stringListOf 把换行也当分隔符，并丢掉非字符串元素", () => {
    assert.deepEqual(stringListOf("a\nb\n c "), ["a", "b", "c"]);
    assert.deepEqual(stringListOf(["a", 1, null, "b"]), ["a", "b"]);
  });

  it("numberOf 只收有限数字（空串 / NaN / 字符串都给 undefined）", () => {
    assert.equal(numberOf(256), 256);
    assert.equal(numberOf(0), 0);
    assert.equal(numberOf(""), undefined);
    assert.equal(numberOf(Number.NaN), undefined);
    assert.equal(numberOf("256"), undefined);
  });

  it("forms 的显示值 ↔ 存储值双向一致（三档互不折叠）", () => {
    assert.deepEqual(FORM_MODES, [PREFIX, PREFIX_PIPE, PIPE]);
    // 每一档都要能原样来回：这是「卡片不能静默改配置」的最小判据。
    for (const mode of FORM_MODES) {
      assert.equal(formModeOf(formsOf(mode)), mode, `${mode} 往返丢档`);
    }
    assert.deepEqual(formsOf(PREFIX), [PREFIX]);
    assert.deepEqual(formsOf(PREFIX_PIPE), [PREFIX, PIPE]);
    assert.deepEqual(formsOf(PIPE), [PIPE]);
    // `['pipe']` 曾被 formModeOf 折成「C + B」：用户只想关前缀层，点一下保存却把改写层打开了。
    assert.notEqual(formModeOf([PIPE]), PREFIX_PIPE);
  });

  it("forms 认不出来时落回 host schema 默认的 prefix", () => {
    assert.equal(formModeOf(undefined), PREFIX);
    // 档位字符串是卡片下拉交回来的草稿单位：认它，否则「点得动、选不中」。
    assert.equal(formModeOf("pipe"), PIPE);
    assert.equal(formModeOf("prefix+pipe"), PREFIX_PIPE);
    assert.equal(formModeOf("nonsense"), PREFIX);
    assert.deepEqual(formModeOf([]), PREFIX);
    assert.deepEqual(formModeOf(["nonsense"]), PREFIX);
  });

  it("draftFields 九个字段逐个投影（含三个数组与一个字符串）", () => {
    const fields = draftFields(
      { minBytes: 512 },
      {
        enabled: true,
        enabledForms: [PREFIX, "pipe"],
        denyCommands: ["gh"],
        enabledFilters: ["pytest"],
        minGainRatio: 0.9,
        stdoutCapBytes: 64_000,
        warnHint: false,
        rewriteHostEnv: "openclaw",
      },
    );
    assert.equal(fields.enabled, true);
    assert.equal(fields.forms, PREFIX_PIPE);
    assert.deepEqual(fields.denyCommands, ["gh"]);
    assert.deepEqual(fields.enabledFilters, ["pytest"]);
    assert.equal(fields.minBytes, 512);
    assert.equal(fields.minGainRatio, 0.9);
    assert.equal(fields.stdoutCapBytes, 64_000);
    assert.equal(fields.warnHint, false);
    assert.equal(fields.rewriteHostEnv, "openclaw");
  });

  it("draftFields 缺值走安全默认（enabled 关 / forms=prefix / warnHint 开 / hostEnv 空）", () => {
    const fields = draftFields({}, {});
    assert.equal(fields.enabled, false);
    assert.equal(fields.forms, PREFIX);
    assert.deepEqual(fields.denyCommands, []);
    assert.deepEqual(fields.enabledFilters, []);
    assert.equal(fields.minBytes, undefined);
    assert.equal(fields.minGainRatio, undefined);
    assert.equal(fields.stdoutCapBytes, undefined);
    assert.equal(fields.warnHint, true);
    assert.equal(fields.rewriteHostEnv, "");
  });
});

describe("hintOf（卡片顶部引导行）", () => {
  /** 正常状态：装好了、版本够新。三个用例都从它出发改一位。 */
  const healthy = {
    rtkPath: "/opt/homebrew/bin/rtk",
    rtkVersion: "rtk 1.2.0",
    supported: true,
    enabled: false,
    forms: ["prefix"],
  };

  it("没探到状态时不给引导行（此时既不知道装没装，也不知道版本）", () => {
    assert.equal(hintOf(undefined), undefined);
  });

  it("rtkPath 为 null ⇒ missing（给安装命令，而不是让用户升级）", () => {
    assert.deepEqual(hintOf({ ...healthy, rtkPath: null, rtkVersion: null, supported: null }), {
      kind: "missing",
    });
  });

  it("supported 为 false ⇒ too-old，并带上探到的版本原串", () => {
    assert.deepEqual(hintOf({ ...healthy, rtkVersion: "rtk 0.9.9", supported: false }), {
      kind: "too-old",
      version: "rtk 0.9.9",
    });
  });

  it("装好且版本够新 ⇒ 就绪行，写出二进制路径与版本（这是 README 承诺的那一句）", () => {
    // 早先这一支回 undefined（卡片在健康态什么都不显示），而 README.md:75 逐字承诺
    // 「卡片的就绪行会写出解析到的二进制与它的版本」——文档说了一句界面里没有的话。
    assert.deepEqual(hintOf(healthy), {
      kind: "ready",
      version: healthy.rtkVersion,
      path: healthy.rtkPath,
    });
  });

  it("supported 为 null 但 rtkPath 有值 ⇒ 不显示（探不到版本 ≠ 版本太低）", () => {
    assert.equal(hintOf({ ...healthy, rtkVersion: null, supported: null }), undefined);
  });

  it("too-old 但版本串丢了 ⇒ 版本位给 ?，不填空串", () => {
    assert.deepEqual(hintOf({ ...healthy, rtkVersion: null, supported: false }), {
      kind: "too-old",
      version: "?",
    });
  });

  it("就绪但版本串丢了 ⇒ 就绪行的版本位也给 ?（路径照旧显示）", () => {
    assert.deepEqual(hintOf({ ...healthy, rtkVersion: null, supported: true }), {
      kind: "ready",
      version: "?",
      path: healthy.rtkPath,
    });
  });
});
