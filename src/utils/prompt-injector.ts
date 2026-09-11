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
 * 检查请求中是否配置或携带了平台的模型记忆与处置方案 MCP 工具
 * 兼容：
 * 1. 直接声明在 tools / functions 列表中的工具（OpenAI 标准格式）
 * 2. 延迟加载工具模式（Deferred Tools / Lazy Tools，如 WorkBuddy、Claude Code 声明在 ToolSearch 等工具的 description 中）
 * 3. 声明在 system prompt 或 messages 上下文中的工具列表（如 <available_deferred_tools>）
 */
export function detectPlatformMcpTools(bodyOrTools: unknown): { hasMemoryTools: boolean; hasSkillTools: boolean } {
  const searchTexts: string[] = [];

  if (Array.isArray(bodyOrTools)) {
    // 兼容直接传入 tools 数组
    for (const item of bodyOrTools) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as any).function?.name || (item as any).name;
      const desc = (item as any).function?.description || (item as any).description;
      if (typeof name === 'string') searchTexts.push(name);
      if (typeof desc === 'string') searchTexts.push(desc);
    }
  } else if (bodyOrTools && typeof bodyOrTools === 'object') {
    const body = bodyOrTools as Record<string, unknown>;

    // 1. 扫描 tools 数组中的名称与描述
    if (Array.isArray(body.tools)) {
      for (const item of body.tools) {
        if (!item || typeof item !== 'object') continue;
        const name = (item as any).function?.name || (item as any).name;
        const desc = (item as any).function?.description || (item as any).description;
        if (typeof name === 'string') searchTexts.push(name);
        if (typeof desc === 'string') searchTexts.push(desc);
      }
    }

    // 2. 扫描 functions
    if (Array.isArray(body.functions)) {
      for (const item of body.functions) {
        if (!item || typeof item !== 'object') continue;
        const name = (item as any).name;
        const desc = (item as any).description;
        if (typeof name === 'string') searchTexts.push(name);
        if (typeof desc === 'string') searchTexts.push(desc);
      }
    }

    // 3. 扫描 instructions（Responses API 格式）
    if (typeof body.instructions === 'string') {
      searchTexts.push(body.instructions);
    }

    // 4. 扫描 system prompt（Anthropic 格式）
    if (typeof body.system === 'string') {
      searchTexts.push(body.system);
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block && typeof block.text === 'string') searchTexts.push(block.text);
      }
    }

    // 5. 扫描 input 字段（Responses API 格式输入）
    if (typeof body.input === 'string') {
      searchTexts.push(body.input);
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (typeof item === 'string') searchTexts.push(item);
        else if (item && typeof item === 'object') {
          if (typeof (item as any).content === 'string') searchTexts.push((item as any).content);
        }
      }
    }

    // 6. 扫描 messages 中可能声明工具的 system/developer 消息（Chat 格式）
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg) continue;
        if (msg.role === 'system' || msg.role === 'developer') {
          if (typeof msg.content === 'string') searchTexts.push(msg.content);
          else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part && typeof part.text === 'string') searchTexts.push(part.text);
            }
          }
        }
      }
    }
  }

  const allText = searchTexts.join('\n');

  // 模型记忆工具集匹配：
  // 匹配 ai_mm_...user_memor... 工具名、mcp__ai-models-manager-memory 或服务名
  const hasMemoryTools =
    /ai_mm_(?:search_user_memories|get_user_memory_detail|create_user_memory|update_user_memory|delete_user_memory)/i.test(allText) ||
    /ai_mm_.*user_memor/i.test(allText) ||
    /ai-models-manager-memory/i.test(allText);

  // 处置方案工具集匹配：
  // 匹配 ai_mm_...skill... 工具名、mcp__ai-models-manager-skills 或服务名
  const hasSkillTools =
    /ai_mm_(?:search_skills|get_skill_detail|create_skill|update_skill|delete_skill)/i.test(allText) ||
    /ai_mm_.*skill/i.test(allText) ||
    /ai-models-manager-skills/i.test(allText);

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

> **画像持续完善指南**：请在日常交互与任务处理中，时刻保持主动沉淀意识，在对话中逐渐完善模型记忆中的用户画像（重点关注并记录：用户操作系统中的本地项目及描述、常用的远程服务器地址/IP、部署的项目目录、常用的 Docker 容器及描述，以及用户的操作习惯与技术偏好等）。若具备记忆工具调用能力，请在获知新信息或变更时主动调用工具进行增量更新或沉淀，构建立体全面的用户画像。
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
- **逐渐完善用户画像（核心主动机制）**：在与用户的日常对话与任务协作中，请时刻具备**画像沉淀意识**，主动观察、捕捉并不断完善模型记忆中的**用户立体画像**。当发现用户提及新的项目信息、环境配置、服务器IP、部署目录或习惯偏好时，**主动调用工具**沉淀或更新记忆，无需等待用户明确发出“请记住”指令；
- **分类标准**：创建/更新记忆时，description 必须为以下固定类别之一：
  1. 用户称呼（用户的自我称呼、希望 AI 的称呼等）
  2. 用户系统设置（关键分类：记录用户操作系统中的本地项目及描述、常用的远程服务器地址/IP、部署的项目目录路径、常用的 Docker 容器名称与用途描述等）
  3. 用户操作习惯（如常用的命令行工具、包管理器、部署流程、快捷习惯等）
  4. 用户编码习惯（如代码风格、技术栈偏好、TypeScript/Python 规范等）
  5. 用户个人偏好（如工作习惯、关注重点、沟通口吻等）
  6. AI人格设定（AI 自身被赋予的特定角色、性格与语气规则）
  7. AI长期计划（与用户共同推进的长周期工作目标或演进路线）
  8. AI其他记忆（或 "AI其他记忆-自定义子类" 格式，用于收纳车辆信息、特定表格等垂直记忆）
