// lib/rtk-hook.ts 单测：配置正文、载荷形状、环境隔离、回执解析。
//
// 四块各有一条「为什么必须是这个形状」的依据，全部来自 rtk 自己的源码或实测：
//   1. `pipelineToml` 的每一段位置都对应一个加载器约束（顶层 `extends` 会被判 E001、
//      只 extends 会继承一条带 `is_rtk_command = false` 的规则而不发任何东西）；
//   2. `buildHookPayload` 的 `tool_name` 必须是 `Bash`（小写落到 Subject::Any → 零输出）；
//   3. `hookEnvOf` 的八个键各挡一处副作用（配置读错、账本混行、全局状态被删）；
//   4. `parseHookOutput` 的「不发」与「发了但没那句」都必须是 undefined —— 空串不是压缩结果。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildHookPayload, hookEnvOf, parseHookOutput, pipelineToml } from "../lib/rtk-hook.ts";

const BASH = "Bash";
const CARGO_BUILD = "cargo build";
const TWO_LINES = "line one\nline two";

describe("pipelineToml", () => {
  it("schema_version 在顶层、extends 在 [pipeline] 段下", () => {
    // 写顶层会被判 `E001 unknown section`，而 rc 仍是 0——诊断只落在 pipeline-status.json，
    // 会话里什么都看不到。所以这两行的位置是被测约定，不是风格。
    const toml = pipelineToml();
    const schemaAt = toml.indexOf("schema_version = 1");

    assert.notEqual(schemaAt, -1, "必须有 schema_version = 1");
    assert.ok(schemaAt < toml.indexOf("[pipeline]"), "schema_version 必须在任何段之前");
    assert.ok(
      toml.includes('[pipeline]\nextends = "rtk:posthook"'),
      "extends 必须在 [pipeline] 段下",
    );
  });

  it("自带一条 shell 规则，且 when 里排除 rtk 自己的命令", () => {
    // 只 extends 时继承来的 term-default 带 `is_rtk_command = false`，实测三种载荷全不发；
    // 而 `is_rtk_command` 是真值时整条规则不命中（rtk 用它避免对已处理的输出再压一遍）。
    const toml = pipelineToml();

    assert.ok(toml.includes("[[hook.after_tool.shell]]"), "必须自带 shell 规则");
    assert.ok(toml.includes('name = "dsh-clean"'), "规则名要具名：诊断与 gain 按它分账");
    assert.ok(toml.includes("is_rtk_command = false"), "必须排除 rtk 自己的命令");
  });

  it("链是 ansi + progress + dedup，且刻意不含 cap 与 base64-elide", () => {
    // cap：切段归本包的头尾窗口，两处都切会让省略量对不上、护栏还会看见两种省略标记。
    // base64-elide：`Recovery::None`，省下的空间换不可逆的损失；实测去掉它压缩结果逐字节相同。
    const toml = pipelineToml();
    const use = /use = \[(?<chain>.*)\]$/mu.exec(toml)?.groups?.["chain"] ?? "";

    assert.equal(use, '"ansi", "progress", "dedup"');
    assert.ok(!use.includes("cap"), "不该含 cap");
    assert.ok(!use.includes("base64-elide"), "不该含 base64-elide");
  });

  it("min_size 取 256 而不是出厂的 512", () => {
    // 本包只在这条输出已经过了 `minBytes` 之后才来问，再叠一道 512 会让「200 行重复告警」
    // 那种形状（6,200 B）永远拿不到压缩。
    assert.ok(pipelineToml().includes("min_size = 256"));
  });

  it("第一行写明是生成的：用户手改会在下一次调用被覆盖", () => {
    const first = pipelineToml().split("\n")[0] ?? "";

    assert.ok(first.includes("dsh-rtk"), "首行要标出来源");
    assert.ok(first.includes("覆盖"), "首行要写明改动会被覆盖");
  });
});

