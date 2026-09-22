/**
 * useChatStore.ts
 *
 * 负责 AI 聊天页面的多会话状态、当前活跃会话、消息收发与 AgentLoop 编排调度，
 * 以及会话持久化与可用模型加载（严格过滤 isDisable === true）。
 *
 * 持久化策略（跨端一致）：
 * 1. 服务端 `chat_sessions` 表为唯一数据源，PC 端与移动端登录同一账号即可看到同一批会话；
 * 2. localStorage 仅作为离线缓存与首屏秒开的降级手段；
 * 3. 首次打开时若服务端为空而本地有历史会话，自动迁移上云；两端都有时按 updatedAt 取新者。
 */

import { ref, computed, watch } from 'vue';
import { getModels, type Model } from '../../../api/modelService';
import {
  getChatSessions,
  saveChatSessions,
  deleteChatSession,
  clearChatSessions,
  type ChatSessionPayload,
} from '../../../api/chatSessionService';
import AgentLoop, { type IToolCallView } from '../core/AgentLoop';
import type { ILlmMessage } from '../core/LlmClient';
import { generateUUID } from '../../../utils/uuid';

export interface IAttachmentView {
  id: string;
  name: string;
  size: number;
  type: 'image' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'file';
  url?: string;            // 图片预览 Base64 或地址
  extractedText?: string;  // 解析提取出的 Markdown 纯文本
  serverFilePath?: string; // 服务器暂存的真实物理路径（供转换工具作为 inputPath 输入）
}

export interface IChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  attachments?: IAttachmentView[];
  toolCalls?: IToolCallView[];
  createdAt: number;
  error?: string | null;
}

export interface IChatSession {
  id: string;
  title: string;
  modelName: string;
  createdAt: number;
  updatedAt: number;
  messages: IChatMessage[];
}

const STORAGE_KEY = 'mm_ai_chat_sessions_v1';
const LAST_ACTIVE_SESSION_KEY = 'mm_ai_chat_active_session_id';

/** 服务端同步节流间隔（毫秒）：流式输出期间避免逐 token 写库 */
const SERVER_FLUSH_INTERVAL = 1500;
/** 本地缓存写入节流间隔（毫秒） */
const LOCAL_CACHE_INTERVAL = 800;

// 全局响应式状态
const sessions = ref<IChatSession[]>([]);
const currentSessionId = ref<string>('');
const isStreaming = ref<boolean>(false);
const isSyncing = ref<boolean>(false);
const availableModels = ref<Model[]>([]);
const isModelsLoading = ref<boolean>(false);

// ===== 同步调度内部状态（模块级单例，PC 与移动端共用同一份逻辑） =====
let isInitialized = false;
let pendingFlushPromise: Promise<void> | null = null;
let serverFlushTimer: ReturnType<typeof setTimeout> | null = null;
let localCacheTimer: ReturnType<typeof setTimeout> | null = null;
let lastServerFlush = 0;
let lastLocalCache = 0;
const dirtySessionIds = new Set<string>();

/** 归一化服务端/本地缓存中读取到的会话，脏数据直接丢弃 */
function normalizeSession(raw: any): IChatSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : '新对话',
    modelName: typeof raw.modelName === 'string' ? raw.modelName : '',
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
  };
}

/** 会话 → 服务端同步载荷 */
function toPayload(session: IChatSession): ChatSessionPayload {
  return {
    id: session.id,
    title: session.title,
    modelName: session.modelName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages as ChatSessionPayload['messages'],
  };
}

// ==================== 本地缓存（离线降级用，不下发网络） ====================

/** 读取本地缓存的会话列表 */
function readLocalCache(): IChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeSession(item))
      .filter((s): s is IChatSession => !!s);
  } catch (e) {
    console.warn('[useChatStore] 读取本地会话缓存失败:', e);
    return [];
  }
}

