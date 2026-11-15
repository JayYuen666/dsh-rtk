// test/readme-parity.test.ts —— 中英双份 README 的结构对等 + 数字对等门。
//
// 为什么要有：README 拆成 README.md（英文）与 README.zh-CN.md（中文）两份之后，任何一侧
// 新增一节而另一侧漏了，都**不会**让现有用例变红——文档漂移不是行为差异。而这两份是同一个
// 插件对两类读者的同一份说明，骨架应当一一对应。
//
// 比对取结构而不是逐句对译：两份文档的句子本来就不是字面互译（中英术语与详略不同），按文本
// 比会天天误报；标题层级序列与头部骨架（logo 打头 + HTML h1 + 语言徽章互链）才是可机判的最小信号。
//
// 第二组是数字对等：结构对等两处一起写错时它照绿。dsh-rtk 的配置面是十四字段、九个 volatile、
// 五个部署级——这三个数在文档里各写一份，任何一处跟不上 schema 都不会让别的用例变红，
// 所以这里把「文档那句数字 = 导出的 Config 实际形状」钉成断言。
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { Config as configSchema } from "../host.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 英文主份与中文份。 */
const DOC_EN = "README.md";
const DOC_ZH = "README.zh-CN.md";

/** 视觉头的固定骨架：居中 logo 块打头；包名落在 HTML h1 上——头部没有 ATX 标题可判。
 *  包名从 package.json 当场实测（去掉 `@scope/`）：写死一份就等于「重命名包时这一处不会红」。 */
const HEAD_FIRST_LINE = '<p align="center">';

const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly engines?: Record<string, unknown>;
};

const { name: pkgName } = manifest;

/** 宿主支持窗口的单一来源；README 的 badge 与两条策略句都必须从它派生。 */
const ENGINES_DSH = typeof manifest.engines?.["dsh"] === "string" ? manifest.engines["dsh"] : "";
const PKG_SHORT_NAME =
  typeof pkgName === "string" ? pkgName.replace(/^@(?<scope>[^/]+)\//u, "") : "";
const HEAD_H1 = `<h1 align="center">${PKG_SHORT_NAME}</h1>`;

/** 顶部互链：语言徽章各指向另一语言，读者在任何一侧都能跳过去。 */
const CROSS_LINKS: readonly (readonly [string, string])[] = [
  [DOC_EN, "./README.zh-CN.md"],
  [DOC_ZH, "./README.md"],
];

/**
 * 取一份 Markdown 的标题层级序列（只取 `#` 的个数，不取标题文本）。
 * @param text - 文档全文
 * @returns 层级序列，如 `["#", "###", "###"]`
 */
function headingLevels(text: string): string[] {
  const levels: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(?<fence>`{3,}|~{3,})/u.exec(line)?.groups?.["fence"] ?? "";
    if (fence === null) {
      if (marker === "") {
        const hash = /^(?<hash>#{1,6}) /u.exec(line)?.groups?.["hash"];
        if (hash !== undefined) {
          levels.push(hash);
        }
      } else {
        fence = marker;
      }
    } else if (marker === fence) {
      // 围栏内的行一律不算标题：译文里的 bash 注释 `# 安装` 与代码块里的 `## 步骤`
      // 都会被旧写法当成标题计入层级序列，而两份文档本就允许代码块不同。
      fence = null;
    }
  }
  return levels;
}

/**
 * 读一份发布文档：读不到时报的是文档检查那句话，而不是一句没有路径信息的 ENOENT。
 * @param file - 包根下的文件名
 * @returns 文档全文
 */
async function readDoc(file: string): Promise<string> {
  try {
    return await readFile(path.join(pkgDir, file), "utf8");
  } catch (error: unknown) {
    throw new Error(`发布文档检查读不到 ${file}（包根 ${pkgDir}）`, { cause: error });
  }
}

/**
 * 头部界限按文档自身结构取：首个二级标题之前的那一段。
 * @param text - 文档全文
 * @returns 头部文本
 */
function headOf(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.startsWith("## "));
  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
}

/**
 * 导出 Config 的字段总数与 volatile 数（宿主 settings.describe() 投影的就是后者）。
 *
 * 内省 API 改名/缺席时不能退化成「读不到字段」：那会把报错变成「声明 14，实际 0」，
 * 指向完全错误的方向。这里当场说清是哪一位没了。
 * @returns 三个计数
 */
