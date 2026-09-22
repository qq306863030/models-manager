/**
 * sessionDisplay.ts
 *
 * PC 端与移动端会话列表展示逻辑的唯一来源。
 * 历史上两端各自实现过一套（PC 显示“最后一条消息摘要”，移动端显示“时间 · 条数”），
 * 导致同一份数据在两端看起来完全不一样；统一收敛到这里，避免再次分叉。
 */

/** 展示层所需的最小消息结构（避免与 useChatStore 形成运行时循环依赖） */
export interface ISessionDisplayMessage {
  content?: string | null;
  attachments?: Array<{ name?: string | null }> | null;
}

/** 展示层所需的最小会话结构 */
export interface ISessionDisplaySource {
  title?: string | null;
  messages?: ISessionDisplayMessage[] | null;
}

/** 会话标题：空标题统一兜底为“新对话” */
export function getSessionDisplayTitle(session: ISessionDisplaySource): string {
  const title = (session.title || '').trim();
  return title || '新对话';
}

/** 会话副标题：最后一条消息内容（无消息返回“暂无消息”，仅附件时显示附件名） */
export function getLastMessageSnippet(session: ISessionDisplaySource): string {
  const messages = session.messages || [];
  if (messages.length === 0) return '暂无消息';

  const last = messages[messages.length - 1];
  if (last.content) return last.content;

  const attachmentName = last.attachments?.[0]?.name;
  return attachmentName ? `[附件: ${attachmentName}]` : '...';
}

/** 会话搜索匹配：标题或任意消息内容命中关键字（空关键字视为全部匹配） */
export function matchSessionKeyword(session: ISessionDisplaySource, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  if (session.title && session.title.toLowerCase().includes(kw)) return true;
  return (session.messages || []).some((m) => !!m.content && m.content.toLowerCase().includes(kw));
}
