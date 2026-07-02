/**
 * Thinking 标签解析器
 * 
 * 处理 <thinking>...</thinking> 和 <think>...</think> 标签，
 * 支持跨 chunk 边界的情况。
 */

// 支持的标签对
const OPEN_TAGS: [string, string][] = [
  ['<think>', '</think>'],        // OpenAI/CoT 格式
  ['<thinking>', '</thinking>'],  // DeepSeek 格式
];

// 孤立的关闭标签（可能出现在某些 provider 的 content 中）
const STRAY_CLOSE_TAGS: string[] = ['</thinking>', '</think>'];

// Thinking 块类型
export type ThinkingChunkType = 'T' | 'E' | 't';
export interface ThinkingChunk {
  t: ThinkingChunkType;  // 'T' = thinking 内容, 'E' = end, 't' = 普通文本
  c: string;
}

export class ThinkingParser {
  private buf = '';
  private inThink = false;
  private closeTag = '';

  /**
   * 处理一个 chunk，返回解析后的块
   */
  process(chunk: string): ThinkingChunk[] {
    if (!chunk) return [];

    const results: ThinkingChunk[] = [];
    this.buf += chunk;

    while (this.buf.length > 0) {
      if (this.inThink) {
        // 在 thinking 标签内部
        const chunks = this._processInsideThink(results);
        if (chunks === null) break; // 需要更多数据
      } else {
        // 在 thinking 标签外部
        const found = this._processOutsideThink(results);
        if (!found) break; // 需要更多数据
      }
    }

    return results;
  }

  /**
   * 流结束时刷新缓冲区
   */
  flush(): ThinkingChunk[] {
    const results: ThinkingChunk[] = [];

    if (this.inThink && this.buf.length > 0) {
      // 输出 thinking 内容
      results.push({ t: 'T', c: this.buf });
      this.buf = '';
    } else if (this.buf.length > 0) {
      // 输出剩余的普通文本
      results.push({ t: 't', c: this.buf });
      this.buf = '';
    }

    if (this.inThink) {
      results.push({ t: 'E', c: '' }); // 标记 thinking 结束
      this.inThink = false;
      this.closeTag = '';
    }

    return results;
  }

  /**
   * 处理在 thinking 标签内部的内容
   */
  private _processInsideThink(results: ThinkingChunk[]): boolean | null {
    // 查找关闭标签
    const idx = this.buf.indexOf(this.closeTag);
    if (idx < 0) {
      // 没有找到关闭标签，检查是否有部分关闭标签
      const partialCloseLen = this._partialSuffixLen(this.closeTag);
      if (partialCloseLen > 0) {
        // 保存部分关闭标签，输出前面的内容
        const outputLen = this.buf.length - partialCloseLen;
        if (outputLen > 0) {
          results.push({ t: 'T', c: this.buf.slice(0, outputLen) });
        }
        this.buf = this.buf.slice(outputLen);
        return true;
      }
      // 没有部分关闭标签，输出所有内容并等待更多数据
      results.push({ t: 'T', c: this.buf });
      this.buf = '';
      return null;
    }

    // 找到关闭标签，输出 thinking 内容
    if (idx > 0) {
      results.push({ t: 'T', c: this.buf.slice(0, idx) });
    }
    this.buf = this.buf.slice(idx + this.closeTag.length);
    results.push({ t: 'E', c: '' }); // 标记 thinking 结束

    this.inThink = false;
    this.closeTag = '';
    return true;
  }

  /**
   * 处理在 thinking 标签外部的内容
   */
  private _processOutsideThink(results: ThinkingChunk[]): boolean {
    // 检查孤立关闭标签（某些 provider 可能在 content 中残留 ）
    for (const ct of STRAY_CLOSE_TAGS) {
      const i = this.buf.indexOf(ct);
      if (i >= 0) {
        // 输出标签前的文本（如果有的话）
        if (i > 0) {
          results.push({ t: 't', c: this.buf.slice(0, i) });
        }
        // 丢弃孤立关闭标签
        this.buf = this.buf.slice(i + ct.length);
        return true; // 继续处理
      }
    }

    // 查找最近的开始标签
    let best = -1;
    let bestClose = '';
    for (const [ot, ct] of OPEN_TAGS) {
      const i = this.buf.indexOf(ot);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        bestClose = ct;
      }
    }

    if (best >= 0) {
      // 找到开始标签
      if (best > 0) {
        // 输出标签前的文本
        results.push({ t: 't', c: this.buf.slice(0, best) });
      }
      this.buf = this.buf.slice(best);
      this.inThink = true;
      this.closeTag = bestClose;
      return true;
    }

    // 没有找到任何标签，检查是否有部分开始标签
    const partialOpenLen = this._partialOpenTagSuffixLen();
    if (partialOpenLen > 0) {
      // 保存部分开始标签，输出前面的内容
      const outputLen = this.buf.length - partialOpenLen;
      if (outputLen > 0) {
        results.push({ t: 't', c: this.buf.slice(0, outputLen) });
      }
      this.buf = this.buf.slice(outputLen);
      return true;
    }

    // 没有部分标签，输出所有内容并等待更多数据
    results.push({ t: 't', c: this.buf });
    this.buf = '';
    return true;
  }

  /**
   * 检查缓冲区尾部是否包含关闭标签的部分
   */
  private _partialSuffixLen(tag: string): number {
    for (let i = tag.length - 1; i > 0; i--) {
      if (this.buf.endsWith(tag.slice(0, i))) {
        return i;
      }
    }
    return 0;
  }

  /**
   * 检查缓冲区尾部是否包含任何开始标签的部分
   */
  private _partialOpenTagSuffixLen(): number {
    let hold = 0;
    for (const [ot] of OPEN_TAGS) {
      for (let i = ot.length - 1; i > 0; i--) {
        if (this.buf.endsWith(ot.slice(0, i)) && i > hold) {
          hold = i;
          break;
        }
      }
    }
    return hold;
  }
}

/**
 * 从文本中移除所有 thinking 标签及其内容
 * 用于非流式响应的处理
 */
export function stripThinkingTags(text: string): string {
  let result = text;
  
  for (const [ot, ct] of OPEN_TAGS) {
    // 使用正则表达式移除 thinking 块
    const regex = new RegExp(escapeRegex(ot) + '[\\s\\S]*?' + escapeRegex(ct), 'g');
    result = result.replace(regex, '');
  }
  
  // 同时处理孤立的关闭标签（清理残留）
  for (const ct of STRAY_CLOSE_TAGS) {
    const closeRegex = new RegExp(escapeRegex(ct), 'g');
    result = result.replace(closeRegex, '');
  }
  
  return result.trim();
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检测文本中是否包含 thinking 内容
 */
export function hasThinkingContent(text: string): boolean {
  for (const [ot, ct] of OPEN_TAGS) {
    if (text.includes(ot) && text.includes(ct)) {
      return true;
    }
  }
  return false;
}