/**
 * 格式转换工具函数集
 *
 * 参考 cc-switch (farion1231/cc-switch) 的转换模式，提供通用的请求/响应格式转换辅助函数。
 * 这些函数是纯函数，可以被 BaseProxy 子类在 transformRequest / transformResponse 中调用。
 */

// ========== 字符串工具 ==========

/** 生成指定长度的随机字符串 */
export function generateRandomString(length = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** 估算文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

// ========== Anthropic 工具 ==========

/** x-anthropic-billing-header 的前缀标记 */
const ANTHROPIC_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

/**
 * 移除 system prompt 开头的 Anthropic billing header 行
 *
 * cc-swift 对应：`transform::strip_leading_anthropic_billing_header`
 *
 * Anthropic SDK 会自动注入形如 "x-anthropic-billing-header: cc_version=..." 的头部行，
 * 转发给非 Anthropic 上游时需要剥离。
 */
export function stripLeadingAnthropicBillingHeader(text: string): string {
  if (!text) return text;

  const lines = text.split('\n');
  const nonEmptyIndex = lines.findIndex((l) => l.trim() !== '');
  if (nonEmptyIndex >= 0) {
    const trimmed = lines[nonEmptyIndex].trim();
    if (trimmed.startsWith(ANTHROPIC_BILLING_HEADER_PREFIX)) {
      // 移除该行及其后紧跟的空行
      lines.splice(nonEmptyIndex, 1);
      // 如果下一行是空行，也移除
      if (nonEmptyIndex < lines.length && lines[nonEmptyIndex].trim() === '') {
        lines.splice(nonEmptyIndex, 1);
      }
    }
  }

  return lines.join('\n').trim();
}

// ========== 模型检测 ==========

/** OpenAI o-series 模型列表（用于 max_completion_tokens 路由） */
const O_SERIES_MODELS = new Set(['o1', 'o3', 'o4', 'o1-mini', 'o3-mini', 'o4-mini']);

/**
 * 判断是否为 OpenAI o-series 模型（需使用 max_completion_tokens 而非 max_tokens）
 *
 * cc-switch 对应：`transform::is_openai_o_series`
 */
export function isOpenAISeries(model: string): boolean {
  const base = model.toLowerCase().split('-')[0];
  return O_SERIES_MODELS.has(base);
}

// ========== Tool Choice 映射 ==========

/**
 * tool_choice 映射：Anthropic → OpenAI Chat
 *
 * cc-switch 对应：`transform::map_tool_choice_to_chat`
 *
 * Anthropic 格式：
 *   { type: "auto" | "any" | "none" | "tool", name: "xxx" }
 * OpenAI Chat 格式：
 *   "auto" | "none" | "required" | { type: "function", function: { name: "xxx" } }
 */
export function mapToolChoiceToChat(toolChoice: unknown): unknown {
  if (!toolChoice) return undefined;

  // 已是字符串格式
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any' || toolChoice === 'required') return 'required';
    return toolChoice; // auto / none
  }

  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>;
    const type = tc.type as string;

    if (type === 'tool' && tc.name) {
      return { type: 'function', function: { name: tc.name } };
    }
    if (type === 'any') return 'required';
    if (type === 'auto') return 'auto';
    if (type === 'none') return 'none';
  }

  return 'auto';
}

/**
 * tool_choice 映射：Anthropic → OpenAI Responses
 *
 * cc-switch 对应：`transform_responses::map_tool_choice_to_responses`
 *
 * Responses API 格式：
 *   "auto" | "none" | "required" | { type: "function", name: "xxx" }
 */
export function mapToolChoiceToResponses(toolChoice: unknown): unknown {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any' || toolChoice === 'required') return 'required';
    return toolChoice;
  }

  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>;
    const type = tc.type as string;

    if (type === 'tool' && tc.name) {
      return { type: 'function', name: tc.name };
    }
    if (type === 'any') return 'required';
    if (type === 'auto') return 'auto';
    if (type === 'none') return 'none';
  }

  return 'auto';
}

/**
 * tool_choice 映射：OpenAI Chat → Anthropic
 */
export function mapToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'required') return { type: 'any' };
    return { type: toolChoice as string }; // auto / none
  }

  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === 'function' && tc.function) {
      const fn = tc.function as Record<string, unknown>;
      return { type: 'tool', name: fn.name || '' };
    }
    return tc;
  }

  return { type: 'auto' };
}

// ========== Stop Sequences 映射 ==========

/**
 * stop_sequences 映射：Anthropic ↔ OpenAI
 *
 * Anthropic 格式：string[]
 * OpenAI Chat 格式：string | string[]
 */
export function mapStopSequencesToOpenAI(stop: unknown): string | string[] | undefined {
  if (!stop) return undefined;
  if (Array.isArray(stop)) {
    return stop.length === 1 ? stop[0] : stop;
  }
  if (typeof stop === 'string') return stop;
  return undefined;
}

export function mapStopSequencesToAnthropic(stop: unknown): string[] | undefined {
  if (!stop) return undefined;
  if (Array.isArray(stop)) return stop as string[];
  if (typeof stop === 'string') return [stop];
  return undefined;
}

