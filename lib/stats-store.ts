// 旧累计账本的**只读**入口：一次性把宿主 storage domain 里那份 `rtk_stats` 账本读出来，
// 交给 Insights 的迁移逻辑落成快照。
//
// 为什么只剩「读」：Insights 之后统计面就落在插件自己的账本上（`lib/rtk-paths.ts` 定位，
// `lib/insights-store.ts` 在同一个库里写 `dsh_*` 表），旧的单份累计账本不再累加——它只是
// **存量用户的迁移输入**。
// 写面（`accumulate` / `reset` / `flush`）随之删掉：留着一条没人调用的写路径，等于给
// 「哪天有人又往里写」留了后门，而两个账本各记一半比没有更难看懂。
//
// 域声明必须与旧版**逐字一致**（名字、版本、兼容版本）：宿主按名字找落盘文件，换名字就等于
// 换文件、旧数据再也读不到。
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

import { LEGACY_ACCUMULATOR_SCHEMA } from "./legacy-stats.ts";
import type { LegacyAccumulator } from "./legacy-stats.ts";

/** 表的键：旧版只存一份全局账本，键是常量（`'summary'` 满足宿主的 `^[a-z][a-z0-9_]*$`）。 */
export const SUMMARY_KEY = "summary";

/**
 * 旧账本所在的存储域声明（只用于读迁移输入）。
 *
 * `invalidRecords: 'backup-and-skip'` 是刻意的：账本是**派生数据**，一条坏记录不该让整次
 * `open()` 拒绝——那会把读取面整个打掉，而代价只是少一份可迁移的历史计数。
 * 容忍路径需要后端支持 `backupRecord`；只支持单文档布局的后端拿不到这条宽限，仍按宿主的
 * 响亮失败走（这条边界不隐藏，写在这里）。
 */
export const legacyStatsDomain = defineDomain({
  // 逐字沿用旧域名（spec §6 的 `rtk_stats`）：这是持久面的一部分，改它就读不到旧文件。
  name: "rtk_stats",
  // 2 起账本多了 token 两列（旧版 rc.2 那一轮）。
  version: 2,
  /**
   * 存量记录（版本 1）照常读，靠的是 `LEGACY_ACCUMULATOR_SCHEMA` 把 token 两列声明成
   * `.default(0)`——**这两处必须一起改**：只升版本不给 `compatibleVersions` 会让旧账本在
   * `open()` 时被当成版本不符而整份丢弃。
   */
  compatibleVersions: [1],
  invalidRecords: "backup-and-skip",
  tables: { summary: domainTable<"summary", LegacyAccumulator>(LEGACY_ACCUMULATOR_SCHEMA) },
});

/** 这份账本需要的**最小**存储面：一张表的 get。真身是 `domain.table('summary')`。 */
export interface LegacyStatsTable {
  readonly get: (key: typeof SUMMARY_KEY) => LegacyAccumulator | undefined;
}

/** 本层用到的**域句柄**的最小面：`table()` 与 `close()`。 */
export interface LegacyStatsDomain {
  readonly table: (name: typeof SUMMARY_KEY) => LegacyStatsTable;
  readonly close: () => Promise<void>;
}

/** 本层用到的**存储设施**的最小面：拿一份域声明换一个域句柄。 */
export interface LegacyStatsFacility {
  readonly open: (spec: typeof legacyStatsDomain) => Promise<LegacyStatsDomain>;
}

/** `loadLegacyAccumulator` 的宿主面：只用到 `get`（服务缺席 = 这个部署没有 storage domain）。 */
export interface LegacyStatsHost {
  readonly get?: ((name: string) => unknown) | undefined;
}

/** 结构判定：`open` 可调用。不用 `as`——断言会把这个边界变成「相信调用方」。 */
function isFacility(value: unknown): value is LegacyStatsFacility {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "open") === "function"
  );
}

/**
 * 读出旧累计账本；没有（服务缺席 / 从没写过 / 打不开）就给 `null`。
 *
 * 三种「没有」在迁移上是同一件事（不迁移），所以合并成一个返回值；区别只在调用方怎么记账
 * ——`lib/insights-sink.ts` 会把 `open()` 抛出的异常交给 warn，而服务缺席是静默的
 * （这个部署本来就没有存储面，不是故障）。
 *
 * 谁 open 谁 close：读完就地关掉。同名域重复 open 会抛 `already-open`，而这份账本此后
 * 不再被任何人使用，所以关得越早越好（否则它会一直占着名字到进程结束）。
 *
 * `close()` 放在 `finally` 里：读表本身抛错（后端坏了）时也要把名字还回去，否则下一次
 * 装配就是一条与真实故障无关的 `already-open`。
 */
export async function loadLegacyAccumulator(
  host: LegacyStatsHost,
): Promise<LegacyAccumulator | null> {
  const facility = typeof host.get === "function" ? host.get("storageDomain") : undefined;
  if (!isFacility(facility)) {
    return null;
  }
  const domain = await facility.open(legacyStatsDomain);
  try {
    return domain.table(SUMMARY_KEY).get(SUMMARY_KEY) ?? null;
  } finally {
    // `close()` 自己失败**不能盖掉**读表抛出的那个错：原始异常说明的是真正的问题（后端坏了），
    // 而「名字没还回去」只是它的副作用。第一版把 `await domain.close()` 裸放在 finally 里，
    // 于是读表炸了之后调用方看到的是 `close` 的错误，根本原因就此丢失。
    try {
      await domain.close();
    } catch {
      // 还名字失败：这条路径本来就要退场，多说一层只会埋掉真正的成因。
    }
  }
}
