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
import { structuralReject, findOnPath, pipeStructuralReject } from "../lib/prefix-safety.ts";

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
  it("&& / ; / | / 换行 全拒", () => {
    assert.equal(structuralReject("cd /tmp && cargo test"), "compound");
    assert.equal(structuralReject("cargo test; echo done"), "compound");
    assert.equal(structuralReject("cargo test | tee log"), "compound");
    assert.equal(structuralReject("cargo test\ncargo build"), "compound");
  });

  it("命令替换与反引号拒", () => {
    assert.equal(structuralReject("echo $(cargo test)"), "compound");
    assert.equal(structuralReject("echo `cargo test`"), "compound");
  });

  it("重定向拒", () => {
    assert.equal(structuralReject("cargo test > out.txt"), "compound");
    assert.equal(structuralReject("cargo test < in.txt"), "compound");
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

  // Windows 上这条判据造不出来：NTFS 没有 POSIX 执行位，`chmodSync(file, 0o644)` 之后
  // `accessSync(file, X_OK)` 仍然通过（Node 在 win32 上只判「文件存在且可读」）。所以
  // 「不可执行就跳过」这一档在 win32 上恒假——不是实现坏了，是平台没有这个概念。
  // 这与 `host.ts` 的 `prefixSupportedOn` 拒 win32 是同一个理由的另一面：那条平台上
  // 执行位语义本身未被验，与其猜一个，不如把判据标成「只在 POSIX 成立」。
  it.skipIf(process.platform === "win32")("同名文件没有可执行位时跳过、最终 undefined", () => {
    const dir = makeBinDir([{ name: "fakebin", mode: 0o644 }]);
    try {
      withPath(dir, () => {
        assert.equal(findOnPath("fakebin"), undefined);
      });
    } finally {
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
