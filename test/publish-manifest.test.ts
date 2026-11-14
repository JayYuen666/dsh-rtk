// test/publish-manifest.test.ts —— 发布形态门禁：入口必须「与发布器无关」地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。装出去之后有两类坑：
// 其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——pnpm 发布时把它合并到
// 顶层，npm 不合并（npm 打印 "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个
// 发布器就发出一个 import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：
// **顶层入口自己就完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组是宿主依赖的版本形状：它是「装得上但永远不生效」那一类失败的防线（宿主对字面版本的
// dsh 家族 peer 做确切版本强校验，不匹配就跳过整条 bundle，而 --dump-config 仍 exit 0）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const pkgDir = path.join(import.meta.dirname, "..");

/** manifest 里本门禁读到的那几位。其余字段不声明：门禁不替发布器做校验。 */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly main?: unknown;
  readonly exports?: Record<string, unknown>;
  readonly files?: unknown;
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly engines?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Manifest;

/** 入口面：宿主按 `main` 载入 host.js，客户端按 `exports["./client"]` 载入 client.js。 */
const ENTRY_TARGETS = [manifest.main, manifest.exports?.["./client"]].filter(
  (value): value is string => typeof value === "string",
);

/** 产物后缀。只认 .js 会漏掉 tsc 读的那批声明文件。 */
const ARTIFACT_EXTENSIONS = [".js", ".mjs", ".cjs", ".d.ts", ".mts", ".cts"];

