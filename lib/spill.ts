/**
 * 压缩前原文的落库（`spillOriginal`），以及压缩正文的尾部落帽。
 *
 * 两件事的失败形态都是「不压 / 不落库」，绝不抛：这一层只负责让上下文小一点，
 * 它坏了不该让命令结果本身出问题。
 *
 * 落帽**不是自造的逻辑**：字节预算 + UTF-8 边界由官方
 * `@deepseek-ai/dsh-output-retention` 的 `TextRetainer` 负责，这里只是把它按
 * 「bash 截断保留尾部」这一档包成单次调用。同一个包 `truncateStart` 用的也是它。
 */
import { TextRetainer } from "@deepseek-ai/dsh-output-retention";
import type { SpillLocator, SpillRef } from "@deepseek-ai/dsh-spill";

/**
 * 压缩后 stdout 的字节上限；超了保留**尾部**（与 bash 的截断语义一致：
 * 失败详情与退出摘要都在尾部）。
 *
 * 逐字节回退与「不切出半个多字节字符」都在 `TextRetainer` 里（含 0 预算、
 * emoji 代理对、中文三字节三档），本函数不重复实现那套宽度表。
 */
export function capCompressed(text: string, cap: number): string {
  const retainer = new TextRetainer({ kind: "tail", maxBytes: cap });
  retainer.push(text);
  return retainer.finish().text;
}

/** 落库结果：宿主 SpillRef 的三个字段，没有别的可取的东西。 */
export interface SpilledOriginal {
  readonly locator: SpillLocator;
  readonly bytes: number;
  readonly retrievalHint: string;
}

/** 落库入参。 */
export interface SpillOriginalOptions {
  readonly spillStore: { saveText: (input: unknown) => Promise<SpillRef> } | undefined;
  readonly owner: string;
  readonly toolName: string;
  readonly callId: string;
  readonly text: string;
}

/**
 * 把压缩前的原文落进宿主的 spill 存储，返回宿主给的 `SpillRef` 三个字段。
 *
 * **不要自己拼取回提示**：`locator` 是 Branded 字符串，官方注释明写「消费方用
 * `retrievalHint` 渲染，不要解析它」。自己拼模板的失败形态很难发现——取回句
 * 看起来正常，但模型照它去读会读不到东西。
 */
export async function spillOriginal(
  options: SpillOriginalOptions,
): Promise<SpilledOriginal | undefined> {
  const { spillStore } = options;
  let spilled: SpilledOriginal | undefined;
  // 这个守卫和下面的 catch 是重复的（缺席时调用会抛 TypeError 并被接住），
  // 留着是因为「没有这个服务」是常态而非异常，不值得每回合走一次抛出路径。
  if (spillStore !== undefined) {
    try {
      const ref = await spillStore.saveText({
        owner: { sessionId: options.owner },
        source: {
          kind: "tool",
          toolName: options.toolName,
          callId: options.callId,
          label: "result",
        },
        suggestedName: `${options.toolName}.txt`,
        content: options.text,
      });
      spilled = { locator: ref.locator, bytes: ref.bytes, retrievalHint: ref.retrievalHint };
    } catch {
      // 没有后端时当作没落库：压缩本身照常生效，只是没有取回通道。
    }
  }
  return spilled;
}
