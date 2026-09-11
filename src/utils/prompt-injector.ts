/**
 * prompt-injector.ts — 用户模型记忆与平台 MCP 工具用法的自动注入
 *
 * 功能：
 * 1. 根据当前用户的 userId，从 agent_memory_user 表中查询记忆，注入到系统提示词中；
 * 2. 识别请求中的平台 MCP 工具（模型记忆与处置方案），按需注入工具用法指导；
 * 3. 严格做防重标记检测，避免多轮对话或多次调用重复注入。
 */

import db, { getAgentMemoryUserList } from '../config/database';

export const MEMORY_MARKER_START = '<!-- AGENT_USER_MEMORY_START -->';
export const MEMORY_MARKER_END = '<!-- AGENT_USER_MEMORY_END -->';

export const MCP_INSTRUCTIONS_MARKER_START = '<!-- AGENT_MCP_INSTRUCTIONS_START -->';
export const MCP_INSTRUCTIONS_MARKER_END = '<!-- AGENT_MCP_INSTRUCTIONS_END -->';

/** 根据用户名查询用户 ID */
export function getUserIdByUsername(username: string): number | null {
  try {
    const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
    return user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 检查请求中是否携带了平台的模型记忆与处置方案 MCP 工具
 */
export function detectPlatformMcpTools(tools: unknown): { hasMemoryTools: boolean; hasSkillTools: boolean } {
  if (!Array.isArray(tools)) {
    return { hasMemoryTools: false, hasSkillTools: false };
  }

  const toolNames: string[] = [];
  for (const item of tools) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as any).function?.name || (item as any).name;
    if (typeof name === 'string' && name.trim()) {
      toolNames.push(name.trim());
    }
  }

  // 模型记忆工具集（含 ai_mm_search_user_memories, ai_mm_create_user_memory 等，支持命名空间前缀）
  const hasMemoryTools = toolNames.some((name) =>
    /ai_mm_(?:search_user_memories|get_user_memory_detail|create_user_memory|update_user_memory|delete_user_memory)/.test(name) ||
    /ai_mm_.*user_memor/.test(name)
  );

  // 处置方案工具集（含 ai_mm_search_skills, ai_mm_get_skill_detail, ai_mm_create_skill 等，支持命名空间前缀）
  const hasSkillTools = toolNames.some((name) =>
    /ai_mm_(?:search_skills|get_skill_detail|create_skill|update_skill|delete_skill)/.test(name) ||
    /ai_mm_.*skill/.test(name)
  );

  return { hasMemoryTools, hasSkillTools };
}

/**
 * 从数据库构建指定用户的长期记忆提示词
 */
export function buildUserMemoryPrompt(userId: number): string | null {
  try {
    const list = getAgentMemoryUserList(userId);
    if (!Array.isArray(list) || list.length === 0) return null;

    const validItems = list.filter((item) => item && (item.description || item.content));
    if (validItems.length === 0) return null;

    const lines = validItems.map((item) => {
      const desc = (item.description || '其他').trim();
      const content = (item.content || '').trim();
      return `- **[${desc}]**：${content}`;
    });

    return `${MEMORY_MARKER_START}
# 用户长期记忆与偏好
以下是关于当前用户的重要背景记忆与偏好设定，请在回答与处理任务时始终严格遵循：
${lines.join('\n')}
${MEMORY_MARKER_END}`;
  } catch (err) {
    console.error('[prompt-injector] 获取用户记忆失败:', (err as Error).message);
    return null;
  }
}

/**
 * 构建平台 MCP 工具的主动调用使用指导提示词
 */
export function buildToolInstructionPrompt(hasMemoryTools: boolean, hasSkillTools: boolean): string | null {
  if (!hasMemoryTools && !hasSkillTools) return null;

  const sections: string[] = [];

  if (hasMemoryTools) {
    sections.push(`## 1. 模型记忆工具规范（已检测到可用工具）
你拥有记录与维护用户长期偏好和记忆的能力（相关工具：ai_mm_create_user_memory、ai_mm_update_user_memory、ai_mm_search_user_memories 等）。
- **主动记录**：当用户在对话中说明了自己的称呼习惯、编码风格、操作流程偏好或长期约束要求时，请**主动调用工具**保存或更新记忆，无需等待用户明确要求“请记住”；
- **分类标准**：创建/更新记忆时，description 必须为以下固定类别之一：
  1. 用户称呼
  2. 用户操作习惯
  3. 用户编码习惯
  4. 用户个人偏好
  5. AI人格设定
  6. AI长期计划
  7. AI其他记忆（或 "AI其他记忆-自定义子类" 格式）
- **自然融入**：执行记忆保存后，在回复中自然确认或直接按新偏好响应即可，无需繁复汇报。`);
  }

  if (hasSkillTools) {
    sections.push(`## 2. 处置方案 (Skills) 工具规范（已检测到可用工具）
你拥有查询和沉淀标准化处置方案/排障指南的能力（相关工具：ai_mm_search_skills、ai_mm_get_skill_detail、ai_mm_create_skill 等）。
- **主动检索**：当用户遇到故障排查、疑难报错、部署运维或明确询问标准处理方案时，优先调用 \`ai_mm_search_skills\` 检索是否存在已沉淀的最佳实践；
- **获取详情**：检索到匹配条目后，先调用 \`ai_mm_get_skill_detail\` 获取完整的执行步骤与命令，严格按照标准指南指导用户操作；
- **经验沉淀**：当与用户共同解决了具备通用参考价值的技术难点或制定了新规范后，可主动提议或调用 \`ai_mm_create_skill\` 将其沉淀为新的处置方案。`);
  }

  return `${MCP_INSTRUCTIONS_MARKER_START}
# 平台专属 MCP 工具主动调用指南

当前环境中已为你挂载了专属的扩展工具能力，请在适当时机主动调用：

${sections.join('\n\n')}
${MCP_INSTRUCTIONS_MARKER_END}`;
}