// ========== Cache Control 清理 ==========

/**
 * 从 Anthropic 内容块中移除 cache_control 字段
 *
 * cc-switch 对应：`transform::clean_cache_control`
 * OpenAI 不支持 Anthropic 的 cache_control，转发前需移除。
 */
export function removeCacheControl(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return obj;
  const result = { ...obj };
  delete result.cache_control;
  return result;
}

/**
 * 从 tools 数组中移除 cache_control 和过滤 BatchTool
 *
 * cc-switch 对应：
 * - `transform::clean_schema`（清理 input_schema）
 * - BatchTool 过滤
 */
export function cleanTools(
  tools: unknown,
  format: 'openai-chat' | 'openai-responses' = 'openai-chat',
): unknown {
  if (!Array.isArray(tools)) return undefined;

  const cleaned = tools
    .filter((tool: any) => {
      // 过滤 BatchTool（非标准 OpenAI 工具类型）
      return tool?.type !== 'BatchTool';
    })
    .map((tool: any) => {
      if (format === 'openai-chat') {
        // Anthropic 格式 → OpenAI Chat 格式
        return {
          type: 'function',
          function: {
            name: tool.name || tool.function?.name || '',
            description: tool.description || tool.function?.description || '',
            parameters: cleanSchema(tool.input_schema || tool.parameters || tool.function?.parameters || {}),
          },
        };
      } else {
        // Anthropic 格式 → OpenAI Responses 格式
        return {
          type: 'function',
          name: tool.name || '',
          description: tool.description || '',
          parameters: cleanSchema(tool.input_schema || tool.parameters || {}),
        };
      }
    });

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 清理 JSON Schema — 移除 Anthropic 特有的字段
 *
 * cc-switch 对应：`transform::clean_schema`
 */
export function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema ?? {};

  const result = removeCacheControl(schema);

  // 处理嵌套属性
  if (result.properties && typeof result.properties === 'object') {
    const cleanedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.properties as Record<string, unknown>)) {
      cleanedProps[key] = typeof value === 'object' && value !== null
        ? cleanSchema(value as Record<string, unknown>)
        : value;
    }
    result.properties = cleanedProps;
  }

  return result;
}

// ========== JSON 工具 ==========

/**
 * 将值规范化为 JSON 字符串（用于工具调用的 arguments 序列化）
 *
 * cc-switch 对应：`canonical_json_string`
 */
export function canonicalJsonString(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') {
    try {
      // 已经是合法 JSON 对象字符串，重新 stringify 以规范化
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

// ========== Token 用量映射 ==========

/**
 * 将 OpenAI Chat usage 映射为 Anthropic usage 格式
 *
 * cc-switch 对应：`openai_to_anthropic` 中的 usage 映射逻辑
 *
 * OpenAI prompt_tokens 含缓存命中，Anthropic input_tokens 不含
 * → 减去 cache_read + cache_creation
 */
export function mapChatUsageToAnthropic(usage: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);

  // 从 nested 字段读取缓存命中
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = Number(
    usage.cache_read_input_tokens
      ?? details?.cached_tokens
      ?? 0,
  );
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);

  const inputTokens = Math.max(0, promptTokens - cached - cacheCreation);

  const result: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: completionTokens,
  };

  if (cached > 0) result.cache_read_input_tokens = cached;
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation;

  return result;
}

/**
 * 将 OpenAI Responses usage 映射为 Anthropic usage 格式
 *
 * Responses API 的 usage 字段命名与 Anthropic 一致（input_tokens/output_tokens），
 * 但 flat 结构不同。
 */
export function mapResponsesUsageToAnthropic(usage: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const result: Record<string, unknown> = {
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
  };

  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  if (details?.cached_tokens) {
    result.cache_read_input_tokens = Number(details.cached_tokens);
  }

  return result;
}

// ========== 响应 stop_reason 映射 ==========

/**
 * OpenAI Chat finish_reason → Anthropic stop_reason
 */
export function mapFinishReasonToStopReason(finishReason: string | null | undefined): string | null {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'content_filtered';
    default:
      return finishReason ?? null;
  }
}

/**
 * Anthropic stop_reason → OpenAI Chat finish_reason
 */
export function mapStopReasonToFinishReason(stopReason: string | null | undefined): string | null {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return stopReason ?? null;
  }
}

/**
 * OpenAI Responses status → Anthropic stop_reason
 *
 * cc-switch 对应：`transform_responses::map_responses_stop_reason`
 */
export function mapResponsesStatusToStopReason(
  status: string | null | undefined,
  hasToolUse: boolean,
  incompleteReason?: string | null,
): string | null {
  if (status === 'completed') {
    return hasToolUse ? 'tool_use' : 'end_turn';
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_tokens') return 'max_tokens';
    if (incompleteReason === 'content_filter') return 'content_filtered';
    return 'max_tokens';
  }
  if (status === 'failed') return 'error';
  return null;
}

// ========================================================================
// 完整的请求/响应格式转换函数（参考 cc-switch 核心转换逻辑）
// ========================================================================

