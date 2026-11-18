// 本包私有构建脚本的类型面：只声明测试会 import 的那两个导出，不描述内部实现。
// `buildClientFiles()` 返回的是产物清单（入口在前），所以 `ClientArtifact` 也从 shared
// 转出——两处必须同源，否则测试拿到的是另一份结构。
import type { ClientArtifact } from "@jayyuen66/dsh-plugin-shared/lib/build-client";

export function buildClient(): Promise<string>;
export function buildClientFiles(): Promise<readonly ClientArtifact[]>;
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
