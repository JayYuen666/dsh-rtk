// src/client-entry.ts —— 设置卡入口：样式注入 + 配置表单绑定 + 插槽注册。
// 取值与判定全部落在 lib/card-logic.ts；本文件只做 React 渲染与副作用挂载。
//
// 槽位 key（BUNDLE_PKG）与宿主模块表键必须逐字相同——build-client.mjs 在构建期核对它，
// 因此这个字面量不能改成模板串。导出形态与兄弟仓一致：只有命名导出，没有 default——
// 两者混用会让 rolldown 报 MIXED_EXPORTS，且外壳那层取默认导出时拿到的是命名空间对象。
import { createElement, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CARD_UI_CSS,
  CardForm,
  ListField,
  NumberField,
  SaveBar,
  Section,
  SelectField,
  TextField,
  ToggleField,
  diffTouched,
  errorText,
  splitHint,
} from "@jayyuen66/dsh-plugin-shared/client";
import type { SelectOption } from "@jayyuen66/dsh-plugin-shared/client";

import { RTK_LOGO_DATA_URI } from "./rtk-icon.ts";

import {
  FORM_MODES,
  cardStore,
  draftFields,
  formModeOf,
  formsOf,
  hintOf,
  numberOf,
  stringListOf,
} from "../lib/card-logic.ts";
import type { CardSnapshot, CardFields, SettingScope } from "../lib/card-logic.ts";
import { MIN_RTK_VERSION } from "../lib/rtk-version.ts";
import type { StatsStatus, StatsSummary } from "../lib/stats-shape.ts";
import { createStatsReader } from "./stats-reader.ts";
import type { StatsReader } from "./stats-reader.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { Translate } from "./ui-messages.ts";

/** bundle 包名。槽位 key 必须用它（owner 派发 `entryKey: pkg.name`），用 `id: rtk` 卡片不渲染。
 *  必须是**字面量声明**：build-client.mjs 的 verifyName 用 `/(?:const|let|var)\s+BUNDLE_PKG\s*=\s*"…"/`
 *  读它并跟 package.json 的 name 逐字比对，写成 `= PACKAGE_NAME` 会让那条核对当场红。 */
export const BUNDLE_PKG = "@jayyuen66/dsh-rtk";
/** 设置命名空间 = cordis.patch.yml 的条目 id。 */
const NS = "rtk";
/** 设置页左侧一级分区的 id（`settings.section` 的 `id`，图标靠同一个值对上）。
 *  与 NS 分开写：分区 id 是**页面位置**的名字，命名空间是**配置与文案**的名字，两者
 *  哪天拆开（比如一个分区放两张卡）时不该互相牵连。 */
const SECTION_ID = "rtk";
/** 分区在导航里的位次：宿主已占 -10/0/10/15/20，本包三个分区排 30 起。 */
const SECTION_ORDER = 31;
/** 卡片样式表 id：同一页面挂两张同 id 的 <style> 会让后一张覆盖前一张。 */
const STYLE_ID = "rtk-card-css";
/** 卡片自有样式（与 shared 的 CARD_UI_CSS 一起注入，本文件只放差异项）。 */
const CARD_CSS = [
  ".rtkc-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);margin:6px 0}",
  ".rtkc-hint{font-size:12px;line-height:1.7;margin:6px 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-warning,#3a2d12);color:var(--dsw-alias-label-primary,inherit)}",
  ".rtkc-ready{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,inherit);margin:6px 0}",
  ".rtkc-actions{margin-top:8px}",
  // 一级分区里没有插件页那层卡片外壳，自己给一点上下留白，样式与插件页那张卡一致。
  ".rtkc-page{padding:4px 0 8px}",
  // 导航图标：官方标记的 PNG 当 alpha 遮罩，颜色由 `background-color: currentColor` 给，
  // 于是深色主题是浅色标记、浅色主题是深色标记，跟宿主导航行同色。图形一个像素都不改。
  // data URI 来自 `./rtk-icon.ts` 的常量而不是在这里再抄一份字面量：两处字面量迟早会不同步。
  `.rtkc-icon{display:inline-block;background-color:currentColor;-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-image:url(${RTK_LOGO_DATA_URI});mask-image:url(${RTK_LOGO_DATA_URI})}`,
].join("\n");