/** 该文件是否属于「随包发布的产物」。 */
function isArtifact(file: string): boolean {
  return ARTIFACT_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/** 发布名单（`files` 的现量展开）。目录展开成「条目/相对路径」，与 npm 打包口径一致。 */
function shippedFiles(): Set<string> {
  const shipped = new Set<string>();
  const patterns: unknown = manifest.files;
  if (!Array.isArray(patterns)) {
    throw new TypeError("package.json 的 files 不是数组：发布面无从判定");
  }
  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      throw new TypeError("package.json 的 files 里有非字符串条目");
    }
    const full = path.join(pkgDir, pattern);
    if (!existsSync(full)) {
      // 只有产物缺失才是「先构建」；其余条目（目录、文档）不存在属发布配置写错。
      if (pattern.endsWith(".js")) {
        throw new Error(
          `files 的条目 ${pattern} 不在包根：先跑 node build-host.mjs / node build-client.mjs`,
        );
      }
    } else if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full, { recursive: true }) as string[]) {
        shipped.add(`${pattern}/${name.split(path.sep).join("/")}`);
      }
    } else {
      shipped.add(pattern);
    }
  }
  return shipped;
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换发布器也不会发出悬空入口）", () => {
    // 两个入口是这道门的前提：少一个就不存在「覆盖」这件事，而空数组断言恒成立。
    assert.ok(ENTRY_TARGETS.length >= 2, `入口面不该少于两个，实际 ${ENTRY_TARGETS.length}`);
    const shipped = shippedFiles();
    const missing = ENTRY_TARGETS.filter((target) => !shipped.has(target.replace(/^\.\//u, "")));
    assert.deepStrictEqual(missing, [], "这些入口文件没进发布面：写进 files，或改入口");
  });

  it("publishConfig 只留可见性与源", () => {
    const allowed = new Set(["access", "registry"]);
    const keys = Object.keys(manifest.publishConfig ?? {});
    // 防空转：一份没有 publishConfig 的 manifest 会让下面的循环什么都不看。
    assert.ok(keys.length > 0, "publishConfig 没了：发布可见性也就没有声明");
    for (const key of keys) {
      assert.ok(
        allowed.has(key),
        `publishConfig.${key} 会被 npm 忽略（npm 不合并 publishConfig，pnpm 合并）`,
      );
    }
  });

  it("包根的每一份 .md 都在发布名单里（npm 只自动带 README 与 LICENSE）", () => {
    const docs = readdirSync(pkgDir).filter((name) => name.endsWith(".md"));
    assert.ok(
      docs.length >= 3,
      `包根至少该有中英 README 与 CHANGELOG 三份 .md，实际 ${docs.length}`,
    );
    const shipped = shippedFiles();
    const missing = docs.filter((doc) => !shipped.has(doc));
    assert.deepStrictEqual(missing, [], "这些 .md 不随包发：写进 files，或确认它本就不该发");
  });

  it("产物没有本机指涉（绝对路径、pnpm store 布局）", () => {
    const artifacts = readdirSync(pkgDir).filter((file) => isArtifact(file));
    assert.ok(artifacts.length > 0, "至少要扫到一枚产物，否则这条是空转的");
    for (const file of artifacts) {
      const text = readFileSync(path.join(pkgDir, file), "utf8");
      assert.doesNotMatch(text, /\/(?:Users|home)\/[\w.-]+/u, `${file} 里有本机绝对路径`);
      assert.doesNotMatch(text, /\.pnpm[\\/]/u, `${file} 里有 pnpm store 布局`);
    }
  });
});

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies", () => {
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    assert.deepStrictEqual(leaked, [], "这些宿主包会随本包装进 profile，物化出第二份实例");
  });

  it("dependencies 只有 shared 与 zod 两枚（都写 catalog:）", () => {
    const deps = manifest.dependencies ?? {};
    assert.deepStrictEqual(Object.keys(deps).toSorted(), ["@jayyuen66/dsh-plugin-shared", "zod"]);
    for (const [name, range] of Object.entries(deps)) {
      assert.equal(range, "catalog:", name);
    }
  });

  it("devDependencies 里的 dsh-* 全部精确钉且同版本", () => {
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith("@deepseek-ai/dsh"),
    );
    // 九枚 `@deepseek-ai/dsh*`（cordis 与 schemastery 不以 dsh 开头，落不进这个过滤）。
    // 写成「至少九枚」而不是「等于九枚」：新增一枚宿主 devDependency 是正常演进，
    // 而少一枚意味着某个 `import type` 失去了版本约束。
    assert.ok(dshDev.length >= 9, `至少要钉住九枚 dsh-* 开发依赖，实际 ${dshDev.length}`);
    for (const [name, range] of dshDev) {
      assert.match(
        range,
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u,
        `${name} 不是精确钉：${range}（caret 会让单仓 CI 装到与本轮不同的宿主）`,
      );
    }
    const baseline = new Set(dshDev.map(([, range]) => range));
    assert.equal(baseline.size, 1, `dsh-* 开发依赖版本不一致：${[...baseline].join(", ")}`);
  });

  it("peerDependencies 里的 dsh 家族与 engines.dsh 写同一条范围", () => {
    const window = manifest.engines?.["dsh"];
    assert.ok(window !== undefined, "engines.dsh 缺失：支持窗口没有基准");
    assert.match(window, /^\^/u, "engines.dsh 必须是 caret 范围");
    const peers = manifest.peerDependencies ?? {};
    const bare = peers["@deepseek-ai/dsh"];
    assert.ok(bare !== undefined, "裸 dsh 的 peer 缺失：支持窗口就失去基准了");
    assert.equal(bare, window);
    // 只比 dsh 家族：@deepseek-ai/schemastery 也有 peer，但它是 ^3.19.0，按自己那条线走。
    // 按 `@deepseek-ai/` 前缀筛会把它误判成离群。
    const offPolicy = Object.entries(peers)
      .filter(([name, range]) => name.startsWith("@deepseek-ai/dsh") && range !== window)
      .map(([name]) => name);
    assert.deepStrictEqual(offPolicy, [], "这些 peer 与 engines.dsh 不是同一条范围");
  });

  it("engines.node 取宿主自己的地板", () => {
    assert.equal(manifest.engines?.["node"], ">=24.9.0");
  });

  it("exports 声明宿主与客户端真正会解析的那三个子路径", () => {
    const exportsMap = manifest.exports ?? {};
    for (const subpath of [".", "./client", "./package.json"]) {
      assert.ok(Object.hasOwn(exportsMap, subpath), `exports 缺 ${subpath}`);
    }
  });
});
