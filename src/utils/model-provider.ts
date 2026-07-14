/**
 * model-provider.ts — 模型管理、提供商 SDK 调用、格式转换入口
 *
 * 整体流程：
 *   用户请求 → 统计输入 token → 代理转换 → SDK 调用 → 流式/非流式响应 → 统计输出 token
 *
 * 转换层统一使用 ConvertUtils（service-convert 框架），
 * 模型管理和 SDK 调用保持与 OpenAI/Anthropic SDK 的直接集成。
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import OpenAI from 'openai';
import { getUserSettings as getDbUserSettings } from '../config/database';
import { stripThinkingTags } from './thinking';
import * as ConvertUtils from './service-convert/Proxy/common/convert-utils';

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
  lock_duration?: number;
}

export interface ChatCallParams {
  messages: GenericMessage[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  toolChoice?: string;
  system?: string;
}

// ========== 常量 ==========

export const MAX_RESPONSE_TOKENS = 64000;
export const REQUEST_TIMEOUT_MS = 30000;

export const API_FORMAT = {
  OPENAI_CHAT: 1,
  ANTHROPIC: 2,
  OPENAI_RESPONSES: 3,
} as const;

export const LOCK_DURATION_MS = (() => {
  try {
    const settings = getDbUserSettings() as UserSettings | undefined;
    return ((settings as any)?.lock_duration || 600) * 1000;
  } catch {
    return 600 * 1000;
  }
})();

// ========== 基础工具函数 ==========

/** 生成随机字符串 */
export function generateRandomString(length = 12): string {
  return ConvertUtils.generateRandomString(length);
}

/** 估算文本的 token 数 */
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

// ========== 用户设置辅助 ==========

export function getUserSettings(): UserSettings {
  const settings = getDbUserSettings() as UserSettings | undefined;
  return settings || { max_content_length: 0, max_token: 0 };
}

export function getUserEffectiveSettings(): UserSettings {
  return getUserSettings();
}

export function getEffectiveContentLength(modelContentLength: number): number {
  const settings = getUserEffectiveSettings();
  return settings.max_content_length > 0 ? settings.max_content_length : modelContentLength;
}

export function getEffectiveMaxToken(): number {
  const settings = getUserEffectiveSettings();
  return settings.max_token > 0 ? settings.max_token : 0;
}

/** 根据用户名查询用户 ID */
export function getUserIdByUsername(username: string): number | null {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// 延迟加载 db 避免循环依赖
function getDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../config/database').default || require('../config/database');
  return db;
}

// ========== Provider 工厂 ==========

