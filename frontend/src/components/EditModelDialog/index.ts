import type { ModelForm } from '@/api/modelService';

export interface EditFormData extends ModelForm {
  name: string;
  model_name: string;
  url: string;
  api_key: string;
  max_content_length: number;
  max_token: number;
  sort_index: number;
  api_format: number;
  model_label_id: number | null;
  capabilities: string[];
}

// 从枚举文件统一导出
export { API_FORMAT_OPTIONS, CAPABILITIES_OPTIONS } from '@/types/enum'

export interface EditModelDialogEmits {
  (e: 'submit', id: number, data: ModelForm): void;
}