// ========== Anthropic → Chat Completions ==========

/**
 * Anthropic Messages 请求 → OpenAI Chat Completions 请求
 *
 * cc-switch 对应：`anthropic_to_openai_with_reasoning_content`
 *
 * 核心转换：
 * - system 字符串/数组 → system role message
 * - messages 中的 tool_use → assistant message.tool_calls
 * - messages 中的 tool_result → tool role message
 * - messages 中的 image → image_url content part
 * - messages 中的 thinking → reasoning_content（可选）
 * - tools: input_schema → parameters
 * - tool_choice 映射
 * - max_tokens → max_tokens / max_completion_tokens (o-series)
 */
export function anthropicRequestToChatRequest(
  body: Record<string, unknown>,
  preserveReasoning = false,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // model
  if (body.model) result.model = body.model;

  const messages: Array<Record<string, unknown>> = [];

  // system prompt → system message
  if (body.system) {
    const extractText = (sys: unknown): string => {
      if (typeof sys === 'string') {
        return stripLeadingAnthropicBillingHeader(sys);
      }
      if (Array.isArray(sys)) {
        return sys
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text || '')
          .join('\n\n')
          .trim();
      }
      return '';
    };
    const systemText = extractText(body.system);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // messages 转换
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role as string;
      const content = msg.content;

      // 纯字符串
      if (typeof content === 'string') {
        messages.push({ role, content });
        continue;
      }

      if (!Array.isArray(content)) {
        messages.push({ role, content: content ?? null });
        continue;
      }

      // 数组内容块处理
      const contentParts: Array<Record<string, unknown>> = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      const reasoningParts: string[] = [];

      for (const block of content) {
        const type = block.type as string;

        switch (type) {
          case 'text':
            contentParts.push({ type: 'text', text: block.text });
            break;

          case 'image':
            if (block.source) {
              const src = block.source as Record<string, unknown>;
              if (src.type === 'base64') {
                contentParts.push({
                  type: 'image_url',
                  image_url: { url: `data:${src.media_type};base64,${src.data}` },
                });
              } else if (src.type === 'url') {
                contentParts.push({
                  type: 'image_url',
                  image_url: { url: src.url },
                });
              }
            }
            break;

          case 'tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: canonicalJsonString(block.input),
              },
            });
            break;

          case 'tool_result': {
            // tool_result → tool role message
            const resultContent = block.content;
            let text: string;
            if (typeof resultContent === 'string') {
              text = resultContent;
            } else if (resultContent && typeof resultContent === 'object') {
              text = JSON.stringify(resultContent);
            } else {
              text = String(resultContent ?? '');
            }
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: text,
            });
            break;
          }

          case 'thinking':
            if (preserveReasoning && block.thinking) {
              reasoningParts.push(block.thinking as string);
            }
            break;

          default:
            // 未知块跳过
            break;
        }
      }

      // 构建 assistant 消息
      if (role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant' };
        if (contentParts.length === 0 && toolCalls.length === 0) {
          msg.content = null;
        } else if (contentParts.length === 1 && contentParts[0].type === 'text') {
          msg.content = (contentParts[0] as any).text;
        } else if (contentParts.length > 0) {
          msg.content = contentParts;
        } else {
          msg.content = null;
        }
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        if (preserveReasoning && reasoningParts.length > 0) {
          (msg as any).reasoning_content = reasoningParts.join('\n');
        }
        messages.push(msg);
      } else {
        // user 消息
        if (contentParts.length === 1 && contentParts[0].type === 'text') {
          messages.push({ role: 'user', content: (contentParts[0] as any).text });
        } else if (contentParts.length > 0) {
          messages.push({ role: 'user', content: contentParts });
        }
      }
    }
  }

  result.messages = messages;

  // max_tokens → max_tokens / max_completion_tokens
  if (body.max_tokens !== undefined) {
    const model = (body.model as string) || '';
    if (isOpenAISeries(model)) {
      result.max_completion_tokens = body.max_tokens;
    } else {
      result.max_tokens = body.max_tokens;
    }
  }

  // temperature / top_p
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const chatTools = body.tools
      .filter((t: any) => t.type !== 'BatchTool')
      .map((t: any) => ({
        type: 'function',
        function: {
          name: t.name || '',
          description: t.description || '',
          parameters: cleanSchema(t.input_schema || {}),
        },
      }));
    if (chatTools.length > 0) result.tools = chatTools;
  }

  // tool_choice
  if (body.tool_choice) {
    result.tool_choice = mapToolChoiceToChat(body.tool_choice);
  }

  // stop_sequences → stop
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences.length === 1
      ? body.stop_sequences[0]
      : body.stop_sequences;
  }

  // stream
  if (body.stream !== undefined) result.stream = body.stream;

  return result;
}

/**
 * OpenAI Chat Completions 响应 → Anthropic Messages 响应
 *
 * cc-switch 对应：`openai_to_anthropic`
 *
 * 核心转换：
 * - choices[0].message.content → content text block
 * - choices[0].message.tool_calls → content tool_use blocks
 * - choices[0].message.reasoning_content → content thinking block
 * - finish_reason → stop_reason
 * - usage (减去 cache tokens)
 */