describe("buildHookPayload", () => {
  it("tool_name 是 Bash（小写会落到 Subject::Any，零输出）", () => {
    const payload = JSON.parse(buildHookPayload({ command: CARGO_BUILD, stdout: "x" })) as {
      readonly tool_name: string;
      readonly hook_event_name: string;
    };

    assert.equal(payload.tool_name, BASH);
    assert.equal(payload.hook_event_name, "PostToolUse");
  });

  it("命令与正文各就各位：tool_input.command / tool_response.stdout", () => {
    const payload = JSON.parse(buildHookPayload({ command: CARGO_BUILD, stdout: TWO_LINES })) as {
      readonly tool_input: { readonly command: string };
      readonly tool_response: { readonly stdout: string; readonly stderr: string };
    };

    assert.equal(payload.tool_input.command, CARGO_BUILD);
    assert.equal(payload.tool_response.stdout, TWO_LINES);
    // stderr 给空串而不是省略：`process_shell` 把两段的字节数相加比 `min_size`，
    // 缺字段时 `.unwrap_or("")` 也走同一支，但显式给空串能让「这条路径只处理 stdout」写在纸面上。
    assert.equal(payload.tool_response.stderr, "");
  });

  it("中文与 emoji 原样进 JSON（不转义成 unicode 转义串）", () => {
    // `JSON.stringify` 默认不转义非 ASCII，这里钉住它：转义会让字节数翻几倍，
    // 而 `min_size` 与 `never_worse` 都是按字节比的。
    const payload = buildHookPayload({ command: CARGO_BUILD, stdout: "构建失败 🚨" });

    assert.ok(payload.includes("构建失败 🚨"));
  });
});

describe("hookEnvOf", () => {
  const PATHS = {
    configDir: "/home/u/.dsh/rtk/config",
    home: "/home/u/.dsh/rtk/home",
    dbPath: "/home/u/.dsh/rtk/hook.db",
    recallDb: "/home/u/.dsh/rtk/recall.db",
  } as const;

  it("八个键各就各位", () => {
    assert.deepEqual(hookEnvOf(PATHS), {
      RTK_CONFIG_DIR: PATHS.configDir,
      RTK_DB_PATH: PATHS.dbPath,
      RTK_RECALL_DB: PATHS.recallDb,
      HOME: PATHS.home,
      USERPROFILE: PATHS.home,
      APPDATA: PATHS.home,
      LOCALAPPDATA: PATHS.home,
      RTK_TELEMETRY_DISABLED: "1",
    });
  });

  it("home / userprofile / appdata / localappdata 同值：POSIX 读 HOME，Windows 读另外三个", () => {
    const env = hookEnvOf(PATHS);

    assert.equal(env["HOME"], env["USERPROFILE"]);
    assert.equal(env["HOME"], env["APPDATA"]);
    assert.equal(env["HOME"], env["LOCALAPPDATA"]);
  });

  it("账本与取回库是两个不同的文件", () => {
    // 并进同一个会让 rtk 的 `commands` 表出现 `Bash cargo build` 这种不是用户命令的行，
    // Insights 的「按命令」表会把清洗流水算成命令。
    const env = hookEnvOf(PATHS);

    assert.notEqual(env["RTK_DB_PATH"], env["RTK_RECALL_DB"]);
  });

  it("不碰 PATH / 父进程变量：只交这八个键", () => {
    assert.equal(Object.keys(hookEnvOf(PATHS)).length, 8);
  });
});

/** 把一段清洗后的正文包成 `rtk hook claude` 的回执形状。 */
function wrapped(stdout: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout } },
  });
}

describe("parseHookOutput", () => {
  const CLEANED = TWO_LINES;

  it("取回 updatedToolOutput.stdout", () => {
    assert.equal(parseHookOutput(wrapped(CLEANED)), CLEANED);
  });

  it("空 stdout 给 undefined：那是「没东西可改」，不是「压成了空」", () => {
    // 这一条是承重的：把空串当成功会让整段输出从模型眼前消失。
    assert.equal(parseHookOutput(wrapped("")), undefined);
  });

  it("rtk 什么都不发（空串 / 纯空白）→ undefined", () => {
    assert.equal(parseHookOutput(""), undefined);
    assert.equal(parseHookOutput("  \n\t\n"), undefined);
  });

  it("不是 JSON（OSS 版没有引擎）→ undefined", () => {
    assert.equal(parseHookOutput("not json at all"), undefined);
  });

  it("JSON 但缺三级路径里的任何一级 → undefined", () => {
    for (const body of [
      {},
      { hookSpecificOutput: {} },
      { hookSpecificOutput: { updatedToolOutput: {} } },
      { hookSpecificOutput: { updatedToolOutput: { stdout: 42 } } },
    ]) {
      assert.equal(parseHookOutput(JSON.stringify(body)), undefined, JSON.stringify(body));
    }
  });

  it("数组不算对象（三层判空的守卫要挡住它）", () => {
    assert.equal(parseHookOutput(JSON.stringify([{ hookSpecificOutput: {} }])), undefined);
  });

  it("前后空白不影响解析（rtk 末尾带换行）", () => {
    assert.equal(parseHookOutput(`\n${wrapped(CLEANED)}\n`), CLEANED);
  });
});
