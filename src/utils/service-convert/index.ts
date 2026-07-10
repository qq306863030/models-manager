import BaseProxy from "./Proxy/common/BaseProxy";
import ChatCompletionsToResponsesProxy from './Proxy/ChatCompletionsToResponsesProxy';

export enum SERVICE_TYPE {
  'ChatCompletions' = 'Chat Completions',
  'Responses' = 'Responses',
  'Anthropic' = 'Anthropic Messages',
}

type ServiceConverter = {
    inputType: SERVICE_TYPE;
    outputType: SERVICE_TYPE;
    // 输入是接口调用者的请求，输出是接口调用者的响应
    Converter: typeof BaseProxy
}

const completionsToResponsesConverter: ServiceConverter = {
    inputType: SERVICE_TYPE.ChatCompletions,
    outputType: SERVICE_TYPE.Responses,
    Converter: ChatCompletionsToResponsesProxy
}

export const serviceConverters: ServiceConverter[] = [
    completionsToResponsesConverter
];