function schemaShape(): { total: number; defaulted: number; volatile: number } {
  const { dict }: { dict?: unknown } = configSchema as unknown as { dict?: unknown };
  if (typeof dict !== "object" || dict === null) {
    throw new TypeError(
      "Config 上没有可读的 dict 内省面（宿主换了 API？）：README 的数字对等门读不到字段。",
    );
  }
  const fields = Object.values(dict as Record<string, { meta?: Record<string, unknown> }>);
  return {
    total: fields.length,
    // 文档那句说的是「带内置默认值的字段数」，就按 `meta.default` 在不在位来数，
    // 而不是拿字段总数顶替：将来加一枚没有 .default() 的字段时，两者一分叉这条门就得跟上。
    defaulted: fields.filter((field) => field.meta?.["default"] !== undefined).length,
    volatile: fields.filter((field) => field.meta?.["volatile"] === true).length,
  };
}

/**
 * README 的宿主支持窗口与 package.json 的 engines.dsh 同源。
 *
 * 为什么单列：伞根的 bump-manifests 只改 package.json，两份 README 的 badge 与窗口声明
 * 不在它的改写入内——只改一半时宿主装载门会在用户机器上拒装，而本地没有任何门会红。
 */
describe("两份 README 的宿主支持窗口与 manifest 同源", () => {
  it("badge 与两份文档的窗口声明都取自 engines.dsh", async () => {
    assert.match(ENGINES_DSH, /^\^/u, "package.json 缺 engines.dsh：README 窗口门失去基准");
    const arms = ENGINES_DSH.split("||").map((arm) => arm.trim());
    // 本包的支持窗口是**单条线**（spec v3.6 把并集收成了一条 caret）。写成断言而不是注释：
    // 哪天有人把并集加回来，badge 只放第一条线这件事就立刻需要一个新决定。
    assert.equal(arms.length, 1, `engines.dsh 现在是单条线，实际 ${arms.join(" || ")}`);
    // shields.io 静态 badge 的编码：`^` 是 %5E，字面连字符写成 `--`。
    const badgeRange = encodeURIComponent(arms[0] ?? "").replaceAll("-", "--");
    const [english, chinese] = await Promise.all([readDoc(DOC_EN), readDoc(DOC_ZH)]);
    const docs: readonly (readonly [string, string])[] = [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ];
    for (const [name, text] of docs) {
      assert.ok(
        text.includes(`badge/dsh-${badgeRange}-658EFF`),
        `${name} 的 dsh badge 没跟上 engines.dsh`,
      );
      // 两条策略句（宿主窗口与 peer 同一条范围）各出现一次；少一条就说明有一处停在旧值。
      assert.ok(
        text.split(ENGINES_DSH).length - 1 >= 2,
        `${name} 里 ${ENGINES_DSH} 应出现至少两次（宿主窗口与 peer 各一次）`,
      );
      // 全文的 caret 范围必须恰好是这一条：旧值即使与新值并存也会被这一条点出来。
      const ranges = Array.from(text.matchAll(/\^0\.2\.[\dA-Za-z.-]+/gu), (hit) => hit[0]);
      assert.deepStrictEqual(
        new Set(ranges),
        new Set(arms),
        `${name} 里还留着 engines.dsh 之外的支持窗口`,
      );
    }
  });
});

/** 当前发布版本必须在 CHANGELOG 里有对应标题。 */
describe("发布说明覆盖当前发布版本", () => {
  it("顶部有与 package.json version 对应的二级标题", async () => {
    const version = typeof manifest.version === "string" ? manifest.version : "";
    assert.match(version, /^\d+\.\d+\.\d+/u, "package.json 缺 version");
    const changelog = await readDoc("CHANGELOG.md");
    assert.ok(
      changelog.split(/\r?\n/u).includes(`## ${version}`),
      `CHANGELOG.md 缺 ## ${version} 段落：发布物会带着上一版的说明出去`,
    );
  });
});

