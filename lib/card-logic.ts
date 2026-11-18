// lib/card-logic.ts —— 卡片的 DOM-free 纯逻辑：快照投影 + 草稿读数 + 字段投影。
// 可被 host 侧单测直接 import（不经过含 document 的 src/client-entry.ts，否则会把 DOM 类型
// 拖进 host typecheck）。client-entry 只做 React 渲染与 scope 绑定，取值/判定一律落在这里。
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { StatsStatus } from "./stats-shape.ts";

/** 本条目那张表单：`ConfigForm<Record<string, unknown>>`，六个成员全必选（官方声明）。 */
export type SettingScope = ConfigForm<Record<string, unknown>>;

/** 卡片自己的渲染视模型。`value` 是官方 `value: T | undefined` 的兜底收窄。 */
export interface CardSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly writable: boolean;
  readonly value: Record<string, unknown>;
}

export interface CardStore {
  readonly getSnapshot: () => CardSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * 官方表单 → 本卡的视模型，按快照引用缓存。
 *
 * **值在 `snap.value` 里**：官方快照是 `{status, value, base, user, revision, writable}`；
 * 把快照本身当值对象读，草稿永远等于空、卡片永远显示默认值，而类型系统不会拦
 * （`value` 只是索引签名）。
 * 缓存按引用判等是为了让 React 的 `useSyncExternalStore` 拿到稳定引用——每次新建对象
 * 会让它每帧重渲染。
 */
export function cardStore(scope: SettingScope): CardStore {
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | undefined;
  let cachedView: CardSnapshot | undefined;
  return {
    getSnapshot(): CardSnapshot {
      const snap = scope.getSnapshot();
      if (snap === cachedSnap && cachedView !== undefined) {
        return cachedView;
      }
      cachedSnap = snap;
      cachedView = { status: snap.status, writable: snap.writable, value: snap.value ?? {} };
      return cachedView;
    },
    subscribe(listener: () => void): () => void {
      return scope.subscribe(listener);
    },
  };
}

/** 草稿层是否写过这一格。只判**自有**属性：`in` 会沿原型链把 `toString` 也认成草稿。 */
export function hasDraft(touched: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(touched, field);
}

/** 读一格：草稿优先，其次已提交值，都没有就 undefined。 */
export function draftOf(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
  field: string,
): unknown {
  if (Object.hasOwn(touched, field)) {
    return touched[field];
  }
  return Object.hasOwn(value, field) ? value[field] : undefined;
}

/** 列表字段的分隔符：中英文用户都可能写逗号，也可能一行一个。 */
const LIST_SEPARATOR = /[,\n]/u;

/** 逗号/换行分隔的字符串列表字段（`denyCommands` / `enabledFilters`）。非字符串一律空表。 */
export function stringListOf(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 数值字段：只收有限数字。空串（= 清空恢复默认）与 `"256"` 都返回 undefined。 */
export function numberOf(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** 只开 C 的那一档。 */
const MODE_PREFIX = "prefix";

/** C + B 一起开的那一档。 */
const MODE_PREFIX_PIPE = "prefix+pipe";

/** 只开 B 的那一档。 */
const MODE_PIPE = "pipe";

/**
 * `enabledForms` 的显示档位。存储是多选数组，卡片给三档：只开 C、只开 B、C + B。
 *
 * **三档必须覆盖存储里每一个合法数组值**，否则卡片会静默改写配置：少 `pipe` 那一档时，
 * `['pipe']` 会被投影成「C + B」，用户点一下 `保存`（哪怕没碰这个控件）就顺带把前缀层
 * 打开了——那是会改命令文本、会写 rtk `history.db` 的一层。反过来 `formsOf` 对每一档
 * 都必须回**原样**的数组，不能借道「含 pipe 就是双开」这种归一。
 */
export const FORM_MODES = [MODE_PREFIX, MODE_PREFIX_PIPE, MODE_PIPE] as const;

export type FormMode = (typeof FORM_MODES)[number];

/** 档位判据（类型守卫，不用断言）：下拉交回来的字符串只认这三个字面量。 */
function isFormMode(value: unknown): value is FormMode {
  return typeof value === "string" && FORM_MODES.some((mode) => mode === value);
}

/**
 * 存储数组 → 显示档位。
 *
 * 判据是**逐档相等**而非「含不含 pipe」：后者会把 `['pipe']` 与 `['prefix','pipe']` 折成同一档，
 * 卡片保存时再写回双开 —— 用户只是想关掉前缀层，结果被打开了。
 *
 * 认不出来（未设置 / 不是数组 / 将来多出的组合）一律落 `prefix`：那是 host schema 自己的默认值。
 * `writeField` 只为用户真动过的控件写回，所以这一档也只在用户亲手选过时才落到存储上。
 */
export function formModeOf(value: unknown): FormMode {
  // 卡片自己的下拉把「档位」当草稿值交回来（`FORM_MODES` 的字符串），而存储面是数组。
  // 两种单位都认：只认数组会让用户点一次下拉后看到的值（和保存时写回的数组）都落回 prefix，
  // 也就是「点得动、但永远选不中」。
  if (isFormMode(value)) {
    return value;
  }
  // 读不到（未设置 / 不是数组）落回 host schema 的默认 `['prefix']`，不落双开：
  // 卡片显示的必须是「宿主真会用哪一层」，猜错一侧就会在用户没同意时开改写。
  let mode: FormMode = MODE_PREFIX;
  if (Array.isArray(value)) {
    const forms = new Set<unknown>(value);
    if (forms.has("prefix") && !forms.has("pipe")) {
      mode = MODE_PREFIX;
    } else if (!forms.has("prefix") && forms.has("pipe")) {
      mode = MODE_PIPE;
    } else if (forms.has("prefix") && forms.has("pipe")) {
      mode = MODE_PREFIX_PIPE;
    }
  }
  return mode;
}

/** 显示档位 → 存储数组。每一档回原样，三档互不折叠。 */
export function formsOf(mode: FormMode): readonly string[] {
  let forms: readonly string[] = [MODE_PREFIX, MODE_PIPE];
  if (mode === MODE_PREFIX) {
    forms = [MODE_PREFIX];
  } else if (mode === MODE_PIPE) {
    forms = [MODE_PIPE];
  }
  return forms;
}

/** 卡片渲染的九个字段（= host schema 里全部 volatile 字段）。 */
export interface CardFields {
  readonly enabled: boolean;
  readonly forms: FormMode;
  readonly denyCommands: readonly string[];
  readonly enabledFilters: readonly string[];
  readonly minBytes: number | undefined;
  readonly minGainRatio: number | undefined;
  readonly stdoutCapBytes: number | undefined;
  readonly warnHint: boolean;
  readonly rewriteHostEnv: string;
}

/** 把草稿层 + 已提交值投影成九个字段。缺值一律给「安全默认」，不抛。 */
export function draftFields(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
  defaultEnabled = false,
): CardFields {
  const read = (field: string): unknown => draftOf(touched, value, field);
  const hostEnv = read("rewriteHostEnv");
  const enabled = read("enabled");
  return {
    // 未显式设置时由调用方给的就绪默认值决定（宿主 supported === true）；显式布尔值优先。
    enabled: typeof enabled === "boolean" ? enabled : defaultEnabled,
    forms: formModeOf(read("enabledForms")),
    denyCommands: stringListOf(read("denyCommands")),
    enabledFilters: stringListOf(read("enabledFilters")),
    minBytes: numberOf(read("minBytes")),
    minGainRatio: numberOf(read("minGainRatio")),
    stdoutCapBytes: numberOf(read("stdoutCapBytes")),
    // 读不到就当开：warnHint 的默认值是 true，只有显式 false 才关。
    warnHint: read("warnHint") !== false,
    rewriteHostEnv: typeof hostEnv === "string" ? hostEnv : "",
  };
}

/**
 * 卡片顶部引导行的两种形态。
 *
 * 分成两个 kind 而不是一句话带 `{reason}`：**「没装」与「太旧」要给的东西不一样**——
 * 前者是安装命令（用户手上没有可升级的东西），后者是「你手上这版低于几，去升级」。
 * 一个模板硬塞两种含义，翻译时就没法各自写顺。
 */
export type CardHint =
  | { readonly kind: "missing" }
  | { readonly kind: "too-old"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string; readonly path: string };

/**
 * 从运行时状态推出该不该显示引导行。
 *
 * 判据取 `supported` 而不是拿 `rtkVersion` 与下限自己比：版本解析与下限比较的真源在
 * `lib/rtk-version.ts`（宿主侧已经算过一遍），客户端再算一遍就有了第二个口径——两处对
 * 预发布后缀这类边界的处理一旦分叉，卡片说「太低」而插件照常改写。
 *
 * `status === undefined`（还没读到 / 读面报错）时什么都不显示：这时既不知道装没装，
 * 也不知道版本，显示任何一句都是猜。
 */
export function hintOf(status: StatsStatus | undefined): CardHint | undefined {
  // 单出口：`treatUndefinedAsUnspecified` 下裸 `return undefined` 会被 consistent-return
  // 记成「这个函数不返回值」，与后面几支交对象自相矛盾——这一带的写法统一走 let + 末尾一次 return。
  let hint: CardHint | undefined;
  if (status !== undefined) {
    if (status.rtkPath === null) {
      hint = { kind: "missing" };
    } else if (status.supported === false) {
      // 版本串读不到时给 `?`：这一支只可能出现在「探到了 supported=false 但没留下原文」的
      // 构造里，正常探测两者同时有；给空串会让句子读成「探到的 rtk 是 ，低于支持的 1.0.0」。
      hint = { kind: "too-old", version: status.rtkVersion ?? "?" };
    } else if (status.supported === true) {
      // 就绪行：`{installed, version}` 是 spec §7.1 点名要显示的东西，README 也承诺了
      // 「卡片的就绪行会写出解析到的二进制与它的版本」。只显示 path 不显示版本会让
      // 「装了但版本不对」这件事只能靠用户自己去 `rtk --version` 核对。
      hint = { kind: "ready", version: status.rtkVersion ?? "?", path: status.rtkPath };
    }
  }
  return hint;
}

/**
 * 「启用 rtk 压缩」的说明键。
 *
 * 仅改写形态不会碰输出，pipe 形态不碰命令；一条静态说明无法同时说对，所以由形态选中
 * 对应文案。放在纯逻辑层是为了让「pipe / prefix+pipe 都拿到 pipe 说明」这条可单测。
 */
export function enabledHintKeyOf(forms: FormMode): "enabledHintPrefix" | "enabledHintWithPipe" {
  return forms === MODE_PREFIX ? "enabledHintPrefix" : "enabledHintWithPipe";
}