export function chatResponseToAnthropicResponse(
  chatResponse: Record<string, unknown>,
): Record<string, unknown> {
  const choices = chatResponse.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;

  // reasoning_content → thinking block
  if (message?.reasoning_content) {
    const reasoning = message.reasoning_content as string;
    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning });
    }
  }

  // content → text block
  if (typeof message?.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message?.content)) {
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && part.text) {
        content.push({ type: 'text', text: part.text });
      }
    }
  }

  // tool_calls → tool_use blocks
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
      hasToolUse = true;
      const fn = tc.function as Record<string, unknown> | undefined;
      let input: unknown = {};
      try {
        input = JSON.parse((fn?.arguments as string) || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: fn?.name || '',
        input,
      });
    }
  }

  // 兼容旧格式 function_call
  if (!hasToolUse && message?.function_call) {
    const fc = message.function_call as Record<string, unknown>;
    let input: unknown = {};
    try {
      input = JSON.parse((fc.arguments as string) || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: fc.id || '',
      name: fc.name || '',
      input,
    });
    hasToolUse = true;
  }

  // finish_reason → stop_reason
  const finishReason = choice?.finish_reason as string | undefined;
  const stopReason = hasToolUse ? 'tool_use' : mapFinishReasonToStopReason(finishReason);

  // usage 映射（减去 cache tokens）
  const usage = mapChatUsageToAnthropic(chatResponse.usage as Record<string, unknown> | undefined);

  return {
    id: chatResponse.id || `msg_${generateRandomString(24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: chatResponse.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ========== Anthropic → Responses ==========

/**
 * Anthropic Messages 请求 → OpenAI Responses 请求
 *
 * cc-switch 对应：`anthropic_to_responses`
 *
 * 核心转换：
 * - system → instructions
 * - messages → input items (tool_use 提升为 function_call, tool_result 提升为 function_call_output)
 * - max_tokens → max_output_tokens
 * - tools: input_schema → parameters（过滤 BatchTool）
 * - tool_choice 映射
 */
export function anthropicRequestToResponsesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // model
  if (body.model) result.model = body.model;

  // system → instructions
  if (body.system) {
    const extractText = (sys: unknown): string => {
      if (typeof sys === 'string') {
        return stripLeadingAnthropicBillingHeader(sys);
      }
      if (Array.isArray(sys)) {
        return sys
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text || '')
          .join('\n\n')
          .trim();
      }
      return '';
    };
    const instructions = extractText(body.system);
    if (instructions) result.instructions = instructions;
  }

  // messages → input items
  const input: Array<Record<string, unknown>> = [];
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role as string;
      const content = msg.content;

      // 纯字符串
      if (typeof content === 'string') {
        const contentType = role === 'assistant' ? 'output_text' : 'input_text';
        input.push({
          type: 'message',
          role,
          content: [{ type: contentType, text: content }],
          status: 'completed',
        });
        continue;
      }

      if (!Array.isArray(content)) continue;

      // 收集当前消息的文本内容和工具块
      const textParts: Array<Record<string, unknown>> = [];

      for (const block of content) {
        const type = block.type as string;

        if (type === 'text') {
          const contentType = role === 'assistant' ? 'output_text' : 'input_text';
          textParts.push({ type: contentType, text: block.text });
        } else if (type === 'tool_use') {
          // 先刷新文本内容
          if (textParts.length > 0) {
            input.push({
              type: 'message',
              role,
              content: textParts.splice(0),
              status: 'completed',
            });
          }
          // tool_use → 独立的 function_call item
          input.push({
            type: 'function_call',
            id: block.id || `fc_${generateRandomString(12)}`,
            call_id: block.id || `call_${generateRandomString(12)}`,
            name: block.name || '',
            arguments: canonicalJsonString(block.input),
            status: 'completed',
          });
        } else if (type === 'tool_result') {
          // 先刷新文本内容
          if (textParts.length > 0) {
            input.push({
              type: 'message',
              role,
              content: textParts.splice(0),
              status: 'completed',
            });
          }
          // tool_result → 独立的 function_call_output item
          let output: string;
          if (typeof block.content === 'string') {
            output = block.content;
          } else if (block.content && typeof block.content === 'object') {
            output = JSON.stringify(block.content);
          } else {
            output = String(block.content ?? '');
          }
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id || '',
            output,
            status: 'completed',
          });
        }
        // thinking → 丢弃
      }

      // 刷新剩余文本
      if (textParts.length > 0) {
        input.push({
          type: 'message',
          role,
          content: textParts,
          status: 'completed',
        });
      }
    }
  }
  result.input = input;

  // max_tokens → max_output_tokens
  if (body.max_tokens !== undefined) {
    result.max_output_tokens = body.max_tokens;
  }

  // temperature / top_p
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // tools（过滤 BatchTool）
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const responseTools = body.tools
      .filter((t: any) => t.type !== 'BatchTool')
      .map((t: any) => ({
        type: 'function',
        name: t.name || '',
        description: t.description || '',
        parameters: cleanSchema(t.input_schema || {}),
      }));
    if (responseTools.length > 0) result.tools = responseTools;
  }

  // tool_choice
  if (body.tool_choice) {
    result.tool_choice = mapToolChoiceToResponses(body.tool_choice);
  }

  // stream
  if (body.stream !== undefined) result.stream = body.stream;

  return result;
}

/**
 * OpenAI Responses 响应 → Anthropic Messages 响应
 *
 * cc-switch 对应：`responses_to_anthropic`
 *
 * 核心转换：
 * - output message → content text blocks
 * - output function_call → tool_use blocks
 * - output reasoning → thinking blocks
 * - status → stop_reason
 * - usage 映射
 */
export function responsesResponseToAnthropicResponse(
  responsesResponse: Record<string, unknown>,
): Record<string, unknown> {
  const output = responsesResponse.output as Array<Record<string, unknown>> | undefined;
  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;

  if (Array.isArray(output)) {
    for (const item of output) {
      const itemType = item.type as string;

      switch (itemType) {
        case 'message': {
          // message.content → text blocks
          const msgContent = item.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              const blockType = block.type as string;
              if (blockType === 'output_text' && block.text) {
                content.push({ type: 'text', text: block.text });
              }
              if ((blockType === 'reasoning_text' || blockType === 'summary_text') && block.text) {
                content.push({ type: 'thinking', thinking: block.text });
              }
              if (blockType === 'refusal' && block.refusal) {
                content.push({ type: 'text', text: block.refusal });
              }
            }
          }
          break;
        }

        case 'function_call':
          hasToolUse = true;
          let input: unknown = {};
          try {
            input = JSON.parse((item.arguments as string) || '{}');
          } catch {
            input = {};
          }
          content.push({
            type: 'tool_use',
            id: item.call_id || item.id || '',
            name: item.name || '',
            input,
          });
          break;

        case 'reasoning': {
          // reasoning.summary → thinking block
          const summaries = item.summary as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(summaries)) {
            const thinkingText = summaries
              .filter((s) => s.type === 'summary_text' && s.text)
              .map((s) => s.text)
              .join('');
            if (thinkingText) {
              content.push({ type: 'thinking', thinking: thinkingText });
            }
          }
          break;
        }
      }
    }
  }

  // status → stop_reason
  const status = responsesResponse.status as string | undefined;
  const incompleteReason = (responsesResponse.incomplete_details as Record<string, unknown>)?.reason as string | undefined;
  const stopReason = mapResponsesStatusToStopReason(status, hasToolUse, incompleteReason);

  // usage 映射
  const usage = mapResponsesUsageToAnthropic(responsesResponse.usage as Record<string, unknown> | undefined);

  return {
    id: responsesResponse.id || `msg_${generateRandomString(24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: responsesResponse.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

/**
 * Responses API 请求 → Chat Completions 请求
 *
 * cc-switch 对应：`responses_to_chat_completions_with_reasoning`
 *
 * 核心转换：
 * - instructions → system message
 * - input items → messages（function_call → assistant tool_calls, function_call_output → tool messages）
 * - max_output_tokens → max_tokens / max_completion_tokens (o-series)
 * - reasoning → reasoning_effort
 */
export function responsesRequestToChatRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // model
  if (body.model) result.model = body.model;

  const messages: Array<Record<string, unknown>> = [];

  // instructions → system message
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // input → messages
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;

      const type = item.type as string;

      switch (type) {
        case 'function_call_output':
          messages.push({
            role: 'tool',
            tool_call_id: (item.call_id || item.id || 'call_0') as string,
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          });
          break;

        case 'function_call':
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: (item.call_id || item.id) as string,
              type: 'function',
              function: {
                name: item.name as string,
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
              },
            }],
          });
          break;

        case 'message': {
          const role = (item.role === 'developer' ? 'system' : item.role) as string || 'user';
          const msgContent = item.content;
          if (typeof msgContent === 'string') {
            messages.push({ role, content: msgContent });
          } else if (Array.isArray(msgContent)) {
            // 提取文本部分
            const textParts = msgContent
              .filter((p: any) => p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')
              .map((p: any) => p.text || '')
              .join('');
            if (textParts) messages.push({ role, content: textParts });
          }
          break;
        }

        default:
          // 其他类型尝试按 role 消息处理
          if (item.role) {
            messages.push({
              role: item.role === 'developer' ? 'system' : item.role,
              content: item.content || item.text || '',
            });
          }
          break;
      }
    }
  }

  result.messages = messages;

  // max_output_tokens → max_tokens
  if (body.max_output_tokens !== undefined) {
    const model = (body.model as string) || '';
    if (isOpenAISeries(model)) {
      result.max_completion_tokens = body.max_output_tokens;
    } else {
      result.max_tokens = body.max_output_tokens;
    }
  }

  // temperature / top_p
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const chatTools = body.tools
      .filter((t: any) => t.type === 'function')
      .map((t: any) => ({
        type: 'function',
        function: {
          name: t.name || '',
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      }));
    if (chatTools.length > 0) result.tools = chatTools;
  }

  // tool_choice
  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string') {
      result.tool_choice = body.tool_choice;
    } else {
      const tc = body.tool_choice as Record<string, unknown>;
      if (tc.type === 'function' && tc.name) {
        result.tool_choice = { type: 'function', function: { name: tc.name } };
      } else {
        result.tool_choice = tc.type || 'auto';
      }
    }
  }

  // reasoning → reasoning_effort
  if (body.reasoning && typeof body.reasoning === 'object') {
    const reasoning = body.reasoning as Record<string, unknown>;
    if (reasoning.effort) {
      const effortMap: Record<string, string> = {
        none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'high',
      };
      result.reasoning_effort = effortMap[reasoning.effort as string] || reasoning.effort;
    }
  }

  // stream
  if (body.stream !== undefined) result.stream = body.stream;

  return result;
}

