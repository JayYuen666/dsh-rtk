// lib/command-segments.ts 单测：分段器承诺的是「只切 shell 的顶层分隔符」，
// 所以这里的用例分两类，**不能互相替代**：
//   · 边界正确 —— 注释、fd 目标词、续行这三处，「切错了」与「拼回来还一样」可以同时成立
//     （`echo ok # note; more` 被切成两段之后拼回去逐字相同，但 `; more` 在 shell 里是注释）；
//   · 文本保真 —— 成功时 `sep + text` 必须逐字拼回原串，否则下游（`withRtkLedgerEnv`
//     插环境变量、`restoreGatedSegments` 还原被拦下的段）会把命令改成另一个东西。
//
// 判据一律取自 bash 的实测：`echo hi >&2log` 写出了文件 `2log`、`echo hi 2>&1x` 报
// 「有歧义的重定向」、`echo hi 2>&1|head` 正常复制 fd、`echo ok # note; more` 只打印 `ok`。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { splitCommand } from "../lib/command-segments.ts";

/** 同一字面量在断言里出现三次以上会撞 `sonarjs(no-duplicate-string)`，提到模块级。 */
const CD_CARGO = "cd /tmp && cargo test";

/** 拼回：`sep` 与 `text` 逐字相接，等于原命令。这是所有用例共享的不变式。 */
function rejoin(command: string): string | undefined {
  const segments = splitCommand(command);
  return segments?.map((segment) => `${segment.sep}${segment.text}`).join("");
}

describe("文本保真与 sep 契约", () => {
  it("成功时 sep + text 逐字拼回原命令（含前后空白与换行）", () => {
    for (const command of [
      CD_CARGO,
      "cd /tmp; cargo test",
      "echo a |  tee f",
      "a && b || c",
      "x\ny",
    ]) {
      assert.equal(rejoin(command), command, command);
    }
  });

  it("sep 只含运算符本身，周围空白归 text", () => {
    assert.deepEqual(splitCommand(CD_CARGO), [
      { sep: "", text: "cd /tmp " },
      { sep: "&&", text: " cargo test" },
    ]);
  });

  it("`||` 优先于 `|`，裸 `&` 整条放弃", () => {
    assert.equal(splitCommand("a || b")?.[1]?.sep, "||");
    assert.equal(splitCommand("a | b")?.[1]?.sep, "|");
    assert.equal(splitCommand("a & b"), undefined);
  });
});

describe("边界正确：shell 注释", () => {
  it("词首的 `#` 之后整行都是注释，切出来的段不是命令", () => {
    // 实测 `bash -c 'echo ok # note; more'` 只打印 `ok`：`; more` 在注释里
    assert.equal(splitCommand("echo ok # note; more"), undefined);
    assert.equal(splitCommand("cd /repo && cargo test # 跑一遍"), undefined);
    assert.equal(splitCommand("# 整条都是注释"), undefined);
    // `#` 在新行开头（前面是换行）也算词首
    assert.equal(splitCommand("cargo test\n# 说明; cargo build"), undefined);
  });

  it("词中间的 `#` 不是注释，照常切段", () => {
    assert.deepEqual(splitCommand("echo a#b; more"), [
      { sep: "", text: "echo a#b" },
      { sep: ";", text: " more" },
    ]);
  });

  it("引号里的 `#` 不是注释", () => {
    assert.equal(splitCommand('grep -rn "#[0-9]+" .')?.length, 1);
    assert.equal(splitCommand("echo 'a # b' && cargo test")?.length, 2);
  });
});

describe("边界正确：fd 复制与真重定向", () => {
  it("纯数字目标才算 fd 复制，`>&2log` / `2>&1x` 是写盘的重定向", () => {
    // 实测 `echo hi >&2log` 写出了 3 字节的文件 `2log`——把它当 fd 复制放过去，
    // 等于让插件改写一条会写文件的命令，下一段读到的还是被压过的内容
    assert.equal(splitCommand("cat a >&2log"), undefined);
    assert.equal(splitCommand("cat a 2>&1x"), undefined);
    assert.equal(splitCommand("cat a 2>&1x2"), undefined);
  });

  it("`2>&1` / `>&2` 照常可拆，后面的分隔符不受影响", () => {
    assert.equal(splitCommand("cd /tmp && cargo test 2>&1")?.length, 2);
    assert.equal(splitCommand("cargo test >&2 && echo done")?.length, 2);
    // 实测 `echo hi 2>&1|head` 是「复制 fd 再管道」
    assert.deepEqual(splitCommand("echo hi 2>&1|head -1"), [
      { sep: "", text: "echo hi 2>&1" },
      { sep: "|", text: "head -1" },
    ]);
  });

  it("真重定向照旧整条放弃（含 `>&-` 关闭 fd）", () => {
    assert.equal(splitCommand("cargo test > out.log"), undefined);
    assert.equal(splitCommand("cargo test >> out.log"), undefined);
    assert.equal(splitCommand("cargo test < in.txt"), undefined);
    assert.equal(splitCommand("cargo test >&-"), undefined);
  });
});

describe("边界正确：续行与末尾孤立反斜杠", () => {
  it("末尾孤立的 `\\` 让命令不完整，放弃拆分", () => {
    // 上一版会推进到字符串之外还报成功——调用方拿到的段数与 shell 看到的不是一回事
    assert.equal(splitCommand("echo a \\"), undefined);
    assert.equal(splitCommand("cargo test \\"), undefined);
  });

  it("`\\` + 换行是续行：两行拼成同一段，与 bash 一致", () => {
    assert.equal(splitCommand("echo a \\\n b")?.length, 1);
  });

  it("引号不配对仍整条放弃", () => {
    assert.equal(splitCommand("echo 'a && b"), undefined);
  });
});

describe("与调用方共享的形状", () => {
  it("`cd X && cargo test` 拆成两段，末段可单独判 filter", () => {
    assert.deepEqual(splitCommand(CD_CARGO), [
      { sep: "", text: "cd /tmp " },
      { sep: "&&", text: " cargo test" },
    ]);
  });

  it("拆不开的构造返回 undefined，调用方一律按整条处理", () => {
    for (const command of ["cd $(pwd) && cargo test", "echo `date`; ls", "a & b"]) {
      assert.equal(splitCommand(command), undefined, command);
    }
  });
});
