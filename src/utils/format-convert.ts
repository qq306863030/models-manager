/**
 * Format Convert — 数据流格式转换核心工具集
 *
 * 统一管理三种数据流格式之间的互相转换：
 *   1 → OpenAI Chat Completions (openai-chat)
 *   2 → Anthropic Messages (anthropic)
 *   3 → OpenAI Responses (openai-responses)
 *
 * 所有转换以 OpenAI Chat 格式为中心。
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import OpenAI from 'openai';
import { getUserSettings } from '../config/database';
import { stripThinkingTags } from './thinking';
import * as ConvertUtils from '../utils/service-convert/Proxy/common/convert-utils';

// ========== 类型定义 ==========

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

export interface AIProvider {
  type: 'anthropic' | 'openai-chat' | 'openai-responses';
  client: Anthropic | OpenAI;
  modelName: string;
}

export interface GenericMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

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

export interface UserSettings {
  max_content_length: number;
  max_token: number;
}

// ========== 常量 ==========

export const MAX_RESPONSE_TOKENS = 64000;

/** 上游请求超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 30000;

export const API_FORMAT = {
  OPENAI_CHAT: 1,
  ANTHROPIC: 2,
  OPENAI_RESPONSES: 3,
} as const;

export const LOCK_DURATION_MS = (() => {
  try {
    const settings = getUserSettings();
    return (settings.lock_duration || 600) * 1000;
  } catch {
    return 600 * 1000;
  }
})();

// ========== 辅助工具函数 ==========

/** 生成随机字符串 */
export function generateRandomString(length = 12): string {
  return ConvertUtils.generateRandomString(length);
}

/** 估算文本的 token 数（约 3 字符/token） */
export function estimateTextTokens(text: string): number {
  return ConvertUtils.estimateTokens(text);
}

