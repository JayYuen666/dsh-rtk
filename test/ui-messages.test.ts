// src/ui-messages.ts 单测：设置卡两语字典的键集 / 占位符同源（卡片没有 jsdom 渲染用例，
// 字典完整性就是这半边 i18n 把关的那一步；产物层面的断言在 build-client.test.ts）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { UiMessages } from "../src/ui-messages.ts";
import { CJK_RESIDUE } from "./cjk-residue.ts";

/**
 * 渲染这份字典的官方插值器是 `template.replace(/\{(\w+)\}/g, …)`，两处都要照它来：
 *   · 名字语法取 `\w+`，比它宽就会去比渲染器根本不填的名字，比它窄就漏判；
 *   · 它是 `g` 档全替换 ⇒ 同一个占位符出现两次就该被填两次，所以这里交回**列表**
 *     （多重集），用 Set 会把重复抹平，两语的重复次数之差就看不见。
 * 填不掉的残留花括号（`{min`、`{count }`、`{exit-code}` 这一类写坏的模板）官方会原样留在
 * 界面上，所以由 assertBracesFilled 单独判掉，而不是指望名字比对去发现它。
 */
const PLACEHOLDER = /\{(?<name>\w+)\}/gu;

/** 捕获组对每一条匹配必然参与（整个模式就是它），这里的 `?? ""` 只是给类型收窄提供一个位置。 */
function placeholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (found) => found.groups?.["name"] ?? "");
}

/** 剥掉所有会被填的占位符后，不该再有落单的花括号。 */
function assertBracesFilled(template: string, label: string): void {
  assert.doesNotMatch(
    template.replaceAll(PLACEHOLDER, ""),
    /[{}]/u,
    `${label} 有填不掉的花括号（渲染器只认 {\\w+}）：${template}`,
  );
}

const KEYS = Object.keys(UI_MESSAGES.zh) as (keyof UiMessages)[];

