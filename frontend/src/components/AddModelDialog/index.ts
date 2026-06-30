import type { ModelRowForm } from '@/api/modelService';

export interface ModelLabelOption {
  id: number;
  name: string;
}

// 弹窗行数据
export interface AddFormRow {
  key: number;
  model_label_id: number | null;   // 数据库中的模型Label ID（可选）
  model_label: string;              // 模型Label（用户可输入，显示 [名称]_[模型名称] 合并结果）
  model_name: string;               // 模型名称（下拉搜索选择或手动输入）
  max_content_length: number;
  max_token: number;
  capabilities: string[];
}

export interface AddFormData {
  vendor: string;      // '' | 'custom' | llmCompany 值
  name: string;        // 名称前缀（可选）
  url: string;
  api_key: string;
  api_format: number;
  rows: AddFormRow[];
}

// 从枚举文件统一导出
export { API_FORMAT_OPTIONS } from '@/types/enum'
export { CAPABILITIES_OPTIONS, DEFAULT_CAPABILITIES } from '@/types/enum'

export interface AddModelDialogExpose {
  openDialog: () => void;
}

export interface AddModelDialogEmits {
  (e: 'submit', data: {
    url: string;
    api_key: string;
    api_format: number;
    items: ModelRowForm[];
  }): void;
}
