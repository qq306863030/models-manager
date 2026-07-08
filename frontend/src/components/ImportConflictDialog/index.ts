export interface ImportConflictDialogProps {
  // reserved for future use
}

export interface ImportConflictDialogEmits {
  (e: 'resolve', action: 'overwrite' | 'skip' | 'cancel' | 'all-overwrite' | 'all-skip'): void
}

export interface ImportConflictData {
  modelName: string
  current: number
  total: number
}
