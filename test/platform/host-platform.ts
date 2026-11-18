// test/platform/host-platform.ts —— 让「只在受支持平台上存在」的那几层，在 win32 runner 上也能跑。
//
// 背景（这一格是 CI 全红之后补的）：C 形态的装配期门禁第一条就是 `prefixSupportedOn(platform)`，
// 而它对 win32 判否——**那是产品的设计决定**（rtk 的 Windows 分发面与 pwsh 命令形态都没在
// 真机验过，前缀形态写坏命令的代价是「本来能跑的命令不能跑」）。所以 windows CI 上那几十条
// C 形态用例原先被 `describe.skipIf(!POSIX_ONLY)` 整片跳过，等于「Windows 上从来没测过改写
// 与埋点」。
//
// 跳过是不该留的：那批用例验的是**逻辑**（装配序、埋点时机、argv 形状、sandbox 登记），
// 与宿主是不是 Windows 无关；被平台门禁挡住只是因为它读的是 `process.platform`。这里把那
// 一位换掉，让同一份逻辑在三个 runner 上都跑起来。平台门禁**本身**由
// `test/platform/platform.test.ts` 断言（那里显式注入 win32 验「整层不装」），两条判据互不
// 顶替。
//
// 为什么不给 `plugin.apply` 加一个 `platform` 形参：那会为了测试给生产入口开一个谁都可能
// 误传的洞（真实装配里它必须永远是宿主平台）。`process.platform` 是 `configurable` 的，
// 测试里改它、`finally` 还回去，影响面只在这一个测试进程（vitest 默认按文件隔离），比在
// 生产签名上留一个参数更划算。
//
// **边界写清楚**：这里换的只有 `process.platform` 这一位。`node:path` 的默认实现是在模块
// 加载时按真平台选定的，不会跟着变（`path.sep` 仍是 `/`、`path.delimiter` 仍是 `:`）——
// 这正好是我们要的：路径分隔符必须用宿主的，否则夹具造出来的路径在本机都打不开。

/** 本仓「C 形态有实现」的平台档：非 win32 一律支持（与 `prefixSupportedOn` 同口径）。 */
export const SHADOW_PLATFORM: NodeJS.Platform =
  process.platform === "win32" ? "linux" : process.platform;

/**
 * 把 `process.platform` 换成受支持的那一档；返回还原函数。
 *
 * 只在宿主是 win32 时才动它——POSIX runner 上这是一次恒等调用。别让「本来就不用改」的地方
 * 也去写一遍 `process.platform`，那会让「谁改过平台值」变得难查。
 */
export function forceShadowPlatform(): () => void {
  if (process.platform !== "win32") {
    return (): void => {
      /* 宿主本来就是受支持档，没什么可还原的。 */
    };
  }
  Object.defineProperty(process, "platform", { value: SHADOW_PLATFORM, configurable: true });
  return (): void => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  };
}
