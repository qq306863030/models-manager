import request from './models';
import type { ApiFormat } from '@/types/enum';

export interface LlmModelItem {
  model: string;
  content_length: string;
  max_token: string;
  capabilities: string[];
}

export interface LlmCompany {
  llmCompany: string;
  api_format: ApiFormat;
  url: string;
  models: LlmModelItem[];
}

export const getLlmModels = () => {
  return request.get<{ success: boolean; data: LlmCompany[] }>('/llm-models');
};
