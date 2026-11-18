// 统计面剩下的两份**共用形状**：线上命名空间与运行时状态。
//
// 这个文件曾经装着旧累计账本的落盘形状（`statsAccumulatorSchema`）与它的投影
// （`statsSummarySchema` / `summarize` / `TOP_FILTERS`）。Insights 上线之后那两套被
// **插件自己的账本 + 同库里的 `dsh_*` 表**取代（`lib/rtk-ledger.ts` 读 rtk 那五张表、
// `lib/insights-store.ts` 写自己的表，经 `lib/insights-service.ts` 汇总），旧形状只剩「迁移输入」这一种用途，因此搬去了
// `lib/legacy-stats.ts`——那份一经写出就不跟着新统计面演进，下一次改形状不会连带改掉迁移语义。
import { z } from "zod";

/** 设置卡命名空间（camelCase，与 `id: rtk` 不同源）：`/api/rtkStats/<method>`。 */
export const RTK_STATS_NAMESPACE = "rtkStats";

/**
 * 卡片顶部那行运行时状态。放在本文件而不是 `lib/stats-remote.ts`：客户端读面要按它
 * `safeParse` 线上回执（读到坏形状时点名报错，而不是硬转一份 `as`），而宿主侧的
 * `StatsStatus` 就是同一个形状 —— 一份 schema 两处消费，改形状只改这一处。
 */
export const statsStatusSchema = z.object({
  rtkPath: z.string().nullable(),
  rtkVersion: z.string().nullable(),
  /**
   * 探到的版本够不够新：`null` = 根本没探到（二进制不在 / 超时 / 非零退出），
   * `false` = 读到了但低于下限。两者在卡片上是两句不同的话（装 vs 升级），
   * 而 `rtkVersion === null` 分不开它们——探测失败也交 `null`。
   */
  supported: z.boolean().nullable(),
  enabled: z.boolean(),
  forms: z.array(z.string()),
});
export type StatsStatus = z.infer<typeof statsStatusSchema>;