describe("中英 README 结构对等", () => {
  it("骨架、头部与互链三处都对得上", async () => {
    const [english, chinese] = await Promise.all([readDoc(DOC_EN), readDoc(DOC_ZH)]);
    const docs: readonly (readonly [string, string])[] = [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ];
    for (const [name, text] of docs) {
      const lines = text.split("\n");
      assert.equal(
        lines[0],
        HEAD_FIRST_LINE,
        `${name} 的首行该是居中 logo 块，与兄弟仓的视觉头一致`,
      );
      const head = headOf(text);
      assert.ok(head.includes(HEAD_H1), `${name} 头部缺包名 h1`);
      const cross = CROSS_LINKS.find(([doc]) => doc === name)?.[1];
      assert.ok(cross !== undefined, `${name} 该有一条互链判据`);
      assert.ok(head.includes(`href="${cross}"`), `${name} 顶部缺指向 ${cross} 的语言徽章`);
    }
    assert.deepStrictEqual(
      headingLevels(chinese),
      headingLevels(english),
      "中文份的标题骨架与英文份不一致：一侧加了节而另一侧没跟上",
    );
    assert.ok(headingLevels(english).length > 1, "两份文档至少各该有一节");
  });
});

/**
 * README 里那句配置表数字 = 导出 Config 的实际形状。
 *
 * 为什么单开一条：上面那门只比**结构**，两侧一起写错时它照绿。这一条把「文档那句数字仍可机判」
 * 这件事本身当判据：措辞被改掉时正则取不到数，本条即红。改文档请连正则一起改，别改一侧。
 */
describe("两份文档声明的配置表数字与实际 schema 对齐", () => {
  it("字段总数、卡上 volatile 数、非 volatile 部署值数三处都对得上", async () => {
    const [english, chinese] = await Promise.all([readDoc(DOC_EN), readDoc(DOC_ZH)]);
    const shape = schemaShape();
    // 这三条是 spec §2.8 终表的**独立**期望值，不从 schema 派生：
    // 从 schema 派生等于让被测对象自己给自己作证。
    assert.equal(shape.total, 14, `Config 字段数变了：spec §2.8 是 14 项，实际 ${shape.total}`);
    assert.equal(
      shape.volatile,
      9,
      `volatile 字段数变了：spec §2.8 的 ✓ 是 9 项，实际 ${shape.volatile}`,
    );
    assert.equal(
      shape.defaulted,
      shape.total - 1,
      "enabled 没有静态默认值（跟随 rtk 就绪状态）；其余 13 个字段都必须带内置默认值",
    );
    const claims: readonly {
      readonly label: string;
      readonly zh: RegExp;
      readonly en: RegExp;
      readonly actual: number;
    }[] = [
      {
        label: "字段总数",
        zh: /schema 共 (?<count>\d+) 个字段/u,
        en: /(?<count>\d+) fields/u,
        actual: shape.total,
      },
      {
        label: "带内置默认值的字段数",
        zh: /其中 (?<count>\d+) 个带内置默认值/u,
        en: /(?<count>\d+) of them carry built-in defaults/u,
        actual: shape.defaulted,
      },
      {
        label: "卡上 volatile 数",
        zh: /卡上那 (?<count>\d+) 枚/u,
        en: /(?<count>\d+) of them volatile/u,
        actual: shape.volatile,
      },
      {
        // 这一位是**可推导的**：非 volatile = 总数 - volatile。文档若写成别的数，
        // 要么这句错、要么那句错，两条一起红的概率远大于静默漂移。
        label: "非 volatile 部署值数",
        zh: /非 volatile 部署值\*\*，共 (?<count>\d+) 枚/u,
        en: /\*\*non-volatile deployment values\*\*, (?<count>\d+) of them/u,
        actual: shape.total - shape.volatile,
      },
    ];
    for (const claim of claims) {
      for (const [name, text, pattern] of [
        [DOC_ZH, chinese, claim.zh],
        [DOC_EN, english, claim.en],
      ] as const) {
        const declared = pattern.exec(text)?.groups?.["count"];
        assert.ok(
          declared !== undefined,
          `${name} 里读不到「${claim.label}」那句（措辞改了就把正则一起改）`,
        );
        assert.equal(
          Number(declared),
          claim.actual,
          `${name} 声明的${claim.label}是 ${declared}，而 Config schema 实际是 ${claim.actual}`,
        );
      }
    }
  });

  it("配置表逐行覆盖 14 个字段名（漏一行就是用户面少一个旋钮）", async () => {
    const { dict } = configSchema as unknown as { dict: Record<string, unknown> };
    const [english, chinese] = await Promise.all([readDoc(DOC_EN), readDoc(DOC_ZH)]);
    for (const [name, text] of [
      [DOC_EN, english],
      [DOC_ZH, chinese],
    ] as const) {
      const missing = Object.keys(dict).filter((field) => !text.includes(`\`${field}\``));
      assert.deepStrictEqual(missing, [], `${name} 的配置表漏了这些字段`);
    }
  });
});
