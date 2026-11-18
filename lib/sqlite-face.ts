/**
 * `node:sqlite` 的最小结构投影（两个 store 共用）。
 *
 * **为什么不直接引真实类型**：`DatabaseSync` 把参数钉成 `SQLInputValue`、返回钉成
 * `Record<string, SQLOutputValue>`，而这一层只做「我准备好的值透传下去、读回来的行按我声明的
 * 形状用」。直接引真实类型会让每一处调用都要再收窄一次，于是满屏 `as`——那正是
 * `typescript/no-unsafe-type-assertion` 要拦的形态。
 *
 * **参数为什么是 `SqliteValue` 而不是 `unknown`**：`unknown` 看起来更宽松，实际更窄——函数
 * 参数是**逆变**的（strictFunctionTypes），要让真实 `run(...SQLInputValue[])` 能赋给这一面，
 * 就得让 `SQLInputValue` 能赋给声明的参数类型；`unknown` 只在「什么都能赋给它」方向成立，
 * 反向不成立，赋值当场报 TS2322。写成与真实类型等价的联合就两边都成立，探针实测通过。
 *
 * **为什么用属性签名而不是方法语法**：`typescript/method-signature-style` 要求属性签名，而
 * 属性签名是严格逆变的——这正是上面那条参数类型必须写实的原因。原来的方法语法能过类型检查
 * 只是因为它双变，把 `unknown` 的错误盖住了；换成属性签名 + 具体类型，既过 lint 又不靠双变。
 *
 * **为什么 get/all 带类型参数**：`db.prepare(sql).all<LedgerDayRow>(start)` 让行类型在调用点
 * 声明，读面就没有断言；不带类型参数时落回 `Record<string, unknown>`。`no-unnecessary-type-
 * parameters` 会说「只用一次」，但那一次正是调用点的读面形状——去掉它就只能让每个调用自己
 * `as`，是拿断言换 lint 干净。这里按后者的代价更大处理。
 */

/** 能绑进 SQL 的值（与 `node:sqlite` 的 `SQLInputValue` 等价，不用它的名字是为了不引类型）。 */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/** 一条预编译语句。 */
export interface StatementFace {
  run: (...params: SqliteValue[]) => unknown;
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- 行类型由调用点声明，去掉就只剩调用处的 as
  get: <Row = Record<string, unknown>>(...params: SqliteValue[]) => Row | undefined;
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- 同上
  all: <Row = Record<string, unknown>>(...params: SqliteValue[]) => readonly Row[];
}

/** 一个打开的库。只列出本插件用到的三样。 */
export interface DatabaseFace {
  prepare: (sql: string) => StatementFace;
  exec: (sql: string) => void;
  close: () => void;
}

/** 模块面：只用 `DatabaseSync`。 */
export interface SqliteModule {
  readonly DatabaseSync: new (
    path: string,
    options?: { readonly readOnly?: boolean; readonly timeout?: number },
  ) => DatabaseFace;
}

/** 加载器（单测注入桩用；生产用默认值）。 */
export type ImportSqlite = () => Promise<SqliteModule>;

/** 打开库。失败直接抛给调用方——两个 store 都按 fail-open 处置，判读在各自那层。 */
export async function openSqlite(
  path: string,
  options?: { readonly readOnly?: boolean; readonly timeout?: number },
  importSqlite: ImportSqlite = () => import("node:sqlite"),
): Promise<DatabaseFace> {
  const { DatabaseSync } = await importSqlite();
  // 不能统一写成 `new DatabaseSync(path, options)`：`node:sqlite` 对**显式** `undefined`
  // 报 `The "options" argument must be an object.`，省略才走默认值（实测 v26.13.1）。
  return options === undefined ? new DatabaseSync(path) : new DatabaseSync(path, options);
}

/**
 * 关库，忽略失败。
 *
 * 关不掉只影响本进程的句柄，与「刚刚读到了什么」无关；把它的异常往上抛只会盖掉真正的判读
 * （`readPrefixLedger` 用它包在 finally 里：读失败的那条路径不该被关闭失败改写）。
 */
export function closeQuietly(db: DatabaseFace | undefined): void {
  try {
    db?.close();
  } catch {
    // 刻意吞掉：句柄泄漏比误判「库读坏了」更可接受，且下一次 open 会重建。
  }
}

/**
 * 从任意 catch 到的值里取一个字符串字段。
 *
 * SQLite 的错误码在 `error.code`、消息在 `error.message`，但 `catch` 拿到的是 `unknown`；
 * 结构判定之后取值，就不必写 `(error as ErrnoException).code` 这种把断言当窄化的写法。
 * @param error - catch 到的值
 * @param key - 字段名
 * @returns 字段值；不是字符串时给空串
 */
export function errorFieldOf(error: unknown, key: string): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" ? value : "";
}
