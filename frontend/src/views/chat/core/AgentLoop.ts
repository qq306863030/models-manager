/**
 * AgentLoop.ts
 *
 * Agent 多轮编排循环核心（借鉴 page_17/core/AgentLoop.ts），
 * 负责多轮 Function Calling 状态机流转、参数容错解析、工具执行及最终文本生成。
 */

import LlmClient, { type ILlmMessage, type ILlmToolCall } from './LlmClient';
import ToolRegistry from './ToolRegistry';

export type TToolCallStatus = 'pending' | 'running' | 'done' | 'failed';

export interface IToolCallView {
  id: string;
  name: string;
  title: string;
  argsText: string;
  preview: string;
  status: TToolCallStatus;
  summary?: string;
}

export interface IAgentHandlers {
  onRoundStart: () => void;
  onTextDelta: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCalls: (calls: IToolCallView[]) => void;
  onToolCallUpdate: (callId: string, patch: Partial<IToolCallView>) => void;
  onDone: (finishReason: string) => void;
  onError: (message: string) => void;
}

export interface IAgentRunParams {
  modelName: string;
  messages: ILlmMessage[];
  handlers: IAgentHandlers;
}

const MAX_ROUNDS = 15;

export class AgentLoop {
  private static instance: AgentLoop | null = null;
  private isAborted = false;
  private currentAbortFn: (() => void) | null = null;

  static getInstance(): AgentLoop {
    if (!AgentLoop.instance) {
      AgentLoop.instance = new AgentLoop();
    }
    return AgentLoop.instance;
  }

  /**
   * 中止当前正在进行的 Agent 循环
   */
  abort(): void {
    this.isAborted = true;
    if (this.currentAbortFn) {
      this.currentAbortFn();
      this.currentAbortFn = null;
    }
  }

  /**
   * 启动多轮 Agent 对话
   */
  async run(params: IAgentRunParams): Promise<void> {
    const { modelName, messages, handlers } = params;
    const toolRegistry = ToolRegistry.getInstance();
    const llmClient = LlmClient.getInstance();

    // 确保外部工具（如 doc-processor）已异步加载完成
    await toolRegistry.loadExternalTools();
    const tools = toolRegistry.getAllSchemas();

    const conversationHistory: ILlmMessage[] = [...messages];
    this.isAborted = false;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (this.isAborted) {
        handlers.onDone('aborted');
        return;
      }

      handlers.onRoundStart();

      let roundContent = '';
      let roundReasoning = '';
      let roundToolCalls: ILlmToolCall[] = [];
      let roundFinishReason = 'stop';
      let roundError: string | null = null;

      await new Promise<void>((resolve) => {
        let hasResolved = false;
        const doResolve = () => {
          if (!hasResolved) {
            hasResolved = true;
            resolve();
          }
        };

        llmClient
          .streamChat(
            modelName,
            conversationHistory,
            {
              onDelta: (delta) => {
                roundContent += delta;
                handlers.onTextDelta(delta);
              },
              onReasoning: (delta) => {
                roundReasoning += delta;
                handlers.onReasoning?.(delta);
              },
              onToolCalls: (calls) => {
                roundToolCalls = calls;
              },
              onDone: (finishReason) => {
                roundFinishReason = finishReason;
                doResolve();
              },
              onError: (err) => {
                roundError = err;
                doResolve();
              },
            },
            { tools }
          )
          .then((abortFn) => {
            this.currentAbortFn = abortFn;
          })
          .catch((err) => {
            roundError = (err as Error).message;
            doResolve();
          });
      });

      if (this.isAborted) {
        handlers.onDone('aborted');
        return;
      }

      if (roundError) {
        handlers.onError(roundError);
        return;
      }

      // 如果模型没有请求工具调用，本轮结束
      if (!roundToolCalls || roundToolCalls.length === 0) {
        handlers.onDone(roundFinishReason);
        return;
      }

      // 存在工具调用，初始化视图卡片
      const toolViews: IToolCallView[] = roundToolCalls.map((call) => {
        const title = toolRegistry.getToolTitle(call.function.name);
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments || '{}');
        } catch {}
        const preview = toolRegistry.formatArgsPreview(call.function.name, parsedArgs);

        return {
          id: call.id,
          name: call.function.name,
          title,
          argsText: call.function.arguments,
          preview,
          status: 'pending',
        };
      });

      handlers.onToolCalls(toolViews);

      // 将 assistant 带有 tool_calls 的消息加入历史（必须严格匹配）
      conversationHistory.push({
        role: 'assistant',
        content: roundContent || '',
        tool_calls: roundToolCalls,
      });

      // 串行执行各工具调用
      for (const view of toolViews) {
        if (this.isAborted) {
          handlers.onDone('aborted');
          return;
        }

        handlers.onToolCallUpdate(view.id, { status: 'running' });

        let resultSummary = '';
        let status: TToolCallStatus = 'done';

        try {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(view.argsText || '{}');
          } catch (e) {
            throw new Error(`参数格式非法 JSON: ${(e as Error).message}`);
          }

          const rawResult = await toolRegistry.execute(view.name, args);
          resultSummary = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
        } catch (err: any) {
          status = 'failed';
          resultSummary = `执行失败: ${err.message || '未知异常'}`;
        }

        handlers.onToolCallUpdate(view.id, {
          status,
          summary: resultSummary,
        });

        // 将 tool 结果回填给上下文
        conversationHistory.push({
          role: 'tool',
          tool_call_id: view.id,
          content: resultSummary,
        });
      }

      // 执行完毕后进入下一轮，让模型基于工具结果继续作答
    }

    handlers.onDone('length');
  }
}

export default AgentLoop;
