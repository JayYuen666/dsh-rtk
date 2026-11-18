// 旧账本（宿主 storage domain 里那份累计统计）的形状，只用于一次性迁移。
//
// 为什么单独一份而不是继续从 `lib/stats-shape.ts` 引：迁移要读的是**旧的落盘形状**
// （域版本 1/2），而 `stats-shape.ts` 会随着新统计面继续演进——把它当迁移的输入类型，
// 下一次改形状就等于改迁移的语义。这里的三个名字（`LEGACY_ACCUMULATOR_SCHEMA` /
// `LegacyAccumulator` / `EMPTY_LEGACY_ACCUMULATOR`）一经写出就不再跟着旧文件变，
// 旧文件（`lib/stats-shape.ts`）随后可以整体删掉。
import { z } from "zod";

/** 单个 filter 的分项（旧形状：字节与 token 并存，token 是后加的两列）。 */
const legacyFilterSchema = z.object({
  commands: z.int().nonnegative(),
  savedBytes: z.int(),
  savedTokens: z.int().nonnegative().default(0),
});

/**
 * 旧累计账本的落盘形状。
 *
 * `originalTokens` / `compressedTokens` 的 `.default(0)` 是**迁移通道**：域版本 1 写下的
 * 记录里没有这两列，缺键读成 0 之后的含义是「这一份没量过 token」，迁移时退回字节口径。
 */
export const LEGACY_ACCUMULATOR_SCHEMA = z.object({
  commands: z.int().nonnegative(),
  originalBytes: z.int().nonnegative(),
  compressedBytes: z.int().nonnegative(),
  originalTokens: z.int().nonnegative().default(0),
  compressedTokens: z.int().nonnegative().default(0),
  byFilter: z.record(z.string(), legacyFilterSchema),
  byForm: z.object({
    prefix: z.int().nonnegative(),
    pipe: z.int().nonnegative(),
  }),
});
export type LegacyAccumulator = z.infer<typeof LEGACY_ACCUMULATOR_SCHEMA>;

/** 空旧账本：什么都没迁移到时的落点。 */
export const EMPTY_LEGACY_ACCUMULATOR: LegacyAccumulator = {
  commands: 0,
  originalBytes: 0,
  compressedBytes: 0,
  originalTokens: 0,
  compressedTokens: 0,
  byFilter: {},
  byForm: { prefix: 0, pipe: 0 },
};