export const inject = ["slots", "configForms", "locale"];

interface CardSlotProps {
  readonly t: Translate;
  readonly useCard: <Type>(selector: (snap: CardSnapshot) => Type) => Type;
  readonly set: (field: string, value: unknown) => Promise<boolean>;
  readonly unset: (field: string) => Promise<boolean>;
  readonly statsRemote: StatsReader | undefined;
}

/** 数值输入：空串表示「清空 = 恢复默认」，不是 0。 */
function numberField(props: {
  t: Translate;
  field: string;
  label: string;
  hint: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  editable: boolean;
  onChange: (next: number | undefined) => void;
}): ReactNode {
  return createElement(NumberField, {
    label: props.label,
    hint: props.hint,
    field: props.field,
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step,
    invalidHint: props.t("outOfRange"),
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/**
 * rtk 缺失 / 版本过低时卡片顶部那条引导行。
 *
 * 判定本身在 `lib/card-logic.ts` 的 `hintOf`（DOM-free，能在 node 里单测；本文件只做渲染，
 * 不参与覆盖率门禁）。两句话分别对应两种不同的失败，**不能合并**：`rtkPath === null` 是
 * 「这台机器上没装」，该给安装命令；`supported === false` 是「装了但太旧」，该说升到几。
 * `rtkVersion` 分不开它们——探测失败也交 `null`，所以判据取 `supported`。
 */
function RtkHint(props: { t: Translate; status: StatsStatus | undefined }): ReactNode {
  const { t, status } = props;
  const hint = hintOf(status);
  if (hint === undefined) {
    return null;
  }
  // 三支各自一句话，且就绪支用中性样式：它要说的是「已装、版本够」，
  // 用警告底色会让正常状态看起来像出了问题（那是 missing/too-old 才该有的样子）。
  let node: ReactNode;
  if (hint.kind === "missing") {
    node = createElement("p", { className: "rtkc-hint" }, t("rtkMissingHint"));
  } else if (hint.kind === "too-old") {
    node = createElement(
      "p",
      { className: "rtkc-hint" },
      t("rtkTooOldHint", { version: hint.version, minimum: MIN_RTK_VERSION }),
    );
  } else {
    node = createElement(
      "p",
      { className: "rtkc-ready" },
      t("rtkReadyHint", { version: hint.version, path: hint.path }),
    );
  }
  return node;
}

/** 统计区：读面缺失或首读未回来时给一行说明，不判错（压缩本身不受统计影响）。 */
function StatsSection(props: {
  t: Translate;
  reader: StatsReader | undefined;
  summary: StatsSummary | undefined;
  onReset: () => void;
}): ReactNode {
  const { t, reader, summary } = props;
  if (reader === undefined || summary === undefined) {
    return createElement(
      Section,
      { title: t("statusSection") },
      createElement("p", { className: "rtkc-note" }, t("statsUnavailable")),
    );
  }
  const numbers = [t("statsCommands"), t("statsSaved"), t("statsSavings")].join(" / ");
  // 省下的量报 **token**（与节省率同一口径）：一个按字节、一个按 token 并排写，
  // 两个数会各说一套，而用户没法从界面上看出它们不是一回事。
  const values = [
    String(summary.commands),
    String(summary.savedTokens),
    `${String(summary.savingsPct)}%`,
  ].join(" / ");
  return createElement(
    Section,
    { title: t("statusSection") },
    createElement("p", null, `${numbers}: ${values}`),
    // spec §6：按形态分账。改写那一档记不到原始字节（命令在进 shell 之前就被换掉了），
    // 所以这里只报命令数——把两档都塞进「节省字节」会让读数变成半真半假的合计数。
    createElement(
      "p",
      null,
      `${t("statsByForm")}: ${String(summary.byForm.prefix)} / ${String(summary.byForm.pipe)}`,
    ),
    createElement("p", { className: "rtkc-note" }, t("statsNote")),
    createElement(
      "button",
      { type: "button", className: "rtkc-actions", onClick: props.onReset },
      t("resetStats"),
    ),
  );
}

/**
 * 九个可写字段的写入分派。**字段名必须是字面量**：schema-coverage 门禁按 `set("字段名")`
 * 的字面量识别「这一格有绑定」，拼变量名会让它判成未绑定、整包门禁红。
 */
async function writeField(
  set: (field: string, value: unknown) => Promise<boolean>,
  key: string,
  draft: unknown,
): Promise<boolean> {
  if (key === "enabled") {
    return set("enabled", draft === true);
  }
  if (key === "enabledForms") {
    return set("enabledForms", formsOf(formModeOf(draft)));
  }
  if (key === "denyCommands") {
    return set("denyCommands", stringListOf(draft));
  }
  if (key === "enabledFilters") {
    return set("enabledFilters", stringListOf(draft));
  }
  if (key === "minBytes") {
    return set("minBytes", numberOf(draft));
  }
  if (key === "minGainRatio") {
    return set("minGainRatio", numberOf(draft));
  }
  if (key === "stdoutCapBytes") {
    return set("stdoutCapBytes", numberOf(draft));
  }
  if (key === "warnHint") {
    return set("warnHint", draft !== false);
  }
  return set("rewriteHostEnv", typeof draft === "string" ? draft : "");
}

/** 一个键的落盘动作：草稿不存在（= 用户清空）走 unset 恢复默认，否则写。 */
async function commitField(props: CardSlotProps, key: string, draft: unknown): Promise<boolean> {
  if (draft === undefined) {
    return props.unset(key);
  }
  return writeField(props.set, key, draft);
}

/** 草稿副本去掉一批键（保存成功后的清理；不就地改 state）。 */
function withoutKeys(
  touched: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  // 用重建而不是 `delete`：工作区的 no-dynamic-delete 判 error，而这里删的键本来就是
  // 一批动态键名，逐个 `delete` 既过不了 lint、也让「哪些键留下」这件事读起来要追副作用。
  return Object.fromEntries(Object.entries(touched).filter(([key]) => !keys.includes(key)));
}

/**
 * 开关控件：把「文案 → splitHint → props」这三跳收在一处。
 *
 * 不抽出来的写法必须在调用点写 `createElement(ToggleField, { …splitHint(t("…")) })`，
 * 那是三层嵌套调用，会触发 unicorn/max-nested-calls（上限 3）。
 */
function toggleField(props: {
  label: string;
  hint: string;
  field: string;
  checked: boolean;
  editable: boolean;
  onChange: (next: boolean) => void;
}): ReactNode {
  return createElement(ToggleField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    checked: props.checked,
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 逗号分隔的列表控件（同 `toggleField` 的理由）。 */
function listField(props: {
  label: string;
  hint: string;
  field: string;
  value: readonly string[];
  editable: boolean;
  onChange: (next: readonly string[]) => void;
}): ReactNode {
  return createElement(ListField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    value: props.value,
    separator: "comma",
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 单行文本控件（同 `toggleField` 的理由）。 */
function textField(props: {
  label: string;
  hint: string;
  field: string;
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
}): ReactNode {
  return createElement(TextField, {
    label: props.label,
    ...splitHint(props.hint),
    field: props.field,
    value: props.value,
    placeholder: "",
    monospace: true,
    disabled: !props.editable,
    onChange: props.onChange,
  });
}

/** 三个分区共用的入参（拆分区只为压住单函数体量，不改变任何一格的语义）。 */
interface FieldSectionProps {
  readonly t: Translate;
  readonly view: CardFields;
  readonly writable: boolean;
  readonly setField: (name: string, draft: unknown) => void;
}

/** 形态区：总开关、形态选择，以及 B 形态未开时的一行说明。 */
function cardModeFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField } = props;
  // 三档顺序按「层级从少到多」排，而不是按 FORM_MODES（那是给表单取默认值用的顺序）。
  // 少一档都不行：`['pipe']` 若无处可选，卡片会把用户的存储值投影成别的档，
  // 用户只点一次保存就静默改了形态（见 lib/card-logic.ts 的 FORM_MODES 注释）。
  const modeOptions: SelectOption[] = [
    { value: FORM_MODES[0], label: t("formPrefix") },
    { value: FORM_MODES[1], label: t("formPrefixAndPipe") },
    { value: FORM_MODES[2], label: t("formPipeOnly") },
  ];
  return [
    toggleField({
      label: t("enabledLabel"),
      hint: t("enabledHint"),
      field: "enabled",
      checked: view.enabled,
      editable: writable,
      onChange: (next) => {
        setField("enabled", next);
      },
    }),
    createElement(SelectField, {
      label: t("formsLabel"),
      ...splitHint(t("formsHint")),
      field: "enabledForms",
      value: view.forms,
      options: modeOptions,
      disabled: !writable,
      onChange: (next: string) => {
        // 草稿里存**存储单位**（数组），不是档位字符串：`draftFields` 与 `writeField` 都按
        // 存储单位读，混一种单位就会「下拉点得动、值不跟着变」。
        setField("enabledForms", formsOf(formModeOf(next)));
      },
    }),
    view.forms === "prefix"
      ? createElement("p", { className: "rtkc-note" }, t("pipeDisabledHint"))
      : null,
  ];
}

/** 两张清单：拒绝前缀与 filter 白名单。 */
function cardFilterFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField } = props;
  return [
    listField({
      label: t("denyLabel"),
      hint: t("denyHint"),
      field: "denyCommands",
      value: view.denyCommands,
      editable: writable,
      onChange: (next) => {
        setField("denyCommands", next);
      },
    }),
    listField({
      label: t("filtersLabel"),
      hint: t("filtersHint"),
      field: "enabledFilters",
      value: view.enabledFilters,
      editable: writable,
      onChange: (next) => {
        setField("enabledFilters", next);
      },
    }),
  ];
}

/** 三个字节/比例阈值 + 提示开关 + 宿主环境变量。 */
function cardNumberFields(props: FieldSectionProps): ReactNode[] {
  const { t, view, writable, setField } = props;
  return [
    numberField({
      t,
      field: "minBytes",
      label: t("minBytesLabel"),
      hint: t("minBytesHint"),
      value: view.minBytes,
      min: 0,
      max: 1_048_576,
      step: 1,
      editable: writable,
      onChange: (next) => {
        setField("minBytes", next);
      },
    }),
    numberField({
      t,
      field: "minGainRatio",
      label: t("minGainLabel"),
      hint: t("minGainHint"),
      value: view.minGainRatio,
      min: 0,
      max: 1,
      step: 0.01,
      editable: writable,
      onChange: (next) => {
        setField("minGainRatio", next);
      },
    }),
    numberField({
      t,
      field: "stdoutCapBytes",
      label: t("stdoutCapLabel"),
      hint: t("stdoutCapHint"),
      value: view.stdoutCapBytes,
      min: 1,
      max: 10_485_760,
      step: 1,
      editable: writable,
      onChange: (next) => {
        setField("stdoutCapBytes", next);
      },
    }),
    toggleField({
      label: t("warnHintLabel"),
      hint: t("warnHintHint"),
      field: "warnHint",
      checked: view.warnHint,
      editable: writable,
      onChange: (next) => {
        setField("warnHint", next);
      },
    }),
    textField({
      label: t("hostEnvLabel"),
      hint: t("hostEnvHint"),
      field: "rewriteHostEnv",
      value: view.rewriteHostEnv,
      editable: writable,
      onChange: (next) => {
        setField("rewriteHostEnv", next);
      },
    }),
  ];
}

function RtkCard(props: CardSlotProps): ReactNode {
  const snap = props.useCard((state) => state);
  const writable = snap.status === "ready" && snap.writable;
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StatsSummary | undefined>(undefined);
  const [status, setStatus] = useState<StatsStatus | undefined>(undefined);
  const { statsRemote: reader, t } = props;

  const refresh = useCallback(async (): Promise<void> => {
    if (reader === undefined) {
      return;
    }
    try {
      setSummary(await reader.summary());
    } catch {
      // 读面报错不清空已显示的数字：保留上一次成功的读数，比闪成「未连接」更少误导。
      setSummary(undefined);
    }
    // 状态与统计各读各的：一条失败不该把另一条也抹掉（统计读面缺席时压缩照常，
    // 而 rtk 装没装正是用户最需要看到的那一句）。
    try {
      setStatus(await reader.status());
    } catch {
      setStatus(undefined);
    }
  }, [reader]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const view = draftFields(touched, snap.value);
  const dirty = diffTouched(touched, snap.value);
  const setField = (name: string, draft: unknown): void => {
    setTouched((prev) => ({ ...prev, [name]: draft }));
  };

  const save = async (): Promise<void> => {
    if (dirty.length === 0) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const results = await Promise.all(dirty.map((key) => commitField(props, key, touched[key])));
      if (results.some((accepted) => !accepted)) {
        setSaveError(t("saveRejected"));
        return;
      }
      setTouched((prev) => withoutKeys(prev, dirty));
    } catch (error) {
      setSaveError(t("saveFailed", { reason: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };

  const resetStats = async (): Promise<void> => {
    if (reader === undefined) {
      return;
    }
    try {
      setSummary(await reader.reset());
    } catch {
      setSummary(undefined);
    }
  };

  const saveBar = createElement(SaveBar, {
    dirty: dirty.length > 0,
    busy,
    writable,
    error: saveError,
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("revert"),
    dirtyLabel: t("dirtyCount", { count: dirty.length }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: () => {
      void save();
    },
    onDiscard: () => {
      setTouched({});
      setSaveError(null);
    },
  });

  return createElement(
    CardForm,
    null,
    createElement("h2", null, t("cardTitle")),
    // 引导行在说明之前：rtk 不在 PATH 时下面所有开关都不会有效果，先说这件事。
    createElement(RtkHint, { t, status }),
    createElement("p", { className: "rtkc-note" }, t("saveHint")),
    createElement(StatsSection, {
      t,
      reader,
      summary,
      onReset: () => {
        void resetStats();
      },
    }),
    createElement(
      Section,
      { title: t("switchSection") },
      cardModeFields({ t, view, writable, setField }),
      cardFilterFields({ t, view, writable, setField }),
      cardNumberFields({ t, view, writable, setField }),
    ),
    saveBar,
  );
}

/**
 * 设置页导航图标（`settings.section.icon`）。
 *
 * 图形是 **rtk 官方标记**（`src/rtk-icon.ts` 里内联的那张 PNG，字节与 sha256 都记在那边）：
 * 用户明确要求「直接使用 rtk 官方的」，不要矢量化、不要剪影。这里只做一件事——把官方位图
 * 当 alpha 遮罩、用 `currentColor` 上色，于是深色主题是浅色标记、浅色主题是深色标记，
 * 与宿主导航行同色。**形状与 alpha 一个像素都不改**。
 *
 * 为什么用遮罩而不是直接 `<img src>`：官方标记是**白色**线稿，浅色主题下直接放进去就是
 * 白底白图看不见；而先改图再内联等于动官方像素（正是被否决的那条路）。遮罩只取 alpha。
 *
 * 样式写在 `CARD_CSS` 的 `.rtkc-icon` 里（data URI 那份长字符串只在样式表里出现一次）。
 *
 * @param props - `size` 是导航行要的方形边长，`active` 表示该分区当前被选中。
 * @returns 一个用遮罩上色的方块。
 */
function RtkSectionIcon(props: { readonly size: number; readonly active: boolean }): ReactNode {
  return createElement("span", {
    className: "rtkc-icon",
    style: { width: props.size, height: props.size },
    "aria-hidden": true,
    "data-rtk-section-icon": props.active ? "active" : "idle",
  });
}

/** 分区页面外壳：一级分区里没有插件页那层卡片外壳，这里补一点留白。 */
function RtkSection(props: CardSlotProps): ReactNode {
  return createElement("div", { className: "rtkc-page" }, createElement(RtkCard, props));
}

/** 客户端上下文里本模块用到的那几位（方法子集投影：官方的服务类带私有字段，替身满足不了）。 */
interface ClientCtx {
  effect: (run: () => () => void, label: string) => void;
  configForms: { get: (entryId: string) => SettingScope };
  locale: {
    register: (ns: typeof NS, dicts: typeof UI_MESSAGES) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
  slots: {
    inject: (name: string, run: () => () => void) => void;
    register: (slot: Record<string, unknown>, component: unknown) => () => void;
  };
  get?: (name: string, strict?: boolean) => unknown;
}

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = `${CARD_CSS}\n${CARD_UI_CSS}`;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "rtk-card: styles");

  // 本条目的共享表单：条目 id == cordis.patch.yml 里的裸 id `rtk`（settings 命名空间即条目 id），
  // 与 host 侧隐式注册的命名空间同源，故直接复用 NS。表单生命周期归 provider。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "rtk-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  const statsRemote = createStatsReader(ctx);

  // 写通道受理结果**原样透传**给卡片（消费在 save()：false → saveRejected 且保留 touched；
  // 这里只补字段级 console.error 供排查，rejection 照旧上抛、统一处理成 saveFailed 文案）。
  const writeFieldOf = async (field: string, value: unknown): Promise<boolean> => {
    try {
      return await scope.set(field, value);
    } catch (error) {
      console.error(`[rtk] set ${field} failed:`, error);
      throw error;
    }
  };
  const unsetField = async (field: string): Promise<boolean> => {
    try {
      return await scope.unset(field);
    } catch (error) {
      console.error(`[rtk] unset ${field} failed:`, error);
      throw error;
    }
  };

  // 卡片的两份 inject 完全同形：`plugins.bundle.config`（插件详情页）与 `settings.section`
  // （设置页一级分区）吃同一批位。写成一处工厂是为了「两处显示同一份配置」这件事没有第二
  // 种实现——注入面各写一份，迟早出现「详情页能改、设置页改不动」这种只差一位的故障。
  const cardInject = (): {
    readonly t: Translate;
    readonly hooks: { readonly card: typeof store };
    readonly set: (field: string, value: unknown) => Promise<boolean>;
    readonly unset: (field: string) => Promise<boolean>;
    readonly statsRemote: StatsReader | undefined;
  } => ({
    t,
    hooks: { card: store },
    set: writeFieldOf,
    unset: unsetField,
    statsRemote,
  });

  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        // 必须是 bundle 包名：owner 派发时给的是 `entryKey: pkg.name`，按裸条目 id 注册 = 卡片完全不渲染。
        key: BUNDLE_PKG,
        inject: cardInject,
      },
      RtkCard,
    ),
  );

  // 设置页左侧一级分区。`label` 给的是 thunk 而不是字符串：宿主每次读导航行都重新求值，
  // 于是切语言时这一行跟着变，而不需要本插件重新注册。
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t("navLabel"),
        inject: cardInject,
      },
      RtkSection,
    ),
  );

  // 导航图标：id 必须与上面那条 `settings.section` 的 id 逐字相同，对不上时宿主
  // 一条都不渲染（`settings.section.icon` 的 doc 原文），症状是分区还在、图标一直是默认齿轮。
  ctx.slots.inject("settings.section.icon", () =>
    ctx.slots.register(
      {
        name: "settings.section.icon",
        id: SECTION_ID,
        order: SECTION_ORDER,
      },
      RtkSectionIcon,
    ),
  );
}

export { apply };