/**
 * 检查当前请求文本中是否已经包含特定标记（防重）
 */
function hasMarker(body: Record<string, unknown>, marker: string): boolean {
  if (typeof body.system === 'string' && body.system.includes(marker)) {
    return true;
  }
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block && typeof block.text === 'string' && block.text.includes(marker)) {
        return true;
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      if (typeof msg.content === 'string' && msg.content.includes(marker)) {
        return true;
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part.text === 'string' && part.text.includes(marker)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * 统一注入函数：对请求体注入用户记忆和平台 MCP 工具用法说明
 *
 * @param body 请求体（Chat 格式或 Anthropic 格式）
 * @param userId 用户 ID（可选）
 * @param username 用户名（可选，如果未传 userId 则根据 username 查询）
 */
export function injectMemoryAndTools(
  body: Record<string, unknown>,
  userId?: number,
  username?: string,
): { injectedMemory: boolean; injectedTools: boolean } {
  const result = { injectedMemory: false, injectedTools: false };
  if (!body) return result;

  // 1. 确定有效 userId
  let effectiveUserId = userId;
  if (!effectiveUserId && username) {
    effectiveUserId = getUserIdByUsername(username) ?? undefined;
  }

  // 2. 提取需要注入的文本段落
  const injectParts: string[] = [];

  // 2.1 用户长期记忆
  if (effectiveUserId && !hasMarker(body, MEMORY_MARKER_START)) {
    const memoryPrompt = buildUserMemoryPrompt(effectiveUserId);
    if (memoryPrompt) {
      injectParts.push(memoryPrompt);
      result.injectedMemory = true;
    }
  }

  // 2.2 平台 MCP 工具使用指南
  if (!hasMarker(body, MCP_INSTRUCTIONS_MARKER_START)) {
    const { hasMemoryTools, hasSkillTools } = detectPlatformMcpTools(body.tools);
    if (hasMemoryTools || hasSkillTools) {
      const toolPrompt = buildToolInstructionPrompt(hasMemoryTools, hasSkillTools);
      if (toolPrompt) {
        injectParts.push(toolPrompt);
        result.injectedTools = true;
      }
    }
  }

  if (injectParts.length === 0) {
    return result;
  }

  const combinedPrompt = injectParts.join('\n\n');

  // 3. 注入到对应位置
  // 3.1 如果是 Anthropic 格式请求（具有顶级 system 字段，或 messages 中不允许出现 system 角色）
  if (typeof body.system === 'string') {
    body.system = body.system.trim() ? `${combinedPrompt}\n\n${body.system}` : combinedPrompt;
    return result;
  } else if (Array.isArray(body.system)) {
    (body.system as any[]).unshift({ type: 'text', text: combinedPrompt });
    return result;
  }

  // 3.2 标准 Chat 格式（OpenAI 规范）：注入到 messages 数组中
  if (Array.isArray(body.messages)) {
    const systemIndex = body.messages.findIndex(
      (m: any) => m && (m.role === 'system' || m.role === 'developer'),
    );

    if (systemIndex !== -1) {
      const targetMsg = body.messages[systemIndex];
      if (typeof targetMsg.content === 'string') {
        targetMsg.content = targetMsg.content.trim()
          ? `${combinedPrompt}\n\n${targetMsg.content}`
          : combinedPrompt;
      } else if (Array.isArray(targetMsg.content)) {
        targetMsg.content.unshift({ type: 'text', text: combinedPrompt });
      } else {
        targetMsg.content = combinedPrompt;
      }
    } else {
      // 未定义 system 消息，插入到数组首位
      body.messages.unshift({
        role: 'system',
        content: combinedPrompt,
      });
    }
  } else {
    // 兜底：若 messages 甚至尚未初始化
    body.messages = [{ role: 'system', content: combinedPrompt }];
  }

  return result;
}
