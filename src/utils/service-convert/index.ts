import BaseProxy from "./Proxy/common/BaseProxy";

// ===== 代理类导入 =====
import ChatCompletionsProxy from './Proxy/ChatCompletionsProxy';
import ResponsesProxy from './Proxy/ResponsesProxy';
import AnthropicProxy from './Proxy/AnthropicProxy';
import ChatCompletionsToResponsesProxy from './Proxy/ChatCompletionsToResponsesProxy';
import ResponsesToChatProxy from './Proxy/ResponsesToChatProxy';
import ResponsesToAnthropicProxy from './Proxy/ResponsesToAnthropicProxy';
import AnthropicToChatProxy from './Proxy/AnthropicToChatProxy';
import AnthropicToResponsesProxy from './Proxy/AnthropicToResponsesProxy';
import ChatToAnthropicProxy from './Proxy/ChatToAnthropicProxy';
import ChatPassthroughProxy from './Proxy/ChatPassthroughProxy';

// ===== 导出代理类 =====
export { default as ChatCompletionsProxy } from './Proxy/ChatCompletionsProxy';
export { default as ResponsesProxy } from './Proxy/ResponsesProxy';
export { default as AnthropicProxy } from './Proxy/AnthropicProxy';
export { default as ChatCompletionsToResponsesProxy } from './Proxy/ChatCompletionsToResponsesProxy';
export { default as ResponsesToChatProxy } from './Proxy/ResponsesToChatProxy';
export { default as ResponsesToAnthropicProxy } from './Proxy/ResponsesToAnthropicProxy';
export { default as AnthropicToChatProxy } from './Proxy/AnthropicToChatProxy';
export { default as AnthropicToResponsesProxy } from './Proxy/AnthropicToResponsesProxy';
export { default as ChatToAnthropicProxy } from './Proxy/ChatToAnthropicProxy';
export { default as ChatPassthroughProxy } from './Proxy/ChatPassthroughProxy';

// ===== 公共类型与工具导出 =====
export { default as BaseProxy } from './Proxy/common/BaseProxy';
export * as ConvertUtils from './Proxy/common/convert-utils';
export type {
  ChatCompletionsProxyInput,
  ResponsesProxyInput,
  AnthropicProxyInput,
  SSECallbacks,
  ProxyRequestConfig,
  ChatCompletionsRequestBody,
  ResponsesRequestBody,
  AnthropicRequestBody,
  TokenUsage,
  ConnectionStatus,
  ToolCallInfo,
} from './Proxy/common/types';

// ===== 服务类型枚举 =====

export enum SERVICE_TYPE {
  'ChatCompletions' = 'Chat Completions',
  'Responses' = 'Responses',
  'Anthropic' = 'Anthropic Messages',
}

// ===== 转换器注册 =====

type ServiceConverter = {
    inputType: SERVICE_TYPE;
    outputType: SERVICE_TYPE;
    Converter: new (...args: any[]) => BaseProxy
}

// --- 纯代理（不涉及类型转换，inputType === outputType） ---

const chatCompletionsProxy: ServiceConverter = {
    inputType: SERVICE_TYPE.ChatCompletions,
    outputType: SERVICE_TYPE.ChatCompletions,
    Converter: ChatCompletionsProxy
}

const responsesProxy: ServiceConverter = {
    inputType: SERVICE_TYPE.Responses,
    outputType: SERVICE_TYPE.Responses,
    Converter: ResponsesProxy
}

const anthropicProxy: ServiceConverter = {
    inputType: SERVICE_TYPE.Anthropic,
    outputType: SERVICE_TYPE.Anthropic,
    Converter: AnthropicProxy
}

// --- Chat Completions ↔ Responses ---

const chatToResponsesConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.ChatCompletions,
    outputType: SERVICE_TYPE.Responses,
    Converter: ChatCompletionsToResponsesProxy
}

const responsesToChatConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.Responses,
    outputType: SERVICE_TYPE.ChatCompletions,
    Converter: ResponsesToChatProxy
}

// --- Anthropic ↔ Chat Completions ---

const anthropicToChatConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.Anthropic,
    outputType: SERVICE_TYPE.ChatCompletions,
    Converter: AnthropicToChatProxy
}

const chatToAnthropicConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.ChatCompletions,
    outputType: SERVICE_TYPE.Anthropic,
    Converter: ChatToAnthropicProxy
}

// --- Anthropic ↔ Responses ---

const anthropicToResponsesConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.Anthropic,
    outputType: SERVICE_TYPE.Responses,
    Converter: AnthropicToResponsesProxy
}

const responsesToAnthropicConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.Responses,
    outputType: SERVICE_TYPE.Anthropic,
    Converter: ResponsesToAnthropicProxy
}

// ===== 注册所有转换器 =====

export const serviceConverters: ServiceConverter[] = [
    // 纯代理
    chatCompletionsProxy,
    responsesProxy,
    anthropicProxy,
    // Chat Completions ↔ Responses
    chatToResponsesConverter,
    responsesToChatConverter,
    // Anthropic ↔ Chat Completions
    anthropicToChatConverter,
    chatToAnthropicConverter,
    // Anthropic ↔ Responses
    anthropicToResponsesConverter,
    responsesToAnthropicConverter,
];