import type { Model, ModelForm } from '@/api/modelService';

export type { ApiFormat } from '@/types/enum'
export { API_FORMAT_MAP, getApiFormatTagType } from '@/types/enum'

export interface ModelStatSummary {
  todayToken: number
  totalToken: number
  totalCallCount: number
}

export interface ModelCardProps {
  model: Model
  isSelected?: boolean
  checked?: boolean
  statSummary?: ModelStatSummary
}

export interface ModelCardEmits {
  (e: 'select', id: number): void
  (e: 'check-change', id: number, checked: boolean): void
  (e: 'copy', id: number): void
  (e: 'delete', id: number): void
  (e: 'toggle-lock', id: number): void
  (e: 'toggle-disable', id: number): void
  (e: 'submit-edit', id: number, data: ModelForm): void
}