describe("设置卡双语字典", () => {
  it("zh / en 键集一致（一个不多一个不少）", () => {
    const zhKeys = new Set(KEYS);
    const enKeys = new Set(Object.keys(UI_MESSAGES.en));
    assert.equal(zhKeys.size, enKeys.size, "键数不等");
    for (const key of zhKeys) {
      assert.equal(enKeys.has(key), true, `en 缺键 ${key}`);
    }
  });

  it("每条模板的 {占位符} 集合在两语间一致（翻译不许漏插值）", () => {
    for (const key of KEYS) {
      assertBracesFilled(UI_MESSAGES.zh[key], `zh.${key}`);
      assertBracesFilled(UI_MESSAGES.en[key], `en.${key}`);
      const zhNames = placeholders(UI_MESSAGES.zh[key]).toSorted();
      const enNames = placeholders(UI_MESSAGES.en[key]).toSorted();
      assert.deepEqual(
        enNames,
        zhNames,
        `${key} 占位符不一致（含重复次数）：zh=${zhNames.join(",")} en=${enNames.join(",")}`,
      );
    }
  });

  it("文案非空，且英文那份通篇不残留中文（卡片整面可切换）", () => {
    for (const key of KEYS) {
      // 纯空白一样渲染成空白标签，所以判 trim 之后的长度。
      assert.ok(UI_MESSAGES.zh[key].trim().length > 0, `zh.${key} 为空或纯空白`);
      assert.ok(UI_MESSAGES.en[key].trim().length > 0, `en.${key} 为空或纯空白`);
    }
    assert.doesNotMatch(JSON.stringify(UI_MESSAGES.en), CJK_RESIDUE);
  });

  it("带插值的条目是模板，且每个占位符都被独立登记（渲染点漏参数会红）", () => {
    // 期望逐个键写死，不从字典自身派生：两语**同时**漏掉某个占位符时，「两语一致」那条照样绿。
    const EXPECTED: Partial<Record<keyof UiMessages, readonly string[]>> = {
      dirtyCount: ["count"],
      saveFailed: ["reason"],
      rtkTooOldHint: ["version", "minimum"],
      rtkReadyHint: ["version", "path"],
      rtkReadyBadge: ["version"],
      filtersHint: ["filters"],
      // Insights 页的「最近一次」：模板由「要不要 reason」与「有没有量到节省量/耗时」
      // 两个维度选出六条。六个位里缺任何一个，页面上就是一句带花括号的原文。
      whyLast: ["time", "family", "status", "reason"],
      whyLastLatency: ["time", "family", "status", "latency"],
      whyLastReasonLatency: ["time", "family", "status", "reason", "latency"],
      whyLastPlain: ["time", "family", "status"],
      whyLastSaved: ["time", "family", "status", "saved", "pct"],
      whyLastSavedLatency: ["time", "family", "status", "saved", "pct", "latency"],
      reasonsDetails: ["total"],
      reasonsTableFoot: ["total"],
      // 原因码超过 40 条时的聚合片名称：剩余类数必须写明。
      reasonsOtherCount: ["count"],
      workdirDetails: ["total"],
      filterDetails: ["total"],
      pieTotal: ["total"],
      // 饼图 hover：原因、次数、占比三个位。design 原句是中文全角分隔，英文用两个半角空格。
      pieTooltip: ["name", "value", "percent"],
      loadFailed: ["reason"],
      // 空窗口那句话：`{days}` 是窗口天数，`{form}` 是页签名。两个位缺一个，页面就会把
      // 花括号原样印出来——而它出现的时机正是「这一屏什么都没有」，最容易被当成插件坏了。
      emptyWindow: ["days", "form"],
      // 四条建议文案：service 只给参数，句子在这里拼。缺一个位，页面上就是花括号原文。
      suggestLowYieldFilter: ["filter", "days", "attempts", "compressed", "savingsPct"],
      suggestUnusedFilter: ["filter", "days"],
      suggestPotentialFilter: ["filter", "days", "matches"],
      suggestLowYieldCommand: ["family", "days", "attempts", "savingsPct"],
      // 页脚的 rtk 自账对账两条：`rtkSelfFailures` 带失败数/救回数/回收率三个位，
      // `rtkSelfOversized` 只带被 `rtk gain` 排除的行数。漏登记就等于新增了一条没人守的
      // 插值规则，页脚会原样印出花括号。
      rtkSelfFailures: ["failures", "recovered", "rate"],
      rtkSelfOversized: ["oversized"],
      // `rtkSelfRecall` 是取回库的体检数：条数 + 磁盘占用。两个占位符都不能省——只印条数
      // 会让「这个库在悄悄长大」这件事看不见。
      rtkSelfRecall: ["entries", "size"],
      // 明细表的表脚截断说明：总行数与上限两个位都要在，少了哪个「被截掉多少行」就读不出。
      tableTruncated: ["total", "limit"],
      tableShown: ["shown", "total"],
      tableExpand: [],
      tableCollapse: ["limit"],
      // 页头最近刷新时间：时间位漏了页面会原样印出花括号。
      updatedAtLabel: ["time"],
      // KPI 涨跌标注：涨跌位漏了就原样印花括号。
      kpiDeltaDay: ["delta"],
      kpiDeltaWeek: ["delta"],
      kpiDeltaMonth: ["delta"],
      // 页头副标题：整句直出，无占位符；登记只为钉住两语同键。
      panelSub: [],
      // 页脚窗口说明：天数位漏了会原样印出花括号。
      windowRange: ["days"],
      // 小节字段计数徽章：字段数位漏了会原样印花括号。
      fieldCount: ["count"],
    };
    for (const [key, expected] of Object.entries(EXPECTED) as [
      keyof UiMessages,
      readonly string[],
    ][]) {
      for (const locale of ["zh", "en"] as const) {
        assert.deepEqual(
          placeholders(UI_MESSAGES[locale][key]).toSorted(),
          [...expected].toSorted(),
          `${locale}.${key} 的占位符与登记不符`,
        );
      }
    }
    // 反向：字典里出现带花括号的模板却没登记，等于新增了一个没人守的插值规则。
    for (const key of KEYS) {
      if (placeholders(UI_MESSAGES.zh[key]).length > 0) {
        assert.ok(key in EXPECTED, `${key} 带占位符，却没登记到期望表`);
      }
    }
  });

  it("退柱那句说明必须同时交代「没画线」与「比率在哪」（否则会被读成比率丢了）", () => {
    // 用户 m21519 的原话：「Insights 页面的 图表 的节省量与比率，节省量展示出来了，但是比率
    // 没有展示出来啊，是数据问题还是代码bug啊？」——真实数据下有节省的桶只有 1~2 个，于是
    // 18 种窗口×粒度组合全部退成柱状图，读者看到的只有柱子。裁决（m21566）是保留稀疏保护、
    // 把提示做醒目，所以这句话必须自己把「比率没丢」说清楚，且指向它还在的两个地方。
    const anchors = {
      zh: { table: /表/u, rate: /节省率/u },
      en: { table: /table/iu, rate: /rate/iu },
    } as const;
    for (const locale of ["zh", "en"] as const) {
      const note = UI_MESSAGES[locale].chartSparseNote;
      // 前半句：为什么没有折线。阈值必须出现，读者才知道「差几个桶」。
      assert.match(note, /3/u, `${locale} 该给出稀疏阈值`);
      // 后半句：比率在哪。这两个词是页面上真实存在的锚（KPI 行与明细表），写空话不算。
      assert.match(note, /KPI/u, `${locale} 该指向 KPI 行`);
      assert.match(note, anchors[locale].table, `${locale} 该指向明细表`);
      assert.match(note, anchors[locale].rate, `${locale} 该点名它没丢的那个量`);
    }
  });

  it("今日摘要与形态提示写清口径、热更新与越界处理", () => {
    // 这些是历轮真机验收暴露的误导点：数字没有量纲说明、过滤器范围写错、
    // 形态改完要重启。现在形态是运行期现读，文案要承诺下一次调用即生效。
    //
    // 量纲从标题挪到了每格数字旁边（`todayCommandsUnit` / `todaySavedUnit`）：原来那句
    // 「今日（命令数 / 节省 token / 节省率）」是给一整行纯文本当前缀用的，改成两格卡片之后
    // 两格的单位各自不同，写在标题里反而对不上（改写格报的是次数，压缩格报的是次数+token）。
    // 所以门禁改成钉「单位词还在字典里、且两语各自非空」。
    assert.ok(UI_MESSAGES.zh.todayCommandsUnit.length > 0);
    assert.ok(UI_MESSAGES.zh.todaySavedUnit.length > 0);
    assert.ok(UI_MESSAGES.en.todayCommandsUnit.length > 0);
    assert.ok(UI_MESSAGES.en.todaySavedUnit.length > 0);
    // 空态那句话不能退化成空串：它是「今天这条形态没被用过」唯一的表达。
    assert.ok(UI_MESSAGES.zh.todayIdle.length > 0);
    assert.ok(UI_MESSAGES.en.todayIdle.length > 0);
    // 两形态必须是两个标签：合成一行就回到了「把两档算成一个节省率」那版。
    assert.notEqual(UI_MESSAGES.zh.todayPrefix, UI_MESSAGES.zh.todayPipe);
    assert.notEqual(UI_MESSAGES.en.todayPrefix, UI_MESSAGES.en.todayPipe);
    assert.match(UI_MESSAGES.zh.filtersHint, /仅结果压缩/u);
    assert.match(UI_MESSAGES.zh.formsHint, /下一次工具调用/u);
    assert.match(UI_MESSAGES.zh.enabledHintPrefix, /检测到受支持的 rtk/u);
    assert.notEqual(UI_MESSAGES.zh.enabledHintPrefix, UI_MESSAGES.zh.enabledHintWithPipe);
    assert.match(UI_MESSAGES.zh.invalidFields, /超出范围|修正/u);
    assert.match(UI_MESSAGES.en.formsHint, /next tool call/u);
    assert.match(UI_MESSAGES.en.enabledHintPrefix, /follows rtk readiness/u);
  });
});