/**
 * Chat Completions 响应 → Responses API 响应
 *
 * cc-switch 对应：`chat_completion_to_response`
 *
 * 核心转换：
 * - choices[0].message.content → output message with output_text
 * - choices[0].message.tool_calls → output function_call items
 * - finish_reason → status
 * - usage 映射
 */
export function chatResponseToResponsesResponse(
  chatResponse: Record<string, unknown>,
  requestBody?: Record<string, unknown>,
): Record<string, unknown> {
  const choice = (chatResponse.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  // tool_calls → function_call items
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, unknown> | undefined;
      output.push({
        id: tc.id || `fc_${generateRandomString(12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: tc.id || `call_${generateRandomString(12)}`,
        name: fn?.name || '',
        arguments: fn?.arguments || '{}',
      });
    }
  }

  // content → output message
  if (typeof message?.content === 'string' && message.content) {
    output.push({
      id: `msg_${generateRandomString(12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }

  // finish_reason → status
  const finishReason = choice?.finish_reason as string | undefined;
  const status = finishReason === 'tool_calls' ? 'completed' : 'completed';

  return {
    id: (chatResponse.id as string) || `resp_${generateRandomString(12)}`,
    object: 'response',
    created_at: (chatResponse.created as number) || Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: requestBody?.instructions || null,
    max_output_tokens: requestBody?.max_output_tokens || requestBody?.max_tokens || null,
    model: (chatResponse.model as string) || requestBody?.model || '',
    output,
    output_text: output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content as Array<any>) || [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join(''),
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    previous_response_id: requestBody?.previous_response_id || null,
    reasoning: requestBody?.reasoning || null,
    store: requestBody?.store ?? false,
    temperature: requestBody?.temperature ?? null,
    text: requestBody?.text || { format: { type: 'text' } },
    tool_choice: requestBody?.tool_choice || 'auto',
    tools: requestBody?.tools || [],
    top_p: requestBody?.top_p ?? null,
    truncation: requestBody?.truncation || 'disabled',
    usage: chatResponse.usage || null,
  };
}

// ========== Chat Completions → Anthropic Messages ==========

/**
 * OpenAI Chat Completions 请求 → Anthropic Messages API 请求
 *
 * 对应 musistudio/llms 的 `convertFromOpenAI` + `convertToolsToAnthropic`
 *
 * 核心转换：
 * - system messages 提取为顶层 system 字段
 * - assistant tool_calls → tool_use blocks
 * - tool messages → tool_result blocks
 * - max_tokens / max_completion_tokens → max_tokens
 * - reasoning_effort → thinking budget
 */
export function chatRequestToAnthropicRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // model
  if (body.model) result.model = body.model;

  // messages
  const systemParts: string[] = [];
  const anthropicMessages: Array<Record<string, unknown>> = [];
  const messages = body.messages as Array<Record<string, unknown>> | undefined;

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const role = msg.role as string;

      // system → 提取到顶层
      if (role === 'system') {
        if (typeof msg.content === 'string') {
          systemParts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content as Array<Record<string, unknown>>) {
            if (part.type === 'text' && part.text) {
              systemParts.push(part.text as string);
            }
          }
        }
        continue;
      }

      // tool → tool_result block
      if (role === 'tool') {
        // 找上一个 assistant 消息，如果包含 tool_calls 则合并
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          // 将 tool 添加到前一条 user 消息中（tool_result 必须放在 user role 下）
          const toolResult: Record<string, unknown> = {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id as string || '',
            content: msg.content as string || '',
          };

          // 找最后一个 user 消息追加，或创建新的 user 消息
          const lastUserIdx = findLastIndex(anthropicMessages, (m) => m.role === 'user');
          if (lastUserIdx >= 0) {
            const userMsg = anthropicMessages[lastUserIdx];
            const userContent = userMsg.content;
            if (Array.isArray(userContent)) {
              userContent.push(toolResult);
            } else {
              userMsg.content = [toolResult];
            }
          } else {
            anthropicMessages.push({ role: 'user', content: [toolResult] });
          }
        }
        continue;
      }

      // assistant / user
      if (typeof msg.content === 'string') {
        anthropicMessages.push({ role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 多模态内容
        const blocks: Array<Record<string, unknown>> = [];
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = ((part.image_url as any)?.url as string) || '';
            if (url.startsWith('data:')) {
              const [header, data] = url.split(',');
              const mediaType = header.replace('data:', '').split(';')[0];
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data },
              });
            } else {
              blocks.push({
                type: 'image',
                source: { type: 'url', url },
              });
            }
          }
        }
        if (blocks.length > 0) {
          anthropicMessages.push({ role, content: blocks });
        }
      }

      // assistant tool_calls → tool_use blocks
      if (role === 'assistant') {
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const lastMsg = anthropicMessages[anthropicMessages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            // 追加到已有 assistant 消息
            const content = lastMsg.content;
            const blocks = Array.isArray(content) ? content : [];
            for (const tc of toolCalls) {
              let input: unknown = {};
              try {
                input = JSON.parse((tc.function as any)?.arguments || '{}');
              } catch { /* ignore */ }
              blocks.push({
                type: 'tool_use',
                id: tc.id,
                name: (tc.function as any)?.name || '',
                input,
              });
            }
            lastMsg.content = blocks;
          }
        }
      }
    }
  }

  // system
  if (systemParts.length > 0) {
    result.system = systemParts.join('\n\n');
  }

  result.messages = anthropicMessages;

  // max_tokens / max_completion_tokens → max_tokens
  result.max_tokens = (body.max_completion_tokens as number) || (body.max_tokens as number) || 4096;

  // temperature / top_p
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // tools
  if (Array.isArray(body.tools)) {
    const anthropicTools = (body.tools as Array<Record<string, unknown>>)
      .filter((t) => t.type === 'function')
      .map((t) => {
        const fn = t.function as Record<string, unknown> | undefined;
        return {
          name: fn?.name || '',
          description: fn?.description || '',
          input_schema: fn?.parameters || { type: 'object', properties: {} },
        };
      });
    if (anthropicTools.length > 0) result.tools = anthropicTools;
  }

  // tool_choice
  if (body.tool_choice) {
    if (typeof body.tool_choice === 'string') {
      if (body.tool_choice === 'required') {
        result.tool_choice = { type: 'any' };
      } else if (body.tool_choice === 'auto' || body.tool_choice === 'none') {
        result.tool_choice = { type: body.tool_choice };
      }
    } else {
      const tc = body.tool_choice as Record<string, unknown>;
      if (tc.type === 'function' && tc.function) {
        const fn = tc.function as Record<string, unknown>;
        result.tool_choice = { type: 'tool', name: fn.name as string };
      } else {
        result.tool_choice = tc;
      }
    }
  }

  // reasoning_effort → thinking
  if (body.reasoning_effort) {
    const effortMap: Record<string, number> = {
      none: 0, low: 1024, medium: 4096, high: 16384,
    };
    result.thinking = {
      type: 'enabled',
      budget_tokens: effortMap[body.reasoning_effort as string] || 4096,
    };
  }

  // stop → stop_sequences
  if (body.stop) {
    result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }

  // stream
  if (body.stream !== undefined) result.stream = body.stream;

  return result;
}