/** 估算消息数组的 token 数 */
export function estimateMessagesTokens(messages: GenericMessage[]): number {
  return estimateTextTokens(
    messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role || ''}:${content}`;
      })
      .join('\n'),
  );
}

// ========== Provider 工厂 ==========

export function createModelProvider(model: ModelRow): AIProvider {
  const baseURL = model.url.replace(/\/$/, '');
  const modelName = model.model_name;

  switch (model.api_format) {
    case API_FORMAT.ANTHROPIC: {
      // Anthropic SDK 的路由已包含 /v1（如 /v1/messages），
      // 因此需要去掉 baseURL 末尾的 /v1，避免路径重复
      const anthropicBaseURL = baseURL.replace(/\/v1$/, '');
      const client = new Anthropic({
        baseURL: anthropicBaseURL,
        apiKey: model.api_key,
      });
      return { type: 'anthropic', client, modelName };
    }
    case API_FORMAT.OPENAI_RESPONSES: {
      const client = new OpenAI({
        baseURL,
        apiKey: model.api_key,
      });
      return { type: 'openai-responses', client, modelName };
    }
    default: {
      // api_format === 1 (openai-chat)
      const client = new OpenAI({
        baseURL,
        apiKey: model.api_key,
      });
      return { type: 'openai-chat', client, modelName };
    }
  }
}

// ========== 锁定状态判断 ==========

export function isModelLocked(isLock: number): { locked: boolean; expired: boolean } {
  if (!isLock || isLock <= 0) return { locked: false, expired: false };
  const elapsed = Date.now() - isLock;
  if (elapsed > LOCK_DURATION_MS) return { locked: false, expired: true };
  return { locked: true, expired: false };
}

// ========== Anthropic ↔ OpenAI Chat 消息转换 ==========

/**
 * OpenAI Chat 消息 → Anthropic Messages 格式
 * 将 system 消息提取为顶层 system 字段
 */
export function convertToAnthropicMessages(
  messages: OpenAIMessage[],
  system?: string,
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

/**
 * OpenAI Chat 消息 → 通用消息格式
 */
export function convertToOpenAIChatMessages(messages: OpenAIMessage[]): GenericMessage[] {
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

// ========== Anthropic ↔ OpenAI Tools 转换 ==========

export function convertToAnthropicTools(tools: OpenAITool[]): Tool[] {
  const cleaned = ConvertUtils.cleanTools(tools as unknown as Record<string, unknown>[], 'openai-chat');
  if (!Array.isArray(cleaned)) return [];
  return cleaned.map((t: any) => ({
    name: t.function?.name || '',
    description: t.function?.description || '',
    input_schema: t.function?.parameters || { type: 'object', properties: {} },
  }));
}

export function convertToOpenAITools(tools: OpenAITool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters,
    },
  }));
}

// ========== Tool Choice 映射 ==========

/**
 * tool_choice 格式转换（OpenAI ↔ Anthropic）
 */
export function mapToolChoice(
  toolChoice: unknown,
  direction: 'to-anthropic' | 'to-openai',
): unknown {
  if (!toolChoice) return undefined;
  if (direction === 'to-anthropic') {
    return ConvertUtils.mapToolChoiceToAnthropic(toolChoice);
  } else {
    return ConvertUtils.mapToolChoiceToChat(toolChoice);
  }
}

// ========== Stop Sequences 映射 ==========

export function mapStopSequences(
  stop: unknown,
  direction: 'to-anthropic' | 'to-openai',
): unknown {
  if (!stop) return undefined;
  if (direction === 'to-anthropic') {
    return ConvertUtils.mapStopSequencesToAnthropic(stop);
  } else {
    return ConvertUtils.mapStopSequencesToOpenAI(stop);
  }
}

// ========== Anthropic 响应 → OpenAI Chat 格式 ==========

export function convertAnthropicToChatCompletion(
  response: Message,
  modelName: string,
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
    // type === 'thinking' 块 — 跳过，不作为 OpenAI chat 的输出内容
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    message.content = null;
  }

  return {
    id: `chatcmpl-${generateRandomString(12)}`,
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

// ========== Responses API ↔ Chat 请求转换 ==========

/**
 * Responses API 请求 → Chat Completion 请求
 * 已迁移至 ConvertUtils.responsesRequestToChatRequest
 */
export function convertResponsesRequestToChatRequest(body: Record<string, unknown>): Record<string, unknown> {
  return ConvertUtils.responsesRequestToChatRequest(body);
}

/**
 * Chat Completion 响应 → Responses API 响应
 */
export function convertChatCompletionToResponse(
  chatCompletion: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  return ConvertUtils.chatResponseToResponsesResponse(chatCompletion, requestBody);
}

// ========== Anthropic ↔ OpenAI Chat 响应转换 ==========

/**
 * OpenAI Chat 响应 → Anthropic Messages 响应格式
 *
 * 将 OpenAI Chat Completion 响应转换为 Anthropic Message 对象，
 * 供 /v1/messages 端点使用。
 */
export function convertOpenAIChatToAnthropicResponse(
  chatCompletion: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const result = ConvertUtils.chatResponseToAnthropicResponse(chatCompletion);
  // 保留旧版的 requestBody.anthropic_version 字段
  const anthropicVersion = (requestBody.anthropic_version as string) || undefined;
  if (anthropicVersion) {
    (result as any).anthropic_version = anthropicVersion;
  }
  return result;
}

/**
 * 将错误响应包装为 Anthropic 格式的错误对象
 */
export function toAnthropicError(
  message: string,
  type: string = 'api_error',
): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  };
}

// ========== Anthropic Messages 请求 → 通用内部格式 ==========

/**
 * 将 Anthropic Messages API 的请求体转换为通用的 ChatCallParams
 *
 * 处理 Anthropic 特有的字段结构：
 * - system 字段（字符串或文本块数组）
 * - messages 中的 content 块（text/image/tool_use/tool_result）
 * - tool_choice 对象格式
 * - stop_sequences 数组
 * - 请求中不存在的 max_tokens 走默认值
 */
export function convertAnthropicRequestToCommon(body: Record<string, unknown>): ChatCallParams {
  const messages: GenericMessage[] = [];

  // 提取 system 字段
  const system = body.system;
  let systemText = '';
  if (typeof system === 'string') {
    systemText = system;
  } else if (Array.isArray(system)) {
    // Anthropic 允许 system 为文本块数组
    systemText = system
      .map((block: any) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  // 转换 messages
  const rawMessages = (body.messages as any[]) || [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role as string;

    if (role === 'user') {
      // 检查是否包含 tool_result 块
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolResultBlocks = blocks.filter((b: any) => b.type === 'tool_result');
      if (toolResultBlocks.length > 0) {
        for (const tr of toolResultBlocks) {
          const trContent = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
          messages.push({
            role: 'tool',
            content: trContent,
            tool_call_id: tr.tool_use_id || `call_${generateRandomString(8)}`,
          });
        }
      } else {
        const userContent = convertAnthropicContentBlocks(msg.content);
        messages.push({ role: 'user', content: userContent });
      }
    } else if (role === 'assistant') {
      let textContent = '';
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

      const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += (block.text || '');
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${generateRandomString(8)}`,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : String(block.input || '{}'),
            },
          });
        }
        // thinking/signature 块跳过
      }

      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
      } else {
        messages.push({ role: 'assistant', content: textContent || null });
      }
    }
  }

  // 转换 tools
  let tools: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }> | undefined;
  if (Array.isArray(body.tools)) {
    tools = (body.tools as any[]).map((tool) => ({
      function: {
        name: tool.name || '',
        description: tool.description || '',
        parameters: (tool.input_schema || {}) as Record<string, unknown>,
      },
    }));
  }

  // tool_choice
  const toolChoice = body.tool_choice
    ? (mapToolChoice(body.tool_choice, 'to-openai') as string)
    : undefined;

  // stop_sequences → stop
  const stop = body.stop_sequences
    ? (mapStopSequences(body.stop_sequences, 'to-openai') as string | string[] | undefined)
    : undefined;

  // max_tokens
  let maxTokens = MAX_RESPONSE_TOKENS;
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) {
    maxTokens = Math.min(body.max_tokens, MAX_RESPONSE_TOKENS);
  }
  // 用户设置覆盖
  const settingsMaxToken = getEffectiveMaxToken();
  if (settingsMaxToken > 0) {
    maxTokens = settingsMaxToken;
  }

  return {
    messages,
    maxOutputTokens: maxTokens,
    temperature: body.temperature as number | undefined,
    topP: body.top_p as number | undefined,
    tools,
    toolChoice,
    system: systemText || undefined,
  };
}

