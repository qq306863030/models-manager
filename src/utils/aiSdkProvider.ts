/**
 * AI SDK Provider 工厂与格式转换器
 *
 * 根据 model.api_format 使用官方 SDK 直接调用 API：
 *   1 → OpenAI Chat Completions (openai SDK)
 *   2 → Anthropic Messages (@anthropic-ai/sdk)
 *   3 → OpenAI Responses (openai SDK)
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  MessageStreamEvent,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import OpenAI from 'openai';

// ========== 模型行类型 ==========
export interface ModelRow {
  id: number;
  name: string;
  model_name: string;
  url: string;
  max_content_length: number;
  max_token: number;
  api_key: string;
  sort_index: number;
  api_format: number;
  model_label_id: number | null;
  capabilities: string | null;
  isLock: number;
  isDisable: number;
  user_id?: number;
  created_at: string;
}

// 锁定时长：从数据库读取，默认 10 分钟（600秒）
import { getUserSettings } from '../config/database';

export const LOCK_DURATION_MS = (() => {
  try {
    const settings = getUserSettings();
    return (settings.lock_duration || 600) * 1000;
  } catch {
    return 600 * 1000;
  }
})();

// ========== SDK 客户端类型 ==========
export interface AIProvider {
  type: 'anthropic' | 'openai-chat' | 'openai-responses';
  client: Anthropic | OpenAI;
  modelName: string;
}

// ========== Provider 工厂 ==========

/**
 * 根据 api_format 创建官方 SDK 客户端
 */
export function createModelProvider(model: ModelRow): AIProvider {
  const baseURL = model.url.replace(/\/$/, '');
  const modelName = model.model_name;

  switch (model.api_format) {
    case 2: {
      // Anthropic Messages
      const client = new Anthropic({
        baseURL,
        apiKey: model.api_key,
      });
      return { type: 'anthropic', client, modelName };
    }
    case 3: {
      // OpenAI Responses
      const client = new OpenAI({
        baseURL,
        apiKey: model.api_key,
      });
      return { type: 'openai-responses', client, modelName };
    }
    default: {
      // OpenAI Chat Completions (api_format = 1)
      const client = new OpenAI({
        baseURL,
        apiKey: model.api_key,
      });
      return { type: 'openai-chat', client, modelName };
    }
  }
}

// ========== Anthropic 请求参数转换 ==========

export interface OpenAIMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export function convertToAnthropicMessages(
  messages: OpenAIMessage[],
  system?: string
): { system?: string; messages: MessageParam[] } {
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    const role = msg.role as string;

    if (role === 'system') {
      continue;
    }

    if (role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (role === 'assistant') {
      const content: MessageParam['content'] = [];

      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text as string });
          }
        }
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
      }

      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }

    if (role === 'user') {
      const content: MessageParam['content'] = [];

      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text as string });
          } else if (block.type === 'image_url') {
            const imageUrl = (block.image_url as { url: string })?.url;
            if (imageUrl) {
              if (imageUrl.startsWith('data:')) {
                const [header, base64Data] = imageUrl.split(',');
                const mediaType = header.replace('data:', '').split(';')[0];
                content.push({
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType as any, data: base64Data },
                });
              } else {
                content.push({
                  type: 'image',
                  source: { type: 'url', url: imageUrl },
                });
              }
            }
          }
        }
      }

      anthropicMessages.push({ role: 'user', content });
    }
  }

  return { system, messages: anthropicMessages };
}

// ========== OpenAI Chat 消息转换（通用类型） ==========

export interface GenericMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export function convertToOpenAIChatMessages(
  messages: OpenAIMessage[]
): GenericMessage[] {
  const result: GenericMessage[] = [];

  for (const msg of messages) {
    const role = msg.role as 'system' | 'user' | 'assistant' | 'tool';
    
    if (role === 'system') {
      result.push({ role: 'system', content: String(msg.content || '') });
      continue;
    }

    if (role === 'tool') {
      result.push({
        role: 'tool',
        content: String(msg.content || ''),
        tool_call_id: msg.tool_call_id,
      });
      continue;
    }

    if (role === 'assistant' && msg.tool_calls) {
      result.push({
        role: 'assistant',
        content: msg.content as string | null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });
      continue;
    }

    result.push({
      role,
      content: msg.content as string | null,
    });
  }

  return result;
}

// ========== Anthropic Tools 转换 ==========

export function convertToAnthropicTools(
  tools: OpenAITool[]
): Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: tool.function.parameters as Tool['input_schema'],
  }));
}

// ========== OpenAI Tools 转换 ==========

export function convertToOpenAITools(
  tools: OpenAITool[]
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters,
    },
  }));
}

// ========== Anthropic 响应 → OpenAI 格式转换 ==========

export function convertAnthropicToChatCompletion(
  response: Message,
  modelName: string
): Record<string, unknown> {
  const contentBlocks = response.content as unknown as Array<Record<string, unknown>>;
  
  let text = '';
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      text += (block.text as string) || '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    message.content = null;
  }

  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 14)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// ========== Anthropic 流式事件转换 ==========

export function convertAnthropicStreamEvent(
  event: MessageStreamEvent
): Record<string, unknown> | null {
  const completionId = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`;
  const eventObj = event as unknown as Record<string, unknown>;

  if (event.type === 'message_delta') {
    const deltaEvent = eventObj as {
      delta: { stop_reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: deltaEvent.delta?.stop_reason,
      }],
      usage: {
        prompt_tokens: deltaEvent.usage?.input_tokens ?? 0,
        completion_tokens: deltaEvent.usage?.output_tokens ?? 0,
        total_tokens: (deltaEvent.usage?.input_tokens ?? 0) + (deltaEvent.usage?.output_tokens ?? 0),
      },
    };
  }

  if (event.type === 'content_block_delta') {
    const deltaEvent = eventObj as {
      delta: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: string;
      };
    };
    const delta = deltaEvent.delta;

    if (delta.type === 'text_delta' && delta.text) {
      return {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [{
          index: 0,
          delta: { content: delta.text },
          finish_reason: null,
        }],
      };
    }

    if (delta.type === 'tool_use_delta') {
      return {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: delta.id || '',
              type: 'function',
              function: {
                name: delta.name || '',
                arguments: delta.input || '',
              },
            }],
          },
          finish_reason: null,
        }],
      };
    }
  }

  return null;
}

// ========== 锁定状态判断 ==========

export function isModelLocked(isLock: number): { locked: boolean; expired: boolean } {
  if (!isLock || isLock <= 0) return { locked: false, expired: false };
  const elapsed = Date.now() - isLock;
  if (elapsed > LOCK_DURATION_MS) return { locked: false, expired: true };
  return { locked: true, expired: false };
}
