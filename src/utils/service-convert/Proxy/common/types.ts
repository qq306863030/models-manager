/**
 * Service-Convert 公共类型定义
 *
 * 定义三种代理类型共用的 SSE 事件、回调、请求/响应类型。
 * 代理只负责代理转发，不涉及类型转换。
 */

// ========== SSE 事件 ==========

/** SSE 事件类型枚举 */
export enum SSEEventType {
  // Chat Completions 事件
  ChatChunk = 'chat.chunk',
  ChatDone = 'chat.done',
  ChatError = 'chat.error',

  // Responses 事件
  ResponseCreated = 'response.created',
  ResponseInProgress = 'response.in_progress',
  ResponseOutputItemAdded = 'response.output_item.added',
  ResponseContentPartAdded = 'response.content_part.added',
  ResponseOutputTextDelta = 'response.output_text.delta',
  ResponseOutputTextDone = 'response.output_text.done',
  ResponseContentPartDone = 'response.content_part.done',
  ResponseOutputItemDone = 'response.output_item.done',
  ResponseFunctionCallArgumentsDelta = 'response.function_call_arguments.delta',
  ResponseFunctionCallArgumentsDone = 'response.function_call_arguments.done',
  ResponseReasoningTextDelta = 'response.reasoning_text.delta',
  ResponseReasoningTextDone = 'response.reasoning_text.done',
  ResponseCompleted = 'response.completed',
  ResponseFailed = 'response.failed',
  ResponseError = 'response.error',
}

// ========== 通用工具调用 ==========

/** 工具调用信息（Chat Completions 和 Responses 共用） */
export interface ToolCallInfo {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ========== SSE 回调 ==========

/** SSE 流式回调 — 代理解析 SSE 流时调用 */
export interface SSECallbacks {
  /** 文本内容 delta */
  onContent?: (delta: string) => void;
  /** 思考/推理内容 delta */
  onThinking?: (delta: string) => void;
  /** 工具调用 delta（增量） */
  onToolDelta?: (delta: string, info: { id: string; index: number; name: string; field: 'name' | 'arguments' }) => void;
  /** 完整的工具调用 */
  onToolCall?: (toolCall: ToolCallInfo) => void;
  /** 流完成 */
  onDone?: () => void;
  /** 错误 */
  onError?: (error: Error) => void;
  /** Token 用量 */
  onUsage?: (usage: TokenUsage) => void;
  /** 连接状态变化 */
  onConnectionStatus?: (status: ConnectionStatus) => void;
}

// ========== Token 用量 ==========

/** Token 用量信息 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
}

// ========== 连接状态 ==========

/** 连接状态 */
export interface ConnectionStatus {
  state: 'connected' | 'streaming' | 'error' | 'clear';
  attempt?: number;
  maxAttempts?: number;
  message?: string;
}

// ========== 代理请求配置 ==========

/** 代理请求的基础配置 — 上游 API 信息 */
export interface ProxyRequestConfig {
  /** 上游 API 基础 URL */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 提供商标签（用于日志） */
  providerLabel?: string;
  /** 请求超时时间（毫秒），默认 300000 */
  timeoutMs?: number;
  /** 最大重试次数，默认 2 */
  maxRetries?: number;
}

// ========== Chat Completions 代理类型 ==========

/** Chat Completions 请求体 — 转发给上游的完整请求 */
export interface ChatCompletionsRequestBody {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Array<Record<string, unknown>> | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }>;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: string | { type: string; function?: { name: string } };
  stop?: string[];
  [key: string]: unknown;
}

/** Chat Completions 代理输入 */
export interface ChatCompletionsProxyInput {
  config: ProxyRequestConfig;
  body: ChatCompletionsRequestBody;
}

/** Chat Completions SSE chunk 类型（参考 OpenAI 规范） */
export interface ChatCompletionsStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
  };
}

// ========== Responses 代理类型 ==========

/** Responses API 请求体 — 转发给上游的完整请求 */
export interface ResponsesRequestBody {
  model: string;
  input: Array<Record<string, unknown>>;
  stream?: boolean;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    type: 'function';
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  tool_choice?: string | { type: string; name?: string };
  reasoning?: {
    effort?: 'none' | 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise' | 'detailed';
  };
  previous_response_id?: string;
  prompt_cache_key?: string;
  [key: string]: unknown;
}

/** Responses 代理输入 */
export interface ResponsesProxyInput {
  config: ProxyRequestConfig;
  body: ResponsesRequestBody;
}

/** Responses API SSE 事件类型 */
export type ResponsesStreamEvent = Record<string, unknown>;

// ========== Anthropic 代理类型 ==========

/** Anthropic Messages API 请求体 */
export interface AnthropicRequestBody {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }>;
  max_tokens: number;
  stream?: boolean;
  system?: string | Array<{ type: 'text'; text: string }>;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
  stop_sequences?: string[];
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  [key: string]: unknown;
}

/** Anthropic 代理输入 */
export interface AnthropicProxyInput {
  config: ProxyRequestConfig;
  body: AnthropicRequestBody;
}
