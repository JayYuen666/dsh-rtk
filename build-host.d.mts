// 本包私有构建脚本的类型面：只声明测试会 import 的那两个导出，不描述内部实现。
export function buildHost(): Promise<string>;
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
