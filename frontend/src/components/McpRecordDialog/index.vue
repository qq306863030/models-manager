<template>
  <el-dialog
    v-model="dialogVisible"
    title="MCP 记录"
    width="800px"
    :close-on-click-modal="false"
    @close="handleClose">

    <div class="editor-outer">
      <div ref="editorRef" class="editor-container"></div>
      <div class="editor-footer">
        <el-icon><WarningFilled /></el-icon>
        <span>仅支持 JSON 格式，提交时将自动格式化</span>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleCancel">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="loading">提交</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { WarningFilled } from '@element-plus/icons-vue'
import { EditorState } from '@codemirror/state'
import { EditorView, placeholder, keymap } from '@codemirror/view'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { linter } from '@codemirror/lint'
import { getMcpRecord, saveMcpRecord } from '@/api/mcpRecordService'

defineOptions({ name: 'McpRecordDialog' })

const dialogVisible = ref(false)
const loading = ref(false)
const editorRef = ref<HTMLDivElement>()
let editorView: EditorView | null = null

const mountEditor = (content: string) => {
  if (editorView) {
    editorView.destroy()
    editorView = null
  }
  if (!editorRef.value) return

  const state = EditorState.create({
    doc: content || '{}',
    extensions: [
      basicSetup,
      json(),
      linter(jsonParseLinter()),
      keymap.of([indentWithTab]),
      placeholder('请输入 JSON 配置…'),
      EditorView.editable.of(true),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto', fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono',Consolas,Monaco,monospace" },
        '.cm-placeholder': { color: '#c0c4cc' },
        '.cm-gutters': { borderRight: '1px solid #ebeef5', backgroundColor: '#fafafa', color: '#909399' },
        '.cm-activeLineGutter': { backgroundColor: '#f0f2f5' },
        '.cm-activeLine': { backgroundColor: '#f5f7fa' },
        '.cm-cursor': { borderLeftColor: '#409eff' },
        '.cm-selectionBackground': { backgroundColor: '#d9ecff !important' },
        '.cm-matchingBracket': { backgroundColor: '#e6f7ff', outline: '1px solid #b3d8ff' },
      }),
    ],
  })

  editorView = new EditorView({ state, parent: editorRef.value })
  editorView.focus()
}

const getEditorContent = (): string => editorView?.state.doc.toString() || ''

const setEditorContent = (content: string) => {
  if (editorView) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: content } })
  }
}

const loadRecord = async (): Promise<string> => {
  try {
    const res = await getMcpRecord()
    if (res.success && res.data?.content) return res.data.content
  } catch { /* ignore */ }
  return '{}'
}

const openDialog = async () => {
  const content = await loadRecord()
  dialogVisible.value = true
  await nextTick()
  setTimeout(() => mountEditor(content), 50)
}

const handleClose = () => {
  editorView?.destroy()
  editorView = null
}

const handleCancel = () => { dialogVisible.value = false }

const handleSubmit = async () => {
  const raw = getEditorContent()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const msg = (e as Error).message
    const m = msg.match(/position (\d+)/)
    if (m) {
      const pos = parseInt(m[1])
      const lines = raw.slice(0, pos).split('\n')
      ElMessage.error(`JSON 格式错误: 第 ${lines.length} 行, 第 ${lines[lines.length - 1].length + 1} 列 — ${msg}`)
    } else {
      ElMessage.error(`JSON 格式错误: ${msg}`)
    }
    return
  }
  const formatted = JSON.stringify(parsed, null, 2)
  setEditorContent(formatted)

  loading.value = true
  try {
    const res = await saveMcpRecord(formatted)
    if (res.success) {
      ElMessage.success('MCP 记录已保存')
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch {
    ElMessage.error('保存失败，请检查网络连接')
  } finally {
    loading.value = false
  }
}

onBeforeUnmount(() => {
  editorView?.destroy()
  editorView = null
})

defineExpose({ openDialog })
</script>

<style scoped lang="less">
.editor-outer {
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}

.editor-container {
  height: 400px;

  :deep(.cm-editor) {
    height: 100%;
    outline: none;
    background: #fff;
  }

  :deep(.cm-scroller) {
    line-height: 1.7;
  }

  :deep(.cm-content) {
    caret-color: #409eff;
  }

  :deep(.cm-placeholder) {
    color: #c0c4cc !important;
    font-style: normal;
  }
}

.editor-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  background: #fafafa;
  border-top: 1px solid #ebeef5;
  color: #909399;
  font-size: 12px;

  .el-icon {
    font-size: 13px;
    color: #e6a23c;
  }
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