export function createModelProvider(model: ModelRow): AIProvider {
  const baseURL = model.url.replace(/\/$/, '');
  const modelName = model.model_name;

  switch (model.api_format) {
    case API_FORMAT.ANTHROPIC: {
      const anthropicBaseURL = baseURL.replace(/\/v1$/, '');
      const client = new Anthropic({ baseURL: anthropicBaseURL, apiKey: model.api_key });
      return { type: 'anthropic', client, modelName };
    }
    case API_FORMAT.OPENAI_RESPONSES: {
      const client = new OpenAI({ baseURL, apiKey: model.api_key });
      return { type: 'openai-responses', client, modelName };
    }
    default: {
      const client = new OpenAI({ baseURL, apiKey: model.api_key });
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

// ========== 数据库模型操作 ==========

export function getAllModels(userId?: number): ModelRow[] {
  const db = getDb();
  if (userId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM models WHERE user_id = ? ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC`,
      )
      .all(userId) as ModelRow[];
  }
  return db
    .prepare(
      `SELECT * FROM models ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC`,
    )
    .all() as ModelRow[];
}

export function unlockExpiredModels(userId?: number): void {
  const now = Date.now();
  const expiredIds = getAllModels(userId)
    .filter((m) => m.isLock > 0 && now - m.isLock > LOCK_DURATION_MS)
    .map((m) => m.id);

  if (expiredIds.length > 0) {
    const db = getDb();
    const placeholders = expiredIds.map(() => '?').join(',');
    db.prepare(`UPDATE models SET isLock = 0 WHERE id IN (${placeholders})`).run(...expiredIds);
  }
}

export function getAvailableModels(userId?: number): ModelRow[] {
  unlockExpiredModels(userId);
  return getAllModels(userId).filter((m) => !m.isDisable && !isModelLocked(m.isLock).locked);
}

export function getModelByName(name: string, userId?: number): ModelRow | undefined {
  const db = getDb();
  if (userId !== undefined) {
    return db.prepare('SELECT * FROM models WHERE name = ? AND user_id = ?').get(name, userId) as ModelRow | undefined;
  }
  return db.prepare('SELECT * FROM models WHERE name = ?').get(name) as ModelRow | undefined;
}

// ========== 错误判断 ==========

/** 判断是否为"不支持多模态"类型的错误 */
export function isMultimodalNotSupportedError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return (
    /image_url/i.test(msg) ||
    /image content/i.test(msg) ||
    /multimodal/i.test(msg) ||
    /unsupported.*image/i.test(msg) ||
    /does not support.*image/i.test(msg) ||
    /invalid_request_error.*image/i.test(msg)
  );
}

// ========== 故障转移核心 ==========

export async function tryModelsSequentially<T>(
  requestModelName: string,
  tryFn: (model: ModelRow) => Promise<T> | T,
  userId?: number,
): Promise<T | null> {
  const db = getDb();
  const now = Date.now();

  let available = getAvailableModels(userId);
  if (available.length === 0) return null;

  const requestModel = available.find((m) => m.name === requestModelName);
  if (requestModel) {
    available = [requestModel, ...available.filter((m) => m.id !== requestModel.id)];
  }

  for (const model of available) {
    try {
      return await tryFn(model);
    } catch (err) {
      const error = err as Error & { status?: number; statusCode?: number };
      const status = error.status || error.statusCode || 500;
      const errMsg = (err as Error).message;

      if (status === 400 && isMultimodalNotSupportedError(err)) {
        throw err;
      }

      db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(now, model.id);
    }
  }

  return null;
}

export function getOrderedModels(requestModelName: string, userId?: number): ModelRow[] {
  const allModels = getAvailableModels(userId);
  const requestModel = allModels.find((m) => m.name === requestModelName);
  return requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;
}

// ========== previous_response_id 缓存 ==========

const responseIdCache = new Map<string, string>();
const RESPONSE_ID_CACHE_MAX = 100;

export function getCachedResponseId(baseUrl: string, modelName: string): string | undefined {
  const key = `${baseUrl}|${modelName}`;
  return responseIdCache.get(key);
}

export function setCachedResponseId(baseUrl: string, modelName: string, responseId: string): void {
  const key = `${baseUrl}|${modelName}`;
  responseIdCache.set(key, responseId);
  if (responseIdCache.size > RESPONSE_ID_CACHE_MAX) {
    const firstKey = responseIdCache.keys().next().value;
    if (firstKey) responseIdCache.delete(firstKey);
  }
}

// ========== Chat Completions 辅助 ==========

export function chatResultToChunk(
  chatResult: Record<string, unknown>,
  modelName: string,
): OpenAI.Chat.ChatCompletionChunk {
  const choice = ((chatResult.choices as Array<Record<string, unknown>>) || [{}])[0];
  const message = (choice.message || {}) as Record<string, unknown>;

  return {
    id: (chatResult.id as string) || `chatcmpl-${generateRandomString(12)}`,
    object: 'chat.completion.chunk',
    created: (chatResult.created as number) || Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: (message.content as string) || null,
        tool_calls: (message.tool_calls as Array<Record<string, unknown>>)?.map((tc, i) => ({
          index: i,
          id: tc.id as string,
          type: 'function' as const,
          function: {
            name: ((tc.function as Record<string, unknown>)?.name) as string,
            arguments: ((tc.function as Record<string, unknown>)?.arguments) as string,
          },
        })),
      },
      finish_reason: (choice.finish_reason as string) || 'stop',
    }],
    usage: chatResult.usage as OpenAI.CompletionUsage | undefined,
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

export function createSingleChunkStream<T>(chunk: T): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let emitted = false;
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (emitted) return { done: true, value: undefined as any } as any;
          emitted = true;
          return { done: false, value: chunk };
        },
      };
    },
  };
}

// ========== Anthropic ↔ OpenAI Chat 消息转换 ==========

/** OpenAI Chat 消息 → Anthropic Messages 格式 */
export function convertToAnthropicMessages(
  messages: OpenAIMessage[],
  system?: string,
): { system?: string; messages: MessageParam[] } {
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    const role = msg.role as string;

    if (role === 'system') continue;

    if (role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
      });
      continue;
    }

    if (role === 'assistant') {
      const content: MessageParam['content'] = [];
      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') content.push({ type: 'text', text: block.text as string });
        }
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') });
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
                content.push({ type: 'image', source: { type: 'base64', media_type: mediaType as any, data: base64Data } });
              } else {
                content.push({ type: 'image', source: { type: 'url', url: imageUrl } });
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

/** OpenAI Chat 消息 → 通用消息格式 */
export function convertToOpenAIChatMessages(messages: OpenAIMessage[]): GenericMessage[] {
  const result: GenericMessage[] = [];
  for (const msg of messages) {
    const role = msg.role as 'system' | 'user' | 'assistant' | 'tool';
    if (role === 'system') {
      const rawContent = msg.content;
      let systemContent: string;
      if (typeof rawContent === 'string') {
        systemContent = rawContent;
      } else if (Array.isArray(rawContent)) {
        // OpenAI content parts 数组 → 拼接 text 段
        systemContent = rawContent
          .map((part: any) => (part.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n');
      } else {
        systemContent = String(rawContent || '');
      }
      result.push({ role: 'system', content: systemContent });
      continue;
    }
    if (role === 'tool') {
      result.push({ role: 'tool', content: String(msg.content || ''), tool_call_id: msg.tool_call_id });
      continue;
    }
    if (role === 'assistant' && msg.tool_calls) {
      result.push({
        role: 'assistant',
        content: msg.content as string | null,
        tool_calls: msg.tool_calls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments } })),
      });
      continue;
    }
    result.push({ role, content: msg.content as string | null });
  }
  return result;
}

// ========== Tools 转换 ==========

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

export function mapToolChoice(toolChoice: unknown, direction: 'to-anthropic' | 'to-openai'): unknown {
  if (!toolChoice) return undefined;
  if (direction === 'to-anthropic') {
    return ConvertUtils.mapToolChoiceToAnthropic(toolChoice);
  } else {
    return ConvertUtils.mapToolChoiceToChat(toolChoice);
  }
}

// ========== Stop Sequences 映射 ==========

export function mapStopSequences(stop: unknown, direction: 'to-anthropic' | 'to-openai'): unknown {
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
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    }
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
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.input_tokens + response.usage.output_tokens },
  };
}

// ========== Chat 响应 → Anthropic 响应 ==========

export function convertOpenAIChatToAnthropicResponse(
  chatCompletion: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const result = ConvertUtils.chatResponseToAnthropicResponse(chatCompletion);
  const anthropicVersion = (requestBody.anthropic_version as string) || undefined;
  if (anthropicVersion) {
    (result as any).anthropic_version = anthropicVersion;
  }
  return result;
}

// ========== Anthropic 错误包装 ==========

export function toAnthropicError(message: string, type: string = 'api_error'): Record<string, unknown> {
  return { type: 'error', error: { type, message } };
}

// ========== Anthropic 请求 → 通用内部格式 ==========

export function convertAnthropicRequestToCommon(body: Record<string, unknown>): ChatCallParams {
  const messages: GenericMessage[] = [];
  const system = body.system;
  let systemText = '';

  if (typeof system === 'string') {
    systemText = system;
  } else if (Array.isArray(system)) {
    systemText = system.map((block: any) => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n');
  }
  if (systemText) messages.push({ role: 'system', content: systemText });

  const rawMessages = (body.messages as any[]) || [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role as string;

    if (role === 'user') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolResultBlocks = blocks.filter((b: any) => b.type === 'tool_result');
      if (toolResultBlocks.length > 0) {
        for (const tr of toolResultBlocks) {
          messages.push({ role: 'tool', content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || ''), tool_call_id: tr.tool_use_id || `call_${generateRandomString(8)}` });
        }
      } else {
        messages.push({ role: 'user', content: convertAnthropicContentBlocks(msg.content) });
      }
    } else if (role === 'assistant') {
      let textContent = '';
      const toolCalls: GenericMessage['tool_calls'] = [];
      const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
      for (const block of blocks) {
        if (block.type === 'text') textContent += (block.text || '');
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id || `call_${generateRandomString(8)}`, type: 'function', function: { name: block.name || '', arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : String(block.input || '{}') } });
        }
      }
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
      } else {
        messages.push({ role: 'assistant', content: textContent || null });
      }
    }
  }

  let tools: ChatCallParams['tools'];
  if (Array.isArray(body.tools)) {
    tools = (body.tools as any[]).map((tool) => ({ function: { name: tool.name || '', description: tool.description || '', parameters: (tool.input_schema || {}) as Record<string, unknown> } }));
  }

  const toolChoice = body.tool_choice ? (mapToolChoice(body.tool_choice, 'to-openai') as string) : undefined;
  const stop = body.stop_sequences ? (mapStopSequences(body.stop_sequences, 'to-openai') as string | string[] | undefined) : undefined;

  let maxTokens = MAX_RESPONSE_TOKENS;
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) maxTokens = Math.min(body.max_tokens, MAX_RESPONSE_TOKENS);
  const settingsMaxToken = getEffectiveMaxToken();
  if (settingsMaxToken > 0) maxTokens = settingsMaxToken;

  return { messages, maxOutputTokens: maxTokens, temperature: body.temperature as number | undefined, topP: body.top_p as number | undefined, tools, toolChoice, system: systemText || undefined };
}

function convertAnthropicContentBlocks(content: unknown): string | Array<Record<string, unknown>> | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const textParts = content.filter((block) => block.type === 'text');
  if (textParts.length > 0 && content.every((b: any) => b.type === 'text' || b.type === 'thinking')) {
    return textParts.map((b: any) => b.text || '').join('\n');
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text' && (block.text || '') !== '') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'image') {
      const source = block.source as any;
      if (source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } });
      else if (source?.type === 'url') parts.push({ type: 'image_url', image_url: { url: source.url } });
    }
  }
  return parts.length > 0 ? parts : null;
}

// ========== 非流式 API 调用 ==========

export async function callOpenAIChat(provider: AIProvider, params: ChatCallParams): Promise<OpenAI.Chat.ChatCompletion> {
  const client = provider.client as OpenAI;
  const response = await client.chat.completions.create(
    {
      model: provider.modelName,
      messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
      max_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      top_p: params.topP,
      tools: params.tools ? params.tools.map((t) => ({ type: 'function' as const, function: t.function })) : undefined,
      tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
      stream: false,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (response.choices[0]?.message?.content) {
    response.choices[0].message.content = stripThinkingTags(response.choices[0].message.content);
  }
  return response;
}

export async function callAnthropic(provider: AIProvider, params: ChatCallParams): Promise<Record<string, unknown>> {
  const response = await streamAnthropicAndCollect(provider, params);
  return convertAnthropicToChatCompletion(response, provider.modelName);
}

export async function callOpenAIResponses(provider: AIProvider, params: ChatCallParams, _originalBody: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = provider.client as OpenAI;
  const responseInput: Record<string, unknown>[] = [];

  for (const msg of params.messages) {
    if (msg.role === 'system') {
      responseInput.push({ type: 'input_text', text: String(msg.content || '') });
    } else if (msg.role === 'user') {
      // 多模态内容：拆分为扁平 input item 数组
      if (typeof msg.content === 'string') {
        responseInput.push({ type: 'input_text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text') {
            responseInput.push({ type: 'input_text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = ((part.image_url as Record<string, unknown>)?.url as string) || '';
            responseInput.push({ type: 'input_image', image_url: url, detail: 'auto' });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'output_text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text' && part.text) {
            parts.push({ type: 'output_text', text: part.text });
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) parts.push({ type: 'function_call', id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      responseInput.push({ type: 'message', role: 'assistant', content: parts });
    } else if (msg.role === 'tool') {
      responseInput.push({ type: 'function_call_output', call_id: msg.tool_call_id || '', output: msg.content || '' });
    }
  }

  const tools = params.tools?.map((t) => ({
    type: 'function',
    name: (t as any).function.name,
    description: (t as any).function.description,
    parameters: (t as any).function.parameters,
  }));

  const response = await client.responses.create(
    {
      model: provider.modelName,
      input: responseInput as any,
      max_output_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      tools: tools as any,
      stream: false,
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );

  const textParts = response.output.filter((o) => (o as unknown as { type: string }).type === 'text');
  const text = textParts.map((o) => (o as unknown as { text: string }).text).join('');
  const functionCalls = response.output.filter((o) => (o as unknown as { type: string }).type === 'function_call');
  const toolCallsArr = functionCalls.map((o) => {
    const fc = o as unknown as { call_id: string; name: string; arguments: unknown };
    return { id: fc.call_id, type: 'function' as const, function: { name: fc.name, arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments) } };
  });

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (typeof message.content === 'string') message.content = stripThinkingTags(message.content as string) || null;
  if (toolCallsArr.length > 0) { message.tool_calls = toolCallsArr; message.content = null; }

  const result: Record<string, unknown> = { id: response.id, object: 'chat.completion', created: response.created_at, model: provider.modelName, choices: [{ index: 0, message, finish_reason: toolCallsArr.length > 0 ? 'tool_calls' : 'stop' }] };
  if (response.usage) result.usage = { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.input_tokens + response.usage.output_tokens };
  return result;
}

export async function callAnthropicMessages(provider: AIProvider, params: ChatCallParams): Promise<Record<string, unknown>> {
  return streamAnthropicAndCollect(provider, params) as unknown as Record<string, unknown>;
}

async function streamAnthropicAndCollect(provider: AIProvider, params: ChatCallParams): Promise<any> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(params.messages as unknown as OpenAIMessage[], params.system);

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

  let messageId = '';
  let modelName = provider.modelName;
  const contentBlocks: Array<Record<string, unknown>> = [];
  let stopReason: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

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
      if (delta.type === 'text_delta' && delta.text) block.text = ((block.text as string) || '') + delta.text;
      else if (delta.type === 'input_json_delta' && delta.partial_json) block._partial_json = ((block._partial_json as string) || '') + delta.partial_json;
      else if (delta.type === 'thinking_delta' && delta.thinking) block.thinking = ((block.thinking as string) || '') + delta.thinking;
    }
    if (type === 'content_block_stop') {
      const idx = (event as any).index as number;
      const block = contentBlocks[idx];
      if (!block) continue;
      if (block.type === 'tool_use' && block._partial_json) {
        try { block.input = JSON.parse(block._partial_json as string); } catch { block.input = {}; }
        delete block._partial_json;
      }
    }
    if (type === 'message_delta') {
      const delta = (event as any).delta;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      if ((event as any).usage) usage = (event as any).usage;
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

/** Anthropic 流式创建，用于 /v1/messages 端点流式转发 */
export async function streamAnthropicMessages(provider: AIProvider, params: ChatCallParams): Promise<any> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(params.messages as unknown as OpenAIMessage[], params.system);
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

// ========== 模型信息构建 ==========

/** 构建 OpenAI 模型响应格式 */
export function buildOpenAIModel(model: ModelRow) {
  const capabilities = model.capabilities ? JSON.parse(model.capabilities) : ['completion', 'tools', 'thinking'];
  const effectiveContentLength = getEffectiveContentLength(model.max_content_length);
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(new Date(model.created_at).getTime() / 1000),
    owned_by: 'library',
    name: model.name,
    content_length: effectiveContentLength,
    capabilities,
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

// ========== Responses API ↔ Chat 请求转换 ==========

/**
 * Responses API 请求 → Chat Completion 请求
 */
export function convertResponsesRequestToChatRequest(body: Record<string, unknown>): Record<string, unknown> {
  return ConvertUtils.responsesRequestToChatRequest(body);
}