// ========== Chat SSE → Anthropic SSE 流式转换 ==========

/**
 * Chat Completions SSE 流 → Anthropic SSE 事件生成器
 *
 * 对应 musistudio/llms 的 `convertOpenAIStreamToAnthropic`
 *
 * 将 Chat SSE chunks 实时转换为 Anthropic SSE 事件（text_delta, content_block_* 等）。
 * 用法：在 parseChatCompletionsStream 的 callbacks 中调用这些方法。
 */
export class ChatToAnthropicStreamConverter {
  private messageId: string;
  private model: string = '';
  private hasStarted = false;
  private hasTextContentStarted = false;
  private hasFinished = false;
  private contentBlockIndex = 0;
  private currentContentBlockIndex = -1;
  private pendingToolCalls = new Map<number, {
    id: string; name: string; arguments: string; contentBlockIndex: number;
  }>();
  private textBuffer = '';
  private accumulatedUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private finalStopReason: string = 'end_turn';
  private encoder = new TextEncoder();

  /** 获取 SSE event 的 encoder */
  get encoder_(): TextEncoder { return this.encoder; }

  constructor() {
    this.messageId = `msg_${generateRandomString(24)}`;
  }

  /**
   * 处理 Chat SSE chunk，返回 Anthropic SSE 事件字节数组
   * @returns Uint8Array[] 需要写入响应的 Anthropic SSE 事件
   */
  processChatChunk(chunk: Record<string, unknown>): Uint8Array[] {
    if (this.hasFinished) return [];

    const events: Uint8Array[] = [];
    const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) return events;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return events;

