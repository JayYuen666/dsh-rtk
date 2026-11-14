// lib/vitest-major.ts 单测：命令识别 + 向上找 `node_modules/vitest/package.json` 读主版本。
//
// 用真实的临时目录夹具，不 mock fs —— 这条链的全部风险都在「向上找几层、读不懂怎么办」
// 这类 IO 行为上，mock 掉正好把要验的那部分替掉。
import { describe, it, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectVitestMajor, isVitestCommand, resetVitestMajorCache } from "../lib/vitest-major.ts";

/** 一条普通 vitest 命令串：多数用例只关心「探到的主版本是多少」，命令本身不参与断言。 */
const VITEST_RUN = "vitest run";

/** 临时根的名字前缀：一个模块级常量，用例里只引用它。 */
const TEMP_PREFIX = "rtk-vitest-";

/** 本轮建出来的临时根，`afterAll` 统一清掉。 */
const tempRoots: string[] = [];

/** 新建一个登记过清理的临时根。 */
function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), TEMP_PREFIX));
  tempRoots.push(root);
  return root;
}

/** 同 `makeProject`，但直接把 `package.json` 的正文写进去（造非对象 JSON 那类边缘夹具）。 */
function makeProjectRaw(root: string, relative: string, body: string): string {
  const dir = path.join(root, relative);
  const vitestPkg = path.join(dir, "node_modules", "vitest");
  mkdirSync(vitestPkg, { recursive: true });
  writeFileSync(path.join(vitestPkg, "package.json"), body);
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/**
 * 在临时根下造一个装了 vitest 的工程，返回它的 workspace 目录。
 * `root` 由调用方先建（`newRoot()`）；`version` 为 undefined 时写一份坏 JSON，
 * 模拟「文件在但读不懂」。
 */
function makeProject(root: string, relative: string, version: string | undefined): string {
  const body = version === undefined ? "{ not json" : JSON.stringify({ name: "vitest", version });
  return makeProjectRaw(root, relative, body);
}

describe("isVitestCommand", () => {
  it("直接调用", () => {
    assert.equal(isVitestCommand("vitest run"), true);
    assert.equal(isVitestCommand("npx vitest run"), true);
  });

  it("脚本别名（rtk 会把它塌缩成 rtk vitest）", () => {
    assert.equal(isVitestCommand("pnpm test"), true);
    assert.equal(isVitestCommand("npm run test"), true);
    assert.equal(isVitestCommand("yarn test"), true);
  });

  it("非 vitest", () => {
    assert.equal(isVitestCommand("cargo test"), false);
    assert.equal(isVitestCommand("vitestx run"), false);
  });
});

describe("detectVitestMajor", () => {
  // 缓存是进程级单例：每格开头清一次，否则上一格写下的结论会让这一格的「探不到」变成命中。
  beforeEach(() => {
    resetVitestMajorCache();
  });

  afterAll(() => {
    for (const dir of tempRoots) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("读主版本", () => {
    const root = newRoot();
    const atV5 = makeProject(root, "v5", "5.1.0");
    const atV4 = makeProject(root, "v4", "4.1.12");
    const atV2 = makeProject(root, "v2", "2.1.9");
    assert.equal(detectVitestMajor(atV5, "npx vitest run"), 5);
    assert.equal(detectVitestMajor(atV4, VITEST_RUN), 4);
    assert.equal(detectVitestMajor(atV2, "vitest"), 2);
  });

  it("从子目录向上找", () => {
    const root = newRoot();
    const workspace = makeProject(root, "deep", "3.2.7");
    const nested = path.join(workspace, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    assert.equal(detectVitestMajor(nested, VITEST_RUN), 3);
  });

  it("找不到 undefined", () => {
    const root = newRoot();
    const bare = path.join(root, "bare", "a", "b", "c");
    mkdirSync(bare, { recursive: true });
    assert.equal(detectVitestMajor(bare, VITEST_RUN), undefined);
  });

  it("package.json 读不懂 undefined", () => {
    const root = newRoot();
    const workspace = makeProject(root, "bad", undefined);
    assert.equal(detectVitestMajor(workspace, VITEST_RUN), undefined);
  });

  it("version 不是字符串时 undefined", () => {
    const root = newRoot();
    const workspace = makeProjectRaw(root, "vnum", JSON.stringify({ name: "vitest", version: 5 }));
    assert.equal(detectVitestMajor(workspace, VITEST_RUN), undefined);
  });

  it("package.json 是合法 JSON 但不是对象时 undefined", () => {
    const root = newRoot();
    const workspace = makeProjectRaw(root, "vnull", "null");
    assert.equal(detectVitestMajor(workspace, VITEST_RUN), undefined);
  });

  it("非 vitest 命令不探（即使装了）", () => {
    const root = newRoot();
    const workspace = makeProject(root, "v5b", "5.1.0");
    assert.equal(detectVitestMajor(workspace, "cargo test"), undefined);
  });

  it("同目录第二次走缓存给同一结果", () => {
    const root = newRoot();
    const workspace = makeProject(root, "cached", "5.1.0");
    const first = detectVitestMajor(workspace, VITEST_RUN);
    const second = detectVitestMajor(workspace, VITEST_RUN);
    assert.equal(first, 5);
    assert.equal(second, 5);
  });

  it("走到文件系统根就停（不绕圈）", () => {
    // `path.dirname('/')` 仍是 `/`：不判这一格会白转 MAX_DEPTH 次。
    // 用当前工作卷的根目录当起点，根上不可能装了 vitest。
    const filesystemRoot = path.parse(process.cwd()).root;
    assert.equal(detectVitestMajor(filesystemRoot, VITEST_RUN), undefined);
  });

  it("第二次调用不再读盘（缓存真的生效）", () => {
    // 行为判据而不是 spy：第一次调用之后把 `package.json` 删掉。
    // 若缓存生效，第二次仍报 5；若每次都读盘，第二次就只能报 undefined。
    const root = newRoot();
    const workspace = makeProject(root, "hitcache", "5.1.0");
    assert.equal(detectVitestMajor(workspace, VITEST_RUN), 5);
    // vitest 装在工程根（`<root>/hitcache`），workspace 是它下面的子目录。
    rmSync(path.join(root, "hitcache", "node_modules", "vitest", "package.json"));
    assert.equal(detectVitestMajor(workspace, VITEST_RUN), 5);
  });

  it("命中「整条路径都没有」的缓存也直接返回 undefined", () => {
    const root = newRoot();
    const bare = path.join(root, "nowhere", "deep");
    mkdirSync(bare, { recursive: true });
    assert.equal(detectVitestMajor(bare, VITEST_RUN), undefined);
    // 第二次走的是 `cached === null` 那条分支：再补一个装了 vitest 的祖先，
    // 结论仍是 undefined（缓存优先于重新探），这条断言把「null 也要命中」钉住。
    const again = detectVitestMajor(bare, VITEST_RUN);
    assert.equal(again, undefined);
  });

  it("中间层没有 vitest 时，缓存不改写上一次的结论", () => {
    // 这一格是缓存语义的守门人：monorepo 子包自己的 node_modules 里没有 vitest，
    // 但仓库根有。若把「这一层没有」记成 null，第二次从子目录调用就会直接拿到 undefined。
    const root = newRoot();
    const workspace = makeProject(root, "mono", "4.0.0");
    const subPackage = path.join(workspace, "packages", "app");
    mkdirSync(path.join(subPackage, "node_modules"), { recursive: true });
    const first = detectVitestMajor(subPackage, VITEST_RUN);
    const second = detectVitestMajor(subPackage, VITEST_RUN);
    assert.equal(first, 4);
    assert.equal(second, 4);
  });
});
