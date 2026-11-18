/**
 * `lib/sqlite-face.ts` 的边界行为。
 *
 * 这个模块存在的理由不是「包一层」，而是让两个 store 都不必写断言就能拿到行类型（见它的
 * 文件头）。所以这里的用例只钉三件事：真实 `node:sqlite` 能不能赋值给这一面、
 * `openSqlite` 有没有把 options 原样递下去、以及 `errorFieldOf` 在四种「不是想要的形状」的
 * 输入下都回空串而不是抛。
 *
 * `openSqlite` 的两个分支（用注入的加载器 / 用真 `node:sqlite`）各走一次：前者保证单测能
 * 塞桩，后者保证默认路径真的加载得出来——**「省略而不是显式 undefined」那条契约只能由后者
 * 证**，因为桩无论收到哪种都看到 `undefined`。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";

import { closeQuietly, errorFieldOf, openSqlite } from "../lib/sqlite-face.ts";
import type { DatabaseFace, SqliteModule, StatementFace } from "../lib/sqlite-face.ts";

/** 每次构造驱动时收到的参数，用例开始时清空。 */
const ctorArgs: (readonly unknown[])[] = [];

/** 记下构造参数再转调真驱动：外壳必须每个方法都真的用到 `this`，否则撞 `class-methods-use-this`。 */
class RecordingDatabase implements DatabaseFace {
  readonly #inner: DatabaseFace;
  public constructor(
    path: string,
    options?: { readonly readOnly?: boolean; readonly timeout?: number },
  ) {
    ctorArgs.push(options === undefined ? [path] : [path, options]);
    this.#inner = options === undefined ? new DatabaseSync(path) : new DatabaseSync(path, options);
  }
  public exec(sql: string): void {
    this.#inner.exec(sql);
  }
  public prepare(sql: string): StatementFace {
    return this.#inner.prepare(sql);
  }
  public close(): void {
    this.#inner.close();
  }
}

const RECORDING_MODULE: SqliteModule = { DatabaseSync: RecordingDatabase };

describe("openSqlite", () => {
  it("把调用方给的 options 原样递给驱动", async () => {
    ctorArgs.length = 0;
    const db = await openSqlite(":memory:", { timeout: 1000 }, () =>
      Promise.resolve(RECORDING_MODULE),
    );
    assert.deepEqual(ctorArgs, [[":memory:", { timeout: 1000 }]]);
    db.close();
  });

  it("省略 options 时省掉第二个实参（node:sqlite 对显式 undefined 会报错）", async () => {
    ctorArgs.length = 0;
    const db = await openSqlite(":memory:", undefined, () => Promise.resolve(RECORDING_MODULE));
    // 桩分不出「省略」与「传了 undefined」，所以这里只钉「没传对象」这一半…
    assert.deepEqual(ctorArgs, [[":memory:"]]);
    db.close();
  });

  it("不给加载器时真的 import node:sqlite，且不需要任何断言", async () => {
    // …而真正承重的是这一条：默认参数是真实的 `import("node:sqlite")`，
    // ① 赋值给 `ImportSqlite` 若类型不兼容，tsc 先红，用例根本跑不起来；
    // ② 若实现把 `undefined` 显式递下去，这里当场抛 `The "options" argument must be an object.`。
    const db = await openSqlite(":memory:");
    const row = db.prepare("SELECT 1 AS one").get<{ readonly one: number }>() ?? { one: -1 };
    assert.equal(row.one, 1);
    db.close();
  });
});

describe("closeQuietly", () => {
  it("undefined 与关库抛错都不外泄", () => {
    closeQuietly(undefined);
    const db: DatabaseFace = {
      exec: () => {
        throw new Error("这个用例不 exec");
      },
      prepare: () => {
        throw new Error("这个用例不 prepare");
      },
      close: () => {
        throw new Error("关第二次时真驱动抛的是 database is not open");
      },
    };
    // 关不掉只影响本进程的句柄，不该把上层刚读到的判读盖掉。
    assert.doesNotThrow(() => {
      closeQuietly(db);
    });
  });
});

describe("errorFieldOf", () => {
  it("取到字符串字段时原样给回", () => {
    const error = Object.assign(new Error("no such table: commands"), { code: "ERR_SQLITE_ERROR" });
    assert.equal(errorFieldOf(error, "code"), "ERR_SQLITE_ERROR");
    assert.equal(errorFieldOf(error, "message"), "no such table: commands");
  });

  it("非对象与 null 都回空串", () => {
    // catch 拿到什么都有可能：字符串、数字、undefined。三类都不该让判读路径抛。
    assert.equal(errorFieldOf("boom", "code"), "");
    assert.equal(errorFieldOf(7, "code"), "");
    assert.equal(errorFieldOf(null, "code"), "");
    assert.equal(errorFieldOf(undefined, "code"), "");
  });

  it("对象上没有该键、或该键不是字符串时回空串", () => {
    assert.equal(errorFieldOf({}, "code"), "");
    assert.equal(errorFieldOf({ code: 42 }, "code"), "");
    assert.equal(errorFieldOf({ code: null }, "code"), "");
  });
});