/** 立即写入本地缓存 */
function writeLocalCache(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.value));
    if (currentSessionId.value) {
      localStorage.setItem(LAST_ACTIVE_SESSION_KEY, currentSessionId.value);
    }
  } catch (e) {
    console.warn('[useChatStore] 写入本地会话缓存失败:', e);
  }
}

/** 节流写入本地缓存，避免流式输出时逐 token 序列化全量会话 */
function scheduleLocalCache(immediate = false): void {
  if (immediate) {
    if (localCacheTimer) {
      clearTimeout(localCacheTimer);
      localCacheTimer = null;
    }
    lastLocalCache = Date.now();
    writeLocalCache();
    return;
  }
  if (localCacheTimer) return;
  const wait = Math.max(0, LOCAL_CACHE_INTERVAL - (Date.now() - lastLocalCache));
  localCacheTimer = setTimeout(() => {
    localCacheTimer = null;
    lastLocalCache = Date.now();
    writeLocalCache();
  }, wait);
}

export function useChatStore() {
  const agentLoop = AgentLoop.getInstance();

  /**
   * 加载模型列表，过滤掉 isDisable 的模型
   */
  async function loadModels(): Promise<void> {
    isModelsLoading.value = true;
    try {
      const res = await getModels();
      if (res && res.data) {
        // 过滤已禁用的模型
        availableModels.value = res.data.filter((m) => !m.isDisable);
      }
    } catch (err) {
      console.error('[useChatStore] 加载模型列表失败:', err);
    } finally {
      isModelsLoading.value = false;
    }
  }

  // ==================== 服务端同步（跨端一致的关键） ====================

  /** 标记会话为待同步，并调度一次节流的批量提交 */
  function markSessionDirty(id: string): void {
    if (!id) return;
    dirtySessionIds.add(id);
    scheduleServerFlush();
  }

  /** 调度服务端同步：强制间隔 SERVER_FLUSH_INTERVAL，天然去抖 */
  function scheduleServerFlush(immediate = false): void {
    if (immediate) {
      if (serverFlushTimer) {
        clearTimeout(serverFlushTimer);
        serverFlushTimer = null;
      }
      void flushDirtySessions();
      return;
    }
    if (serverFlushTimer || dirtySessionIds.size === 0) return;
    const wait = Math.max(0, SERVER_FLUSH_INTERVAL - (Date.now() - lastServerFlush));
    serverFlushTimer = setTimeout(() => {
      serverFlushTimer = null;
      void flushDirtySessions();
    }, wait);
  }

  /** 把标记为脏的会话批量提交到服务端（同一时刻只允许一次在途提交） */
  function flushDirtySessions(): Promise<void> {
    // 已有提交在途：复用同一个 Promise，其收尾逻辑会接力处理期间新产生的脏数据
    if (pendingFlushPromise) return pendingFlushPromise;

    const task = (async () => {
      const ids = Array.from(dirtySessionIds);
      dirtySessionIds.clear();
      lastServerFlush = Date.now();
      let succeeded = true;

      try {
        const payloads = ids
          .map((id) => sessions.value.find((s) => s.id === id))
          .filter((s): s is IChatSession => !!s)
          .map(toPayload);
        if (payloads.length > 0) {
          await saveChatSessions(payloads);
        }
      } catch (e) {
        // 同步失败：恢复脏标记，等下一次变更或显式 flush 时重试（不重排定时器，避免服务不可用时死循环）
        succeeded = false;
        ids.forEach((id) => dirtySessionIds.add(id));
        console.warn('[useChatStore] 会话同步到服务端失败，稍后重试:', e);
      }

      // 本次提交期间又产生了新的脏数据：节流接力再提交一次
      if (succeeded && dirtySessionIds.size > 0 && !serverFlushTimer) {
        scheduleServerFlush();
      }
    })();

    // tracked 的 finally 先于其结算执行，因此 await 它的调用方恢复时 pendingFlushPromise 已释放
    const tracked = task.finally(() => {
      pendingFlushPromise = null;
    });
    pendingFlushPromise = tracked;
    return tracked;
  }

  /** 恢复上次活跃会话（仅本机记录，互不干扰各端当前打开的会话） */
  function restoreActiveSession(list: IChatSession[]): void {
    if (list.length === 0) return;
    const lastId = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    if (lastId && list.some((s) => s.id === lastId)) {
      currentSessionId.value = lastId;
      return;
    }
    if (!list.some((s) => s.id === currentSessionId.value)) {
      currentSessionId.value = list[0].id;
    }
  }

  /**
   * 初始化会话数据：
   * 先用本地缓存秒开，再与服务端对齐（迁移本地独有会话 + 合并两端更新）
   */
  async function initSessions(): Promise<void> {
    if (isInitialized) return;
    isInitialized = true;

    const localSessions = readLocalCache();
    sessions.value = localSessions;
    restoreActiveSession(localSessions);

    isSyncing.value = true;
    try {
      const res = await getChatSessions();
      const remote = (res?.data || [])
        .map((item) => normalizeSession(item))
        .filter((s): s is IChatSession => !!s);

      const remoteMap = new Map(remote.map((s) => [s.id, s]));

      // 服务端没有的 / 本地更新时间更晚的，都需要回推服务端
      const needPush = localSessions.filter((s) => {
        const remoteItem = remoteMap.get(s.id);
        if (!remoteItem) return true;
        return (s.updatedAt || 0) > (remoteItem.updatedAt || 0);
      });

      if (needPush.length > 0) {
        try {
          await saveChatSessions(needPush.map(toPayload));
        } catch (e) {
          console.warn('[useChatStore] 本地会话迁移到服务端失败，保留本地副本:', e);
        }
      }

      // 合并：以服务端为准，但本地更新时间更晚（已回推）的会话用本地版本
      const pushedIds = new Set(needPush.map((s) => s.id));
      const mergedMap = new Map<string, IChatSession>();
      remote.forEach((s) => mergedMap.set(s.id, s));
      localSessions.forEach((s) => {
        if (!mergedMap.has(s.id) || pushedIds.has(s.id)) {
          mergedMap.set(s.id, s);
        }
      });

      const merged = Array.from(mergedMap.values()).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      sessions.value = merged;
      restoreActiveSession(merged);
      if (merged.length === 0) {
        createNewSession();
      }
    } catch (e) {
      console.warn('[useChatStore] 服务端会话加载失败，降级使用本地缓存:', e);
      if (sessions.value.length === 0) {
        createNewSession();
      }
    } finally {
      isSyncing.value = false;
      scheduleLocalCache(true);
    }
  }

  // 深度监听会话变化：节流写入本地缓存（服务端由 dirty 标记驱动）
  watch(
    sessions,
    () => {
      scheduleLocalCache();
    },
    { deep: true }
  );

  // 监听当前会话切换
  watch(currentSessionId, (newId) => {
    if (newId) {
      try {
        localStorage.setItem(LAST_ACTIVE_SESSION_KEY, newId);
      } catch (e) {
        // 忽略隐私模式下的写入失败
      }
    }
  });

  const currentSession = computed<IChatSession | undefined>(() => {
    return sessions.value.find((s) => s.id === currentSessionId.value);
  });

  /**
   * 新建会话
   */
  function createNewSession(targetModelName?: string): string {
    const defaultModel =
      targetModelName ||
      (availableModels.value.length > 0 ? availableModels.value[0].name : '');

    const newId = generateUUID();
    const newSession: IChatSession = {
      id: newId,
      title: '新对话',
      modelName: defaultModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };

    sessions.value.unshift(newSession);
    currentSessionId.value = newId;
    markSessionDirty(newId);
    scheduleLocalCache(true);
    return newId;
  }

  /**
   * 切换会话
   */
  function switchSession(id: string): void {
    if (currentSessionId.value === id) return;
    if (isStreaming.value) {
      stopGeneration();
    }
    currentSessionId.value = id;
  }

  /**
   * 删除会话
   */
  function deleteSession(id: string): void {
    const idx = sessions.value.findIndex((s) => s.id === id);
    if (idx === -1) return;

    sessions.value.splice(idx, 1);
    dirtySessionIds.delete(id);

    if (currentSessionId.value === id) {
      if (sessions.value.length > 0) {
        currentSessionId.value = sessions.value[0].id;
      } else {
        createNewSession();
      }
    }

    scheduleLocalCache(true);
    void deleteChatSession(id).catch((e) => {
      console.warn('[useChatStore] 删除服务端会话失败:', e);
    });
  }

  /**
   * 修改会话标题
   */
  function updateSessionTitle(id: string, title: string): void {
    const s = sessions.value.find((item) => item.id === id);
    if (s) {
      s.title = title.trim() || '未命名对话';
      s.updatedAt = Date.now();
      markSessionDirty(s.id);
    }
  }

  /**
   * 清空当前会话消息
   */
  function clearCurrentMessages(): void {
    if (currentSession.value) {
      currentSession.value.messages = [];
      currentSession.value.updatedAt = Date.now();
      markSessionDirty(currentSession.value.id);
    }
  }

  /**
   * 设置当前会话绑定的模型
   */
  function setSessionModel(modelName: string): void {
    if (currentSession.value) {
      currentSession.value.modelName = modelName;
      currentSession.value.updatedAt = Date.now();
      markSessionDirty(currentSession.value.id);
    }
  }

  /**
   * 立即把待同步会话提交到服务端（供发送结束、页面隐藏等时机调用）
   */
  async function syncSessionsNow(): Promise<void> {
    scheduleLocalCache(true);
    await flushDirtySessions();
    // 本次提交期间又产生了新的脏数据：接力再提交一次，确保调用方恢复时内容已落库
    if (dirtySessionIds.size > 0) {
      await flushDirtySessions();
    }
  }

  /**
   * 清空当前用户的全部会话（本地 + 服务端），清空后自动创建一个空白会话
   */
  async function clearAllSessions(): Promise<void> {
    // 先等在途提交落定，避免 DELETE 之后又被在途的 upsert 把旧会话写回
    await flushDirtySessions();

    sessions.value = [];
    currentSessionId.value = '';
    dirtySessionIds.clear();
    if (serverFlushTimer) {
      clearTimeout(serverFlushTimer);
      serverFlushTimer = null;
    }

    let failed = false;
    try {
      await clearChatSessions();
    } catch (e) {
      failed = true;
      console.warn('[useChatStore] 清空服务端会话失败:', e);
    }

    // 无论服务端结果如何，本地先给用户一个可继续对话的空白会话
    createNewSession();
    scheduleLocalCache(true);

    if (failed) {
      throw new Error('服务端清空失败，请检查网络后重试');
    }
  }

  /**
   * 发送消息并触发 AgentLoop
   */
  async function sendMessage(text: string, attachments: IAttachmentView[] = []): Promise<void> {
    if (!currentSession.value || isStreaming.value) return;

    const trimmedText = text.trim();
    if (!trimmedText && attachments.length === 0) return;

    const session = currentSession.value;
    const modelToUse = session.modelName || (availableModels.value[0]?.name ?? '');
    if (!modelToUse) {
      throw new Error('未配置或未选择可用模型');
    }

    // 1. 组装展示在界面的 user 消息
    const userMsgId = generateUUID();
    const userMsg: IChatMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmedText,
      attachments: [...attachments],
      createdAt: Date.now(),
    };

    session.messages.push(userMsg);
    session.updatedAt = Date.now();

    // 自动根据首轮提问修改新会话标题
    if (session.title === '新对话') {
      const summaryTitle = (trimmedText || attachments[0]?.name || '新对话').slice(0, 18);
      session.title = summaryTitle;
    }
    markSessionDirty(session.id);

    // 2. 构造传给 LLM 的上下文历史
    const llmMessages: ILlmMessage[] = [];

    // 收集会话历史中所有已解析成功的文档附件名
    const loadedDocNames: string[] = [];
    for (const m of session.messages) {
      if (m.attachments) {
        for (const a of m.attachments) {
          if (a.extractedText && !loadedDocNames.includes(a.name)) {
            loadedDocNames.push(a.name);
          }
        }
      }
    }

    // 系统提示词（注入能力说明与多轮附件记忆守则）
    const systemPromptLines = [
      '你是智能 AI 助理，当前集成有如下扩展工具能力：',
      '1. 【模型记忆】(ai_mm_*_user_memory): 主动查询或维护用户的称呼、习惯、本地项目、服务器IP、常用Docker容器与立体画像；',
      '2. 【处置方案】(ai_mm_*_skill): 查询或更新标准化故障排查、运维与操作指南；',
      '3. 【我的文档】(ai_mm_*_user_doc): 查询或沉淀个人知识库与业务文档；',
      '4. 【办公套件 doc-processor】: 对 Word、PDF、Excel、PPTX、Markdown 等格式进行双向互转(md_conver)、Excel读写(doc_excel_read/write)、PDF加水印与合并、Word文字替换等；',
      '5. 【Markdown文件生成】(create_markdown_file): 输入 Markdown 文本，自动在服务器 outputs 目录创建并保存 .md 文件，返回本地文件路径（可直接用于下游工具转换）以及 Web 下载链接。',
      '',
      '【文档与附件多轮理解守则】（非常重要）：',
      '- 用户在当前或多轮历史对话中上传的所有文档附件（PDF、Word、Excel、PPT 等），其正文内容均已由系统自动解析为 Markdown 纯文本，并以 `[参考附件文档: 《文档名》内容如下]` 格式嵌入在上文的历史消息中。',
      '- 当用户在后续任何一轮提问中提及“刚才的文件”、“上一次上传的文件”、“文档里的内容”或直接就文件细节提问时，请直接阅读和分析上文历史中的附件引文正文作答。',
      '- 若用户要求将对话内容、方案或长文导出为文件，可调用 create_markdown_file 创建 .md 文件；若用户需要进一步转为 Word/PDF/HTML，可将生成的文件路径作为 inputPath 传入 md_conver 工具进行互转。',
      '- 若用户要求对已上传的文件进行格式转换、提取或编辑，可调用 doc-processor 对应的工具（如 md_conver），工具的 inputPath 参数直接使用上文引文中提供的“服务器输入路径”；',
      '- 工具执行后会直接在返回值中提供可供下载的 Web 下载链接，请在回复中原样使用该链接呈现 Markdown 链接（例如：[点击下载 文件名](工具返回的Web下载链接)），切勿臆造路径或向用户输出服务器本地绝对路径。',
      '- 切勿回复“找不到文件”或要求用户提供本地磁盘物理路径，也切勿为了阅读内容而盲目调用 doc-processor 工具去寻找磁盘文件。',
    ];

    if (loadedDocNames.length > 0) {
      systemPromptLines.push(
        '',
        '【当前会话历史已加载的文档列表】：',
        ...loadedDocNames.map((name) => `- 《${name}》（完整正文已在上方历史消息中注入）`)
      );
    }

    systemPromptLines.push('', '在需要时请主动调用工具，以专业、准确、结构化的中文提供解答。');

    llmMessages.push({
      role: 'system',
      content: systemPromptLines.join('\n'),
    });

    // 还原历史消息
    for (const msg of session.messages) {
      if (msg.role === 'user') {
        // 判断是否有多模态图片或文档注入
        let promptText = msg.content;

        // 若携带文档附件且有提取的 Markdown 正文，作为引文注入
        if (msg.attachments && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            if (att.extractedText) {
              const pathInfo = att.serverFilePath ? ` (服务器输入路径: "${att.serverFilePath}")` : '';
              promptText = `[参考附件文档: 《${att.name}》${pathInfo}内容如下]:\n---\n${att.extractedText}\n---\n\n${promptText}`;
            }
          }
        }

        // 检查是否有图片附件
        const imageAtts = (msg.attachments || []).filter((a) => a.type === 'image' && a.url);
        if (imageAtts.length > 0) {
          const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
            { type: 'text', text: promptText },
          ];
          for (const img of imageAtts) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: img.url! },
            });
          }
          llmMessages.push({
            role: 'user',
            content: contentParts,
          });
        } else {
          llmMessages.push({
            role: 'user',
            content: promptText,
          });
        }
      } else if (msg.role === 'assistant') {
        // assistant 消息
        llmMessages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.toolCalls?.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: {
              name: c.name,
              arguments: c.argsText || '{}',
            },
          })),
        });

        // 紧跟配对的 tool 消息
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            llmMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: call.summary || '',
            });
          }
        }
      }
    }

    // 3. 创建空的 assistant 消息接收流式内容
    const assistantMsgId = generateUUID();
    const assistantMsg: IChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      reasoning: '',
      toolCalls: [],
      createdAt: Date.now(),
    };

    session.messages.push(assistantMsg);
    // 获取经过 Vue 响应式代理的目标对象，确保每次属性修改触发视图更新
    const targetMsg = session.messages[session.messages.length - 1];
    isStreaming.value = true;

    // 4. 启动 Agent 循环
    try {
      await agentLoop.run({
        modelName: modelToUse,
        messages: llmMessages,
        handlers: {
          onRoundStart: () => {
            // 新一轮开始
          },
          onTextDelta: (delta) => {
            targetMsg.content = (targetMsg.content || '') + delta;
            session.updatedAt = Date.now();
            markSessionDirty(session.id);
          },
          onReasoning: (delta) => {
            targetMsg.reasoning = (targetMsg.reasoning || '') + delta;
            session.updatedAt = Date.now();
            markSessionDirty(session.id);
          },
          onToolCalls: (calls) => {
            targetMsg.toolCalls = [...calls];
            session.updatedAt = Date.now();
            markSessionDirty(session.id);
          },
          onToolCallUpdate: (callId, patch) => {
            if (targetMsg.toolCalls) {
              const item = targetMsg.toolCalls.find((c) => c.id === callId);
              if (item) {
                Object.assign(item, patch);
                session.updatedAt = Date.now();
                markSessionDirty(session.id);
              }
            }
          },
          onDone: () => {
            isStreaming.value = false;
            session.updatedAt = Date.now();
            markSessionDirty(session.id);
          },
          onError: (errMsg) => {
            isStreaming.value = false;
            targetMsg.error = errMsg;
            session.updatedAt = Date.now();
            markSessionDirty(session.id);
          },
        },
      });
    } catch (err: any) {
      isStreaming.value = false;
      targetMsg.error = err.message || '运行出错';
    } finally {
      isStreaming.value = false;
      markSessionDirty(session.id);
      await syncSessionsNow();
    }
  }

  /**
   * 中止当前生成
   */
  function stopGeneration(): void {
    agentLoop.abort();
    isStreaming.value = false;
  }

  return {
    sessions,
    currentSessionId,
    currentSession,
    isStreaming,
    isSyncing,
    availableModels,
    isModelsLoading,
    loadModels,
    initSessions,
    createNewSession,
    switchSession,
    deleteSession,
    clearAllSessions,
    updateSessionTitle,
    clearCurrentMessages,
    setSessionModel,
    sendMessage,
    stopGeneration,
    syncSessionsNow,
  };
}

// 页面隐藏/卸载时尽力落盘本地缓存，避免未同步内容丢失
if (typeof window !== 'undefined') {
  const flushLocalCache = () => {
    if (sessions.value.length === 0) return;
    writeLocalCache();
  };
  window.addEventListener('pagehide', flushLocalCache);
  window.addEventListener('beforeunload', flushLocalCache);
}
