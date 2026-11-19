// lib/skill.ts —— 把完整的使用口径注册成一枚**虚拟 skill**（rc.2 的 `ctx.skills.register()`）。
//
// 为什么要有这一层：口径全文（`messages.usageText`）讲的是「两档压缩各做什么、什么一律不碰、
// 被省掉的原文去哪取回、想让某条命令原样输出时怎么办」，中文版约 3.4KB。整段常驻 systemPrompt
// 等于每个会话、每一轮都背一遍；而其中**每一步都要用到的**只有三条：读文件不压、被压掉的原文
// 取回得到、要精确判断时用 `rtk bypass`。所以拆成两份：
//   · systemPrompt 只留摘要（`messages.usageSummary`）＋一句指路（`messages.skillPointer`）；
//   · 全文注册成 skill `rtk`，模型按名加载（`skill({ name: "rtk" })`）。
//
// 与 dsh-zvec-grep / dsh-scrapling 同构，注册动作本身收在 shared：
// `@jayyuen66/dsh-plugin-shared/lib/skill` 的 `registerSkill(ctx, spec)` 承担「取可选服务 →
// 判形状 → register → 回布尔」的全过程（含「正文为空不注册」与「撤销权交给调用方 fiber」）。
// 本文件只剩本仓自己的两样：skill 名，与把三份文本收成 spec 的那一层。
//
// 服务是**可选**的：`@deepseek-ai/dsh-skill` 未装载（精简 profile）时注册只回 false，
// systemPrompt 那段摘要照旧生效——摘要本身已经把「不照做会误判」的三条写全了，skill 是
// 细节的载体而不是唯一入口。所以 `skills` **不进 inject 依赖表**：进了就把「有 skill 服务」
// 变成插件的硬性前提，而 profile 里它本来是可选的。
//
// 名字用 kebab-case（宿主 `isSkillName` 的语法）。这里取 `rtk` 而不是 `dsh-rtk`：模型看到的是
// 工具名与插件名的混合目录，`rtk` 与命令前缀 `rtk `、与洞察页那栏「rtk 统计」同名，最省一次
// 心智映射。
import { registerSkill } from "@jayyuen66/dsh-plugin-shared/lib/skill";
import type { SkillRegistryContext } from "@jayyuen66/dsh-plugin-shared/lib/skill";

/** skill 名：kebab-case，也是模型用 skill 工具加载时的入参。 */
export const SKILL_NAME = "rtk";

/**
 * systemPrompt 段的段名。与 `SKILL_NAME` 分开：段名是宿主内部的去重键（同一 name 再注册由
 * first-wins 忽略），skill 名是模型加载时的入参，两者将来可能各自改，不该绑在一起。
 */
export const USAGE_SECTION = "rtk-usage";

/**
 * 常驻摘要段的 order：紧跟 grep 工具说明（1500）与三个兄弟插件的规则段
 * （zvec-grep 1550 / ocr-review 1555 / lesson-loop 1560）之后、jobs 工具说明（1600）之前。
 * 取 1565 是因为 1561~1599 之间还没有人占——顺序在这里只影响模型读到的段落先后，
 * 撞车不会报错只会按 name 去重，所以「占一个空档」比「抢一个语义位」更稳妥。
 */
export const USAGE_ORDER = 1565;

/**
 * 注册（或重新注册）本包的使用口径 skill。
 *
 * 文案随调用点传入而不是在这里取：语言由 apply 时的官方 locale 偏好决定，与工具描述、
 * 参数说明、常驻摘要同源——三处各取一次就会出现「摘要中文、skill 正文英文」那种错位。
 * @param ctx - 只需 `get`（读可选服务），不要求 skills 进 inject；带上 `effect` 时注册的
 *   撤销权交给插件 fiber（见 shared 同文件头注释）
 * @param content - 口径全文（`messages.usageText`）
 * @param description - skill 目录里那行说明（模型据此决定要不要加载）
 * @returns 注册成功与否；未装载 skill 服务或正文为空时为 false（不抛，摘要段照旧生效）
 */
export function registerUsageSkill(
  ctx: SkillRegistryContext,
  content: string,
  description: string,
): boolean {
  return registerSkill(ctx, { name: SKILL_NAME, description, content });
}