- **动态更新与增量合并**：当发现某项环境或偏好已在记忆中有记录但发生更新时（例如新增了 Docker 容器、增加了远程服务器或项目目录变动），应检索已有记录 ID 并调用 \`ai_mm_update_user_memory\` 进行同步更新或追加合并，保持画像的最新与整洁；
- **自然融入**：执行记忆更新保存后，在回复中自然衔接即可，无需向用户繁复汇报工具调用技术细节。`);
  }

  if (hasSkillTools) {
    sections.push(`## 2. 处置方案 (Skills) 工具规范（已检测到可用工具）
你拥有查询和沉淀标准化处置方案/排障指南的能力（相关工具：ai_mm_search_skills、ai_mm_get_skill_detail、ai_mm_create_skill 等）。
- **主动检索**：当用户遇到故障排查、疑难报错、部署运维或明确询问标准处理方案时，优先调用 \`ai_mm_search_skills\` 检索是否存在已沉淀的最佳实践（\`keyword\` 参数支持传入单个字符串或字符串数组如 \`['cesium', 'mapbox']\`，多个关键字结果自动取并集）；
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
  if (typeof body.instructions === 'string' && body.instructions.includes(marker)) {
    return true;
  }
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
    const { hasMemoryTools, hasSkillTools } = detectPlatformMcpTools(body);
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

  // 3. 注入到对应位置（追加到原系统提示词末尾）
  // 3.1 Responses API 格式请求（具有 instructions 字段，或具有 input 且无 messages/system）
  if (typeof body.instructions === 'string') {
    body.instructions = body.instructions.trim()
      ? `${body.instructions}\n\n${combinedPrompt}`
      : combinedPrompt;
    return result;
  } else if ('input' in body && !('messages' in body) && !('system' in body)) {
    body.instructions = combinedPrompt;
    return result;
  }

  // 3.2 Anthropic 格式请求（具有顶级 system 字段）
  if (typeof body.system === 'string') {
    body.system = body.system.trim() ? `${body.system}\n\n${combinedPrompt}` : combinedPrompt;
    return result;
  } else if (Array.isArray(body.system)) {
    (body.system as any[]).push({ type: 'text', text: combinedPrompt });
    return result;
  }

  // 3.3 标准 Chat 格式（OpenAI 规范）：注入到 messages 数组的 system/developer 消息末尾
  if (Array.isArray(body.messages)) {
    const systemIndex = body.messages.findIndex(
      (m: any) => m && (m.role === 'system' || m.role === 'developer'),
    );

    if (systemIndex !== -1) {
      const targetMsg = body.messages[systemIndex];
      if (typeof targetMsg.content === 'string') {
        targetMsg.content = targetMsg.content.trim()
          ? `${targetMsg.content}\n\n${combinedPrompt}`
          : combinedPrompt;
      } else if (Array.isArray(targetMsg.content)) {
        targetMsg.content.push({ type: 'text', text: combinedPrompt });
      } else {
        targetMsg.content = combinedPrompt;
      }
    } else {
      // 未定义 system 消息，创建 system 消息并插入到数组首位
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

/**
 * 提取请求体中的系统提示词（合并 instructions、system 与 developer 消息及顶级 system 字段）
 */
export function extractSystemPrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];

  // Responses API 规范: instructions 字段
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    parts.push(body.instructions.trim());
  }

  // Anthropic 规范: system 字段
  if (typeof body.system === 'string' && body.system.trim()) {
    parts.push(body.system.trim());
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((block: any) => (block?.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text.trim()) parts.push(text.trim());
  }

  // OpenAI Chat 规范: messages 中的 system 与 developer 消息
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (msg && (msg.role === 'system' || msg.role === 'developer')) {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        parts.push(msg.content.trim());
      } else if (Array.isArray(msg.content)) {
        const text = msg.content
          .map((part: any) => (part?.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n');
        if (text.trim()) parts.push(text.trim());
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * 提取请求体中携带的工具名称列表（含延迟加载的 MCP 工具）
 */
export function extractToolNames(body: Record<string, unknown>): string[] {
  const toolNames: string[] = [];

  if (Array.isArray(body.tools)) {
    for (const item of body.tools) {
      const name = item?.function?.name || item?.name;
      if (typeof name === 'string' && name.trim()) {
        toolNames.push(name.trim());
      }

      // 如果有 deferred tools，提取工具名称供前端展示
      const desc = item?.function?.description || item?.description;
      if (typeof desc === 'string' && desc.includes('<available_deferred_tools>')) {
        const lines = desc.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('mcp__') || trimmed.startsWith('ai_mm_')) {
            const toolMatch = trimmed.match(/^([a-zA-Z0-9_-]+)(?::|$)/);
            if (toolMatch) {
              toolNames.push(toolMatch[1]);
            }
          }
        }
      }
    }
  }

  if (Array.isArray(body.functions)) {
    for (const item of body.functions) {
      if (typeof item?.name === 'string' && item.name.trim()) {
        toolNames.push(item.name.trim());
      }
    }
  }

  return Array.from(new Set(toolNames));
}