/**
 * 转换 Anthropic 消息内容块为 OpenAI 格式的内容值
 */
function convertAnthropicContentBlocks(content: unknown): string | Array<Record<string, unknown>> | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  // 纯文本 → 返回字符串
  const textParts = content.filter((block) => block.type === 'text');
  if (textParts.length > 0 && content.every((b: any) => b.type === 'text' || b.type === 'thinking')) {
    return textParts.map((b: any) => b.text || '').join('\n');
  }

  // 包含 image 块 → 转换为 image_url 格式
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text') {
      if ((block.text || '') !== '') {
        parts.push({ type: 'text', text: block.text });
      }
    } else if (block.type === 'image') {
      const source = block.source as any;
      if (source) {
        if (source.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${source.media_type};base64,${source.data}` },
          });
        } else if (source.type === 'url') {
          parts.push({
            type: 'image_url',
            image_url: { url: source.url },
          });
        }
      }
    }
    // tool_result 块由上层单独处理
  }

  return parts.length > 0 ? parts : null;
}

// ========== 非流式 API 调用函数 ==========

export interface ChatCallParams {
  messages: GenericMessage[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  toolChoice?: string;
  system?: string;
}

export async function callOpenAIChat(
  provider: AIProvider,
  params: ChatCallParams,
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = provider.client as OpenAI;

  const response = await client.chat.completions.create(
    {
      model: provider.modelName,
      messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
      max_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      top_p: params.topP,
      tools: params.tools
        ? params.tools.map((t) => ({ type: 'function' as const, function: t.function }))
        : undefined,
      tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
      stream: false,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );

  // 移除响应中的 thinking 标签
  if (response.choices[0]?.message?.content) {
    response.choices[0].message.content = stripThinkingTags(response.choices[0].message.content);
  }

  return response;
}

export async function callAnthropic(
  provider: AIProvider,
  params: ChatCallParams,
): Promise<Record<string, unknown>> {
  const response = await streamAnthropicAndCollect(provider, params);
  return convertAnthropicToChatCompletion(response, provider.modelName);
}

export async function callOpenAIResponses(
  provider: AIProvider,
  params: ChatCallParams,
  _originalBody: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = provider.client as OpenAI;

  // 转换 messages 为 Responses 格式
  const responseInput: Record<string, unknown>[] = [];

  for (const msg of params.messages) {
    if (msg.role === 'system') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'user') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) {
        parts.push({ type: 'output_text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'function_call',
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      responseInput.push({ type: 'message', role: 'assistant', content: parts });
    } else if (msg.role === 'tool') {
      responseInput.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: msg.content || '',
      });
    }
  }

  const tools = params.tools?.map((t) => ({
    type: 'function',
    name: (t as unknown as { function: { name: string } }).function.name,
    description: (t as unknown as { function: { description?: string } }).function.description,
    parameters: (t as unknown as { function: { parameters: Record<string, unknown> } }).function.parameters,
  }));

  const response = await client.responses.create(
    {
      model: provider.modelName,
      input: responseInput as unknown as any,
      max_output_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      tools: tools as unknown as any,
      stream: false,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );

  // 转换响应为 Chat Completion 格式
  const textParts = response.output.filter((o) => (o as unknown as { type: string }).type === 'text');
  const text = textParts.map((o) => (o as unknown as { text: string }).text).join('');

  const functionCalls = response.output.filter(
    (o) => (o as unknown as { type: string }).type === 'function_call',
  );
  const toolCallsArr = functionCalls.map((o) => {
    const fc = o as unknown as { call_id: string; name: string; arguments: unknown };
    return {
      id: fc.call_id,
      type: 'function' as const,
      function: {
        name: fc.name,
        arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments),
      },
    };
  });

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };

  // 移除 thinking 标签
  if (message.content && typeof message.content === 'string') {
    message.content = stripThinkingTags(message.content) || null;
  }

  if (toolCallsArr.length > 0) {
    message.tool_calls = toolCallsArr;
    message.content = null;
  }

  const result: Record<string, unknown> = {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: provider.modelName,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCallsArr.length > 0 ? 'tool_calls' : 'stop',
    }],
  };

  if (response.usage) {
    result.usage = {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    };
  }

  return result;
}

/**
 * 调用 Anthropic SDK 并返回原始 Anthropic Message 格式的响应（内部流式）
 * 用于 /v1/messages 端点，避免转换回 OpenAI Chat 格式再转回的损耗。
 * Anthropic SDK 要求长时间请求必须走 streaming，所以内部始终流式并收集结果。
 */
export async function callAnthropicMessages(
  provider: AIProvider,
  params: ChatCallParams,
): Promise<Record<string, unknown>> {
  return streamAnthropicAndCollect(provider, params) as unknown as Record<string, unknown>;
}

/**
 * 内部：调用 Anthropic Messages 流式 API 并收集完整结果
 * 返回合成的 Anthropic Message 格式对象
 */
async function streamAnthropicAndCollect(
  provider: AIProvider,
  params: ChatCallParams,
): Promise<any> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(
    params.messages as unknown as OpenAIMessage[],
    params.system,
  );

  const stream = await client.messages.stream(
    {
      model: provider.modelName,
      max_tokens: params.maxOutputTokens,
      messages: anthropicParams.messages,
      system: anthropicParams.system,
      temperature: params.temperature,
      tools: params.tools ? convertToAnthropicTools(params.tools as unknown as OpenAITool[]) : undefined,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );

  // 收集流式事件，构建完整 Message 对象
  let messageId = '';
  let modelName = provider.modelName;
  const contentBlocks: Array<Record<string, unknown>> = [];
  let stopReason: string | null = null;
  let usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };

  for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
    const type = event.type as string;

    if (type === 'message_start') {
      const msg = (event as any).message;
      if (msg?.id) messageId = msg.id;
      if (msg?.model) modelName = msg.model;
    }

    if (type === 'content_block_start') {
      const block = (event as any).content_block;
      const entry: Record<string, unknown> = { type: block.type };
      if (block.id) entry.id = block.id;
      if (block.name) entry.name = block.name;
      if (block.text) entry.text = block.text;
      if (block.type === 'tool_use') entry._partial_json = '';
      contentBlocks.push(entry);
    }

    if (type === 'content_block_delta') {
      const delta = (event as any).delta;
      const idx = (event as any).index as number;
      const block = contentBlocks[idx];
      if (!block) continue;

      if (delta.type === 'text_delta' && delta.text) {
        block.text = ((block.text as string) || '') + delta.text;
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        block._partial_json = ((block._partial_json as string) || '') + delta.partial_json;
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        block.thinking = ((block.thinking as string) || '') + delta.thinking;
      }
    }

    if (type === 'content_block_stop') {
      const idx = (event as any).index as number;
      const block = contentBlocks[idx];
      if (!block) continue;

      // 解析 tool_use 的 JSON 参数
      if (block.type === 'tool_use' && block._partial_json) {
        try {
          block.input = JSON.parse(block._partial_json as string);
        } catch {
          block.input = {};
        }
        delete block._partial_json;
      }
    }

    if (type === 'message_delta') {
      const delta = (event as any).delta;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      if ((event as any).usage) {
        usage = (event as any).usage;
      }
    }
  }

  return {
    id: messageId || `msg_${generateRandomString(24)}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: modelName,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

/** Anthropic 流式创建，用于 /v1/messages 端点 */
export async function streamAnthropicMessages(
  provider: AIProvider,
  params: ChatCallParams,
): Promise<any> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(
    params.messages as unknown as OpenAIMessage[],
    params.system,
  );

  return client.messages.stream(
    {
      model: provider.modelName,
      max_tokens: params.maxOutputTokens,
      messages: anthropicParams.messages,
      system: anthropicParams.system,
      temperature: params.temperature,
      tools: params.tools ? convertToAnthropicTools(params.tools as unknown as OpenAITool[]) : undefined,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
}

// ========== 模型操作辅助 ==========

export function getUserEffectiveSettings(): UserSettings {
  const settings = getUserSettings();
  return { max_content_length: settings.max_content_length, max_token: settings.max_token };
}

export function getEffectiveContentLength(modelContentLength: number): number {
  const settings = getUserEffectiveSettings();
  return settings.max_content_length > 0 ? settings.max_content_length : modelContentLength;
}

export function getEffectiveMaxToken(): number {
  const settings = getUserEffectiveSettings();
  return settings.max_token > 0 ? settings.max_token : 0;
}

/** 构建 OpenAI 模型响应格式（含 Codex 所需元数据） */
export function buildOpenAIModel(model: ModelRow) {
  const capabilities = model.capabilities
    ? JSON.parse(model.capabilities)
    : ['completion', 'tools', 'thinking'];
  const effectiveContentLength = getEffectiveContentLength(model.max_content_length);
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(new Date(model.created_at).getTime() / 1000),
    owned_by: 'library',
    name: model.name,
    content_length: effectiveContentLength,
    capabilities,
    // Codex/Responses API 所需元数据
    supports_responses_api: model.api_format === API_FORMAT.OPENAI_RESPONSES,
    max_output_tokens: model.max_token || MAX_RESPONSE_TOKENS,
  };
}

export function parseModelCapabilities(raw?: string | null): string[] {
  if (!raw) return ['completion', 'tools', 'thinking'];
  try {
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : ['completion', 'tools', 'thinking'];
  } catch {
    return ['completion', 'tools', 'thinking'];
  }
}
