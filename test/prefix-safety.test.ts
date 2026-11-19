// lib/prefix-safety.ts 单测：四道结构性不变式 + PATH 上的可执行位探测。
//
// 覆盖率的硬点在这两处：`findOnPath` 的 win32 后缀分支与「同名但不可执行」那一档。
// 前者在 POSIX 机器上永远走不到（所以 platform 以参数注入），后者真实 PATH 上造不出来
// （用临时目录 0o644 夹具）。两处都不放宽阈值、也不写 ignore 注释。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  structuralReject,
  findOnPath,
  executableOf,
  pipeStructuralReject,
  splitCommand,
} from "../lib/prefix-safety.ts";

/** 两个原因串提到模块级：同一字面量在断言里出现多次，`sonarjs(no-duplicate-string)` 会判红。 */
const DETAIL_REJECT = "detail-flag";
const ALREADY_RTK = "already-rtk";

/** 造一个只含给定文件（名字 + 权限位）的临时目录，返回它的绝对路径。 */
function makeBinDir(files: { name: string; mode: number }[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rtk-path-"));
  for (const file of files) {
    const full = path.join(dir, file.name);
    writeFileSync(full, "");
    chmodSync(full, file.mode);
  }
  return dir;
}

/**
 * 本文件加载时的宿主平台。
 *
 * 必须在任何运行期平台改动之前取：它记的是「真机是什么」，缺省可执行策略钉的正是前者。
 */
const LOAD_TIME_PLATFORM: NodeJS.Platform = process.platform;

/** 在临时 PATH 上跑一段断言，跑完（含抛错）把 PATH 还原。 */
function withPath<Result>(dir: string, run: () => Result): Result {
  const savedPath = process.env["PATH"];
  process.env["PATH"] = dir;
  try {
    return run();
  } finally {
    process.env["PATH"] = savedPath;
  }
}

describe("structuralReject 复合命令", () => {
  it("可逐段拆分的复合命令放行（交给 rtk 逐段改写，方向修正）", () => {
    // 这一组在早期版本里是「全拒」。改判的理由是实测：rtk 自己就逐段改写
    // （discover/registry.rs 的 rewrite_compound），`cd /tmp && cargo test` 的产物是
    // `cd /tmp && rtk cargo test`——只有承载输出的那一段被换掉。多仓开发时模型几乎每条命令
    // 都是这个形状，整条拒掉等于把最常见的一类命令排除在压缩面之外。
    // 安全性由下游两道判据接住：rewrite-gate 逐段判 deny-table / vitest 门，rewrite-verify 逐段核对。
    assert.equal(structuralReject("cd /tmp && cargo test"), undefined);
    assert.equal(structuralReject("cargo test; echo done"), undefined);
    assert.equal(structuralReject("cargo test | tee log"), undefined);
    assert.equal(structuralReject("cargo test\ncargo build"), undefined);
    assert.equal(structuralReject("cargo test 2>&1"), undefined);
  });

  it("拆不成独立段的构造仍拒（compound 的语义收窄到这一档）", () => {
    // 反引号 / 命令替换：改写其中一段等于改另一段的输入，边界不可证明。
    assert.equal(structuralReject("echo $(cargo test)"), "compound");
    assert.equal(structuralReject("echo `cargo test`"), "compound");
    // 重定向：写盘目标一变副作用就变了。
    assert.equal(structuralReject("cargo test > out.txt"), "compound");
    assert.equal(structuralReject("cargo test < in.txt"), "compound");
    assert.equal(structuralReject("cargo test &> out.txt"), "compound");
    // 后台执行与空段。
    assert.equal(structuralReject("cargo test &"), "compound");
    assert.equal(structuralReject("cd x &&"), "compound");
    assert.equal(structuralReject("&& cargo test"), "compound");
    // 引号不配对：连边界在哪都判不出来。
    assert.equal(structuralReject('cargo test "unterminated'), "compound");
  });

  it("双引号内的转义与命令替换", () => {
    // 双引号里 `\"` 是转义字符：`echo "a\"b && c"` 的 `&&` 仍在引号内。
    assert.equal(structuralReject(String.raw`echo "a\"b" && cargo test`), undefined);
    // 双引号里的 `$(...)` 与反引号仍然是命令替换：边界不可证明，整条拒。
    assert.equal(structuralReject('echo "start $(cargo test) end"'), "compound");
    assert.equal(structuralReject('echo "start `cargo test` end"'), "compound");
  });

  it("反斜杠转义的分隔符不是分隔符", () => {
    // `&&` 被转义之后是普通字符（`\&\&`），不该在这里切成两段。
    const ESCAPED = String.raw`echo a\&\&b && cargo test`;
    assert.equal(structuralReject(ESCAPED), undefined);
    assert.equal(splitCommand(ESCAPED)?.length, 2);
  });

  it("引号内的分隔符不算分隔符", () => {
    assert.equal(structuralReject('echo "a && b"'), undefined);
    assert.equal(structuralReject("echo 'a && b'"), undefined);
    assert.equal(structuralReject('cd "a b" && cargo test'), undefined);
  });

  it("普通命令放行", () => {
    assert.equal(structuralReject("cargo test"), undefined);
    assert.equal(structuralReject("python -m pytest -q"), undefined);
  });
});

describe("structuralReject 详情 flag", () => {
  // 每一格都是实测中真实出现过、且被 rtk rewrite 照改不误的形态：`--reporter=json` 与
  // `--tb=long` 的值直接跟在 `=` 后面（带空格的那种反而少见）。
  const DETAIL_COMMANDS = [
    "cargo test -v",
    "cargo test -vv",
    "pytest --verbose",
    "cargo test -- --nocapture",
    "pytest --collect-only",
    "pytest --reporter=json",
    "pytest --tb=long",
    "pytest --capture=no",
    "vitest -s",
    "pytest -rA",
  ];

  it("逐条拒", () => {
    for (const command of DETAIL_COMMANDS) {
      assert.equal(structuralReject(command), DETAIL_REJECT, command);
    }
  });

  it("不在词边界的 -v 不算", () => {
    assert.equal(structuralReject("eslint --version"), undefined);
    assert.equal(structuralReject("cargo test -vx"), undefined);
  });
});

describe("structuralReject 防递归与空命令", () => {
  it("已 rtk 开头拒", () => {
    assert.equal(structuralReject("rtk cargo test"), ALREADY_RTK);
    assert.equal(structuralReject("  rtk vitest"), ALREADY_RTK);
  });

  it("空/纯空白拒", () => {
    assert.equal(structuralReject(""), "empty-command");
    assert.equal(structuralReject("   "), "empty-command");
  });

  it("rtkx 不算已 rtk", () => {
    assert.equal(structuralReject("rtkx foo"), undefined);
  });
});

describe("pipeStructuralReject", () => {
  it("详情 flag 与已 rtk 两条都拒", () => {
    assert.equal(pipeStructuralReject("cargo test -- --nocapture"), DETAIL_REJECT);
    assert.equal(pipeStructuralReject("pytest -vv"), DETAIL_REJECT);
    assert.equal(pipeStructuralReject("rtk cargo test"), ALREADY_RTK);
    assert.equal(pipeStructuralReject("  rtk vitest run"), ALREADY_RTK);
  });

  it("复合命令不拒：pipe 不执行命令，只看输出", () => {
    // 这条是它与 `structuralReject` 的**唯一**差别，也是它存在的理由：把 `compound`
    // 一并搬过来会让 `cd sub && cargo test`、`cargo test | tee log` 这类结果无法压缩，
    // 而它们在结果侧完全安全。
    assert.equal(pipeStructuralReject("cd /tmp && cargo test"), undefined);
    assert.equal(pipeStructuralReject("cargo test | tee log"), undefined);
  });

  it("空命令不拒（交给 filter 查表判，这里不重复判）", () => {
    // 与 `structuralReject` 的第二处差别：`empty-command` 在 pipe 层没有意义——空命令
    // 命中不了任何 filter 行，天然不会压。少一条分支就少一次口径分叉。
    assert.equal(pipeStructuralReject(""), undefined);
    assert.equal(pipeStructuralReject("   "), undefined);
  });

  it("普通命令放行", () => {
    assert.equal(pipeStructuralReject("cargo test"), undefined);
    assert.equal(pipeStructuralReject("pytest -q"), undefined);
  });
});

describe("findOnPath", () => {
  it("找得到 node（本仓 CI 一定有）", () => {
    assert.ok(findOnPath("node") !== undefined);
  });

  it("不存在的 bin undefined", () => {
    assert.equal(findOnPath("definitely-not-a-rtk-binary-xyz"), undefined);
  });

  it("环境变量 PATH 为空 undefined", () => {
    withPath("", () => {
      assert.equal(findOnPath("node"), undefined);
    });
  });

  it("环境变量 PATH 整个缺席 undefined（不是空串那种）", () => {
    // 两级空值都要覆盖：`PATH` 未设置时读出来是 undefined，而 `?? ""` 那一格恰恰最容易写漏。
    const savedPath = process.env["PATH"];
    delete process.env["PATH"];
    try {
      assert.equal(findOnPath("node"), undefined);
    } finally {
      if (savedPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = savedPath;
      }
    }
  });

  it("返回绝对路径", () => {
    const found = findOnPath("node");
    assert.ok(found !== undefined);
    assert.ok(path.isAbsolute(found));
  });

  // 「可执行」的语义**按平台分叉**，所以这里把两条 policy 分别断言，而不是按宿主 OS 跳过：
  //   · POSIX 看 mode 的执行位（`0o111`）——0o644 的文件不算；
  //   · win32 的 NTFS 没有执行位这回事（`accessSync(X_OK)` 只判「存在且可读」），
  //     那条平台的约定是「文件存在 + 扩展名对」。
  // 早先这条是 `skipIf(process.platform === "win32")`：判据本身在两台机器上都成立，跳过只是
  // 因为老实现把 `X_OK` 焊死了。改成注入 policy 之后，同一台机器能同时验两条。
  it("同名文件没有可执行位时跳过（posix 档看 mode 位）", () => {
    // 第三个参数同样必须显式给：缺省的 `executable` 跟**宿主**走，在 windows runner 上它是
    // 「存在即算」——那条 policy 会让本用例断言的正相变成 0o644 也被接受，于是同一条判据在
    // 两台机器上给出相反答案。这里要验的是 POSIX 那条 policy，就把它交进去。
    const dir = makeBinDir([{ name: "fakebin", mode: 0o644 }]);
    try {
      withPath(dir, () => {
        assert.equal(findOnPath("fakebin", "linux", executableOf("linux")), undefined);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 档不看执行位：文件存在即可（NTFS 没有 POSIX 执行位）", () => {
    // 注意第三个参数必须显式给：`findOnPath` 的 `executable` 缺省跟**宿主**走（这里仍会按
    // POSIX 的 mode 位判），因为「目标平台怎么命名」与「我脚下这个文件系统怎么算可执行」
    // 是两个问题。要验 win32 那条 policy，就得把它显式交进去——这也正是它可注入的理由。
    const dir = makeBinDir([{ name: "fakebin", mode: 0o644 }]);
    try {
      withPath(dir, () => {
        assert.equal(
          findOnPath("fakebin", "win32", executableOf("win32")),
          path.join(dir, "fakebin"),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺省可执行策略钉在模块加载时的宿主上，不跟运行期改的平台值走", () => {
    // 这一条钉的是真实缺陷（本轮修掉）：缺省值原先是 `executableOf(process.platform)`，
    // 读的是**调用那一刻**的平台值。而 `process.platform` 是 configurable 的，测试里可能
    // 把它换成另一档；若缺省跟着运行期读，可执行判定就会落到另一个文件系统的语义上
    // （实测复现：伪造 win32 加载模块、再改成 linux，0644 文件返回 `undefined`）。
    //
    // 判据不能写成「必须等于 POSIX 那条」：在 win32 runner 上缺省策略本来就该是 win32 那条
    // （存在即可），写成固定答案会让这条用例在 Windows 上因为错的原因红。所以期望值由
    // **本文件加载时**的平台算出来——那一刻的值就是宿主真值。运行期再把平台值换掉，
    // 缺省策略必须还是加载时那一条。
    const dir = makeBinDir([{ name: "fakebin", mode: 0o644 }]);
    const saved = process.platform;
    // 换成**与加载时不同**的那一档：与加载时同值时，错实现和正实现会给出同一个答案，
    // 这条用例就变成了空转（win32 模拟下实测过：只改成 win32 时突变体照样绿）。
    const runtime: NodeJS.Platform = LOAD_TIME_PLATFORM === "win32" ? "linux" : "win32";
    try {
      Object.defineProperty(process, "platform", { value: runtime, configurable: true });
      const expected = executableOf(LOAD_TIME_PLATFORM)(path.join(dir, "fakebin"))
        ? path.join(dir, "fakebin")
        : undefined;
      withPath(dir, () => {
        assert.equal(
          findOnPath("fakebin"),
          expected,
          "缺省策略跟着运行期的 process.platform 走了：Windows runner 上 rtk 会被判成不可执行",
        );
      });
    } finally {
      Object.defineProperty(process, "platform", { value: saved, configurable: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 同名**目录**不算找到了二进制：`accessSync(X_OK)` 对目录也通过（目录的搜索位就是 X），
  // 少了 `statSync().isFile()` 这一判，装配期门禁会误判「rtk 装好了」。后果是静默的——
  // 遮蔽层照装，而每次改写 spawn 那个目录都拿 EACCES、fail-open 原样执行；`status().rtkPath`
  // 报出伪路径，版本探测又探不到（`supported === null`），于是卡片既不报「没装」也不报
  // 「版本过低」，看着一切正常而压缩从不生效。
  it("同名目录不算（目录也能过 X_OK，必须再判 isFile）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rtk-path-"));
    try {
      mkdirSync(path.join(dir, "fakebin"), { recursive: true });
      withPath(dir, () => {
        assert.equal(findOnPath("fakebin"), undefined);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一目录里既有同名目录又有可执行文件时，取文件那个", () => {
    // 「先命中目录就返回」与「跳过目录继续找」的区别：前者会让排在后面的真二进制永远找不到。
    const dir = makeBinDir([{ name: "fakebin", mode: 0o755 }]);
    try {
      // makeBinDir 写的 `fakebin` 是文件，占的正是同一个候选名；目录档另造一份在别的目录里，
      // 前一个目录里是目录、后一个目录里是文件。
      const shadowDir = mkdtempSync(path.join(tmpdir(), "rtk-path-dir-"));
      try {
        mkdirSync(path.join(shadowDir, "fakebin"), { recursive: true });
        withPath(`${shadowDir}${path.delimiter}${dir}`, () => {
          assert.equal(findOnPath("fakebin"), path.join(dir, "fakebin"));
        });
      } finally {
        rmSync(shadowDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 平台按 .exe 后缀探测", () => {
    const dir = makeBinDir([{ name: "fakebin.exe", mode: 0o755 }]);
    try {
      withPath(dir, () => {
        assert.equal(findOnPath("fakebin", "win32"), path.join(dir, "fakebin.exe"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 平台也接受裸名（PATHEXT 的最后一档）", () => {
    const dir = makeBinDir([{ name: "fakebin", mode: 0o755 }]);
    try {
      withPath(dir, () => {
        assert.equal(findOnPath("fakebin", "win32"), path.join(dir, "fakebin"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