    this.model = (chunk.model as string) || this.model;

    // ====== 1. message_start ======
    if (!this.hasStarted) {
      this.hasStarted = true;
      events.push(this._encode({ type: 'message_start', message: {
        id: this.messageId, type: 'message', role: 'assistant',
        content: [], model: this.model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}));
    }

    // ====== 2. Thinking delta ======
    if (delta.reasoning_content || (delta as any).thinking) {
      const thinkingText = (delta.reasoning_content || (delta as any).thinking) as string;
      if (thinkingText) {
        events.push(...this._ensureTextBlock(false));
        events.push(this._encode({
          type: 'content_block_delta', index: this.currentContentBlockIndex,
          delta: { type: 'thinking_delta', thinking: thinkingText },
        }));
      }
    }

    // ====== 3. Text delta ======
    if (delta.content) {
      const text = delta.content as string;
      this.textBuffer += text;
      events.push(...this._ensureTextBlock(true));
      events.push(this._encode({
        type: 'content_block_delta', index: this.currentContentBlockIndex,
        delta: { type: 'text_delta', text },
      }));
    }

    // ====== 4. Tool call deltas ======
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = tc.index as number;
        let pending = this.pendingToolCalls.get(idx);

        // 关闭文本块
        events.push(...this._closeTextBlock());

        if (!pending && tc.id) {
          // 新工具调用 → content_block_start (tool_use)
          const blockIdx = this.contentBlockIndex++;
          pending = {
            id: tc.id as string,
            name: (tc.function as any)?.name as string || '',
            arguments: '',
            contentBlockIndex: blockIdx,
          };
          this.pendingToolCalls.set(idx, pending);

          events.push(this._encode({
            type: 'content_block_start', index: blockIdx,
            content_block: { type: 'tool_use', id: pending.id, name: pending.name, input: {} },
          }));
        }

        if (pending) {
          if ((tc.function as any)?.name) {
            pending.name += (tc.function as any).name as string;
          }
          if ((tc.function as any)?.arguments) {
            pending.arguments += (tc.function as any).arguments as string;
            events.push(this._encode({
              type: 'content_block_delta', index: pending.contentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: (tc.function as any).arguments as string },
            }));
          }
        }
      }
    }

    // ====== 5. Usage ======
    if (chunk.usage) {
      const u = chunk.usage as Record<string, unknown>;
      const cached = (u.prompt_tokens_details as Record<string, unknown>)?.cached_tokens as number || 0;
      this.accumulatedUsage = {
        input_tokens: (u.prompt_tokens as number || 0) - cached,
        output_tokens: u.completion_tokens as number || 0,
        cache_read_input_tokens: cached,
      };
    }

    // ====== 6. Finish reason → message_delta ======
    if (choice.finish_reason && choice.finish_reason !== null) {
      this.hasFinished = true;
      const fr = choice.finish_reason as string;
      this.finalStopReason = fr === 'stop' ? 'end_turn'
        : fr === 'length' ? 'max_tokens'
        : fr === 'tool_calls' ? 'tool_use'
        : fr === 'content_filter' ? 'content_filtered'
        : 'end_turn';

      // 关闭所有打开的内容块
      events.push(...this._closeTextBlock());
      for (const [_, tc] of this.pendingToolCalls) {
        events.push(this._encode({ type: 'content_block_stop', index: tc.contentBlockIndex }));
      }
      this.pendingToolCalls.clear();

      // message_delta
      events.push(this._encode({
        type: 'message_delta',
        delta: { stop_reason: this.finalStopReason, stop_sequence: null },
        usage: this.accumulatedUsage || { input_tokens: 0, output_tokens: 0 },
      }));

      // message_stop
      events.push(this._encode({ type: 'message_stop' }));
    }

    return events;
  }

  /** 处理 [DONE] 标记 */
  processDone(): Uint8Array[] {
    if (this.hasFinished) return [];
    this.hasFinished = true;

    const events: Uint8Array[] = [];
    events.push(...this._closeTextBlock());
    for (const [_, tc] of this.pendingToolCalls) {
      events.push(this._encode({ type: 'content_block_stop', index: tc.contentBlockIndex }));
    }
    this.pendingToolCalls.clear();

    events.push(this._encode({
      type: 'message_delta',
      delta: { stop_reason: this.finalStopReason, stop_sequence: null },
      usage: this.accumulatedUsage || { input_tokens: 0, output_tokens: 0 },
    }));
    events.push(this._encode({ type: 'message_stop' }));
    return events;
  }

  get messageId_(): string { return this.messageId; }
  get finalStopReason_(): string { return this.finalStopReason; }

  // ====== 内部辅助 ======

  private _encode(data: unknown): Uint8Array {
    const json = JSON.stringify(data);
    return this.encoder.encode(`event: ${(data as any).type}\ndata: ${json}\n\n`);
  }

  private _ensureTextBlock(isText: boolean): Uint8Array[] {
    if (isText && this.currentContentBlockIndex < 0 && !this.hasFinished) {
      const idx = this.contentBlockIndex++;
      this.currentContentBlockIndex = idx;
      this.hasTextContentStarted = true;
      return [this._encode({
        type: 'content_block_start', index: idx,
        content_block: { type: 'text', text: '' },
      })];
    }
    if (!isText && this.currentContentBlockIndex >= 0) {
      return this._closeTextBlock();
    }
    return [];
  }

  private _closeTextBlock(): Uint8Array[] {
    if (this.currentContentBlockIndex >= 0) {
      const idx = this.currentContentBlockIndex;
      this.currentContentBlockIndex = -1;
      return [this._encode({ type: 'content_block_stop', index: idx })];
    }
    return [];
  }
}

// ========== 数组工具 ==========

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
