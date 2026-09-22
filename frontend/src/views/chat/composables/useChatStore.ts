/**
 * useChatStore.ts
 *
 * 负责 AI 聊天页面的多会话状态、当前活跃会话、消息收发与 AgentLoop 编排调度，
 * 以及会话持久化与可用模型加载（严格过滤 isDisable === true）。
 */

import { ref, computed, watch } from 'vue';
import { getModels, type Model } from '../../../api/modelService';
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

// 全局响应式状态
const sessions = ref<IChatSession[]>([]);
const currentSessionId = ref<string>('');
const isStreaming = ref<boolean>(false);
const availableModels = ref<Model[]>([]);
const isModelsLoading = ref<boolean>(false);

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

  /**
   * 初始化会话数据（从 localStorage 恢复）
   */
  function initSessions(): void {
    if (sessions.value.length > 0) return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          sessions.value = parsed;
        }
      }
    } catch (e) {
      console.warn('[useChatStore] 恢复会话缓存失败:', e);
    }

    const lastId = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    if (lastId && sessions.value.some((s) => s.id === lastId)) {
      currentSessionId.value = lastId;
    } else if (sessions.value.length > 0) {
      currentSessionId.value = sessions.value[0].id;
    } else {
      createNewSession();
    }
  }

  /**
   * 持久化保存会话
   */
  function persistSessions(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.value));
      if (currentSessionId.value) {
        localStorage.setItem(LAST_ACTIVE_SESSION_KEY, currentSessionId.value);
      }
    } catch (e) {
      console.warn('[useChatStore] 持久化会话失败:', e);
    }
  }

  // 深度监听会话变化并自动持久化
  watch(
    sessions,
    () => {
      persistSessions();
    },
    { deep: true }
  );

  // 监听当前会话切换
  watch(currentSessionId, (newId) => {
    if (newId) {
      localStorage.setItem(LAST_ACTIVE_SESSION_KEY, newId);
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

    if (currentSessionId.value === id) {
      if (sessions.value.length > 0) {
        currentSessionId.value = sessions.value[0].id;
      } else {
        createNewSession();
      }
    }
  }

  /**
   * 修改会话标题
   */
  function updateSessionTitle(id: string, title: string): void {
    const s = sessions.value.find((item) => item.id === id);
    if (s) {
      s.title = title.trim() || '未命名对话';
      s.updatedAt = Date.now();
    }
  }

  /**
   * 清空当前会话消息
   */
  function clearCurrentMessages(): void {
    if (currentSession.value) {
      currentSession.value.messages = [];
      currentSession.value.updatedAt = Date.now();
    }
  }

  /**
   * 设置当前会话绑定的模型
   */
  function setSessionModel(modelName: string): void {
    if (currentSession.value) {
      currentSession.value.modelName = modelName;
      currentSession.value.updatedAt = Date.now();
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
          },
          onReasoning: (delta) => {
            targetMsg.reasoning = (targetMsg.reasoning || '') + delta;
            session.updatedAt = Date.now();
          },
          onToolCalls: (calls) => {
            targetMsg.toolCalls = [...calls];
            session.updatedAt = Date.now();
          },
          onToolCallUpdate: (callId, patch) => {
            if (targetMsg.toolCalls) {
              const item = targetMsg.toolCalls.find((c) => c.id === callId);
              if (item) {
                Object.assign(item, patch);
                session.updatedAt = Date.now();
              }
            }
          },
          onDone: () => {
            isStreaming.value = false;
            session.updatedAt = Date.now();
          },
          onError: (errMsg) => {
            isStreaming.value = false;
            targetMsg.error = errMsg;
            session.updatedAt = Date.now();
          },
        },
      });
    } catch (err: any) {
      isStreaming.value = false;
      targetMsg.error = err.message || '运行出错';
    } finally {
      isStreaming.value = false;
      persistSessions();
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
    availableModels,
    isModelsLoading,
    loadModels,
    initSessions,
    createNewSession,
    switchSession,
    deleteSession,
    updateSessionTitle,
    clearCurrentMessages,
    setSessionModel,
    sendMessage,
    stopGeneration,
  };
}
