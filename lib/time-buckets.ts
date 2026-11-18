/**
 * 本地时间的日 / 周 / 月桶。
 *
 * 为什么不用 UTC：用户看的是「今天省了多少」，而「今天」是这个人在他自己的时区里过的今天。
 * 落盘的时间戳是 UTC（rtk 账本用 `to_rfc3339`），聚合时再按本地时间折桶——反过来做会把
 * 跨零点的数据分到两天去，而界面上没有任何线索能解释为什么。
 *
 * 键一律是 `YYYY-MM-DD` 形态的字符串：可以直接比较大小（字典序等于时间序），可以直接
 * 给 SQLite 当 GROUP BY 的列，也可以在客户端原样做横轴刻度，不需要再解析成 Date。
 */

/** 一周的天数；`(getDay()+6)%7` 里的 7 也是它。 */
const WEEK_DAYS = 7;

/**
 * 时间戳落在本地哪一天。
 * @param ts - 毫秒时间戳
 * @returns `YYYY-MM-DD`（本地时区）
 */
export function localDayKey(ts: number): string {
  const date = new Date(ts);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * `YYYY-MM-DD` 的本地零点。
 *
 * 用 `new Date(y, m, d)` 而不是 `new Date("YYYY-MM-DD")`：后者按 **UTC** 解析，
 * 在东八区会把每天的边界整体挪 8 小时。
 *
 * 定宽切片而不是 `split("-")` 取三段：这个函数只吃 `localDayKey` 的产物（永远是 `YYYY-MM-DD`），
 * 而按下标取会让每一段都带 `undefined`（`noUncheckedIndexedAccess`），于是得给三段各配一个
 * `?? 默认值`——那三个分支在真实输入下永远走不到，只会顶穿覆盖率门。切片 + `Number` 没有分支，
 * 契约写成定宽也就不必假装支持别的形状。
 * @param day - `YYYY-MM-DD`
 * @returns 本地零点
 */
function dayStart(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/**
 * 这一天所在周的周一。
 *
 * 以周一为首（ISO 口径）：周报的读者按工作周看数据，把周日算进上一周会让「本周」在周一早上
 * 突然缩水一天。
 *
 * 位移用 `setDate` 而不是减毫秒：夏令时那天不是 24 小时，减 `n * 86400000` 会落到前一天
 * 23 点或后一天 1 点，日期就错了。
 * @param day - `YYYY-MM-DD`
 * @returns 该周周一的 `YYYY-MM-DD`
 */
export function localWeekKey(day: string): string {
  const date = dayStart(day);
  date.setDate(date.getDate() - ((date.getDay() + WEEK_DAYS - 1) % WEEK_DAYS));
  return localDayKey(date.getTime());
}

/**
 * 这一天所在月份。
 * @param day - `YYYY-MM-DD`
 * @returns `YYYY-MM`
 */
export function localMonthKey(day: string): string {
  return day.slice(0, 7);
}

/**
 * 统计窗口的起点日（含）：从 `now` 当天算起往前 `rangeDays` 天。
 *
 * 口径是「含今天」，所以 7 天窗口 = 今天 + 前 6 天。写作 `rangeDays - 1` 而不是在调用方
 * 各自减一：窗口长度与起点是同一条口径，分开放一定会有一处忘了减。
 * @param rangeDays - 窗口天数（7 / 30 / 90）
 * @param now - 毫秒时间戳
 * @returns 起点 `YYYY-MM-DD`
 */
export function windowStartDay(rangeDays: 7 | 30 | 90, now: number): string {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (rangeDays - 1));
  return localDayKey(date.getTime());
}
