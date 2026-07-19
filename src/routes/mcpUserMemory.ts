/**
 * MCP User Memory 服务
 *
 * 提供 agent_memory_user 表的 CRUD 操作，通过 MCP Streamable HTTP 对外暴露。
 * 地址格式: POST /<username>/memory/mcp
 *
 * 描述(description) 只能是以下固定类别之一：
 *   - "用户称呼"
 *   - "用户操作习惯"
 *   - "用户编码习惯"
 *   - "用户个人偏好"
 *   - "AI人格设定"
 *   - "AI长期计划"
 *   - "AI其他长期记忆"
 *
 * 工具列表:
 *   - search_user_memories   — 根据类别关键词搜索，返回 id + description 列表
 *   - get_user_memory_detail — 根据 id 获取完整详情
 *   - create_user_memory     — 新增记录
 *   - update_user_memory     — 更新记录
 *   - delete_user_memory     — 删除记录
 *
 * API Key 鉴权：如果用户设置了 API Key，MCP 调用时必须传 Authorization: Bearer <Key>
 */

import { Router, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import db, { getUserApiKey } from '../config/database';

const router = Router({ mergeParams: true });

// ========== 辅助函数 ==========

/** 根据用户名查询用户 ID */
function getUserIdByUsername(username: string): number | null {
  const user = db
    .prepare('SELECT id FROM users WHERE name = ?')
    .get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

/** 合法的 description 类别列表 */
const VALID_CATEGORIES = [
  '用户称呼',
  '用户操作习惯',
  '用户编码习惯',
  '用户个人偏好',
  'AI人格设定',
  'AI长期计划',
  'AI其他长期记忆',
] as const;

type Category = (typeof VALID_CATEGORIES)[number];

function isValidCategory(val: string): val is Category {
  return VALID_CATEGORIES.includes(val as Category);
}

// ========== API Key 验证中间件 ==========
router.use((req: Request, res: Response, next) => {
  const username = (req.params as Record<string, string>).username;
  if (!username) {
    res.status(400).json({ error: { message: 'Missing username', type: 'invalid_request' } });
    return;
  }

  const storedApiKey = getUserApiKey(username);
  if (!storedApiKey) {
    return next();
  }

  const authHeader = req.headers.authorization;
  let requestApiKey: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    requestApiKey = authHeader.slice(7);
  }

  if (!requestApiKey || requestApiKey !== storedApiKey) {
    res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  next();
});

// ========== 构建 MCP Server（每个请求一个实例，注入 userId）==========
function buildUserMemoryServer(userId: number): McpServer {
  const server = new McpServer({
    name: 'ai-models-manager-user-memory',
    version: '1.0.0',
  });

  // -------- 工具1: search_user_memories --------
  server.registerTool(
    'search_user_memories',
    {
      description:
        '【注意：仅当用户明确提到"记忆"的文字时才调用此工具，例如"查询记忆"、"从记忆中搜索"等。】' +
        '【用户/AI 记忆搜索】根据类别关键词在标题(description)和内容(content)中搜索用户/AI 记忆记录。' +
        'description 是固定的类别之一："用户称呼"、"用户操作习惯"、"用户编码习惯"、"用户个人偏好"、' +
        '"AI人格设定"、"AI长期计划"、"AI其他长期记忆"。' +
        '返回匹配记录的 id 和 description（类别）列表，不包含完整内容。' +
        '使用方法：模型应先调用此工具搜索相关记忆，获取目标记录的 id 后，再调用 get_user_memory_detail 查看完整详情。' +
        '如果关键词为空，则返回所有记录。',
      inputSchema: z.object({
        keyword: z
          .string()
          .optional()
          .default('')
          .describe('搜索关键词，在类别(description)和内容(content)中模糊匹配。可输入类别名（如"用户称呼"）或内容关键词。留空返回全部记录。'),
      }),
    },
    async ({ keyword }) => {
      try {
        let rows: { id: number; description: string | null }[];
        if (keyword) {
          const like = `%${keyword}%`;
          rows = db
            .prepare(
              'SELECT id, description FROM agent_memory_user WHERE user_id = ? AND (description LIKE ? OR content LIKE ?) ORDER BY id'
            )
            .all(userId, like, like) as any[];
        } else {
          rows = db
            .prepare('SELECT id, description FROM agent_memory_user WHERE user_id = ? ORDER BY id')
            .all(userId) as any[];
        }

        const result = rows.map((r) => ({
          id: r.id,
          description: r.description || '',
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `查询失败: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -------- 工具2: get_user_memory_detail --------
  server.registerTool(
    'get_user_memory_detail',
    {
      description:
        '【注意：仅当用户明确提到"记忆"的文字时才调用此工具，例如"查看记忆详情"等。】' +
        '【用户/AI 记忆详情】根据 id 获取用户/AI 记忆记录的完整详情。' +
        '返回完整的 description（类别）和 content（内容）。' +
        '使用方法：先用 search_user_memories 搜索到目标记录的 id，再调用此工具查看完整内容。' +
        '如果记录不存在或不属于当前用户，会返回错误信息。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('记忆记录的 ID，来源于 search_user_memories 返回结果中的 id 字段'),
      }),
    },
    async ({ id }) => {
      try {
        const row = db
          .prepare(
            'SELECT id, description, content FROM agent_memory_user WHERE id = ? AND user_id = ?'
          )
          .get(id, userId) as { id: number; description: string | null; content: string | null } | undefined;

        if (!row) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `记录不存在（id=${id}）`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: row.id,
                  description: row.description || '',
                  content: row.content || '',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `查询失败: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -------- 工具3: create_user_memory --------
  server.registerTool(
    'create_user_memory',
    {
      description:
        '【注意：仅当用户明确提到"记忆"的文字时才调用此工具，例如"添加记忆"、"新建记忆"等。】' +
        '【新增用户/AI 记忆】调用此工具记录关于用户或 AI 自身的重要信息，以便将来对话中可以参考和复用。' +
        'description 必须是以下固定类别之一："用户称呼"、"用户操作习惯"、"用户编码习惯"、"用户个人偏好"、' +
        '"AI人格设定"、"AI长期计划"、"AI其他长期记忆"。' +
        'content 无格式限制，用自然语言清晰描述即可。' +
        '注意：description 只能从上述 7 种类别中选择，不可自定义。创建成功后返回新记录的 id。',
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            '记忆类别，必须从以下固定值中选择其一：' +
            '"用户称呼"、"用户操作习惯"、"用户编码习惯"、"用户个人偏好"、' +
            '"AI人格设定"、"AI长期计划"、"AI其他长期记忆"'
          ),
        content: z
          .string()
          .optional()
          .default('')
          .describe('记忆的详细内容，用自然语言清晰描述需要记录的信息，方便将来参考复用'),
      }),
    },
    async ({ description, content }) => {
      try {
        if (!isValidCategory(description)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `description 必须是以下类别之一：${VALID_CATEGORIES.join('、')}`,
              },
            ],
            isError: true,
          };
        }
        const cont = content || null;
        const result = db
          .prepare('INSERT INTO agent_memory_user (description, content, user_id) VALUES (?, ?, ?)')
          .run(description, cont, userId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ id: result.lastInsertRowid as number, message: '创建成功' }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `创建失败: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // -------- 工具4: update_user_memory --------
  server.registerTool(
    'update_user_memory',
    {
      description:
        '【注意：仅当用户明确提到"记忆"的文字时才调用此工具，例如"修改记忆"、"更新记忆"等。】' +
        '【修改用户/AI 记忆】根据 id 修改用户/AI 记忆记录，更新信息以便将来对话中可以参考和复用。' +
        'description 必须是以下固定类别之一："用户称呼"、"用户操作习惯"、"用户编码习惯"、"用户个人偏好"、' +
        '"AI人格设定"、"AI长期计划"、"AI其他长期记忆"。' +
        'content 无格式限制，用自然语言清晰描述即可。' +
        '只更新提供的字段，不传的字段保持不变。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要修改的记忆记录 ID'),
        description: z
          .string()
          .optional()
          .describe(
            '修改后的记忆类别，必须从以下固定值中选择："用户称呼"、"用户操作习惯"、"用户编码习惯"、' +
            '"用户个人偏好"、"AI人格设定"、"AI长期计划"、"AI其他长期记忆"。不传则保持原值'
          ),
        content: z
          .string()
          .optional()
          .describe('修改后的记忆内容，用自然语言描述。不传则保持原值'),
      }),
    },
    async ({ id, description, content }) => {
      try {
        // 校验 description 合法性
        if (description !== undefined && !isValidCategory(description)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `description 必须是以下类别之一：${VALID_CATEGORIES.join('、')}`,
              },
            ],
            isError: true,
          };
        }

        // 先检查记录是否存在且属于当前用户
        const existing = db
          .prepare('SELECT id, description, content FROM agent_memory_user WHERE id = ? AND user_id = ?')
          .get(id, userId) as { id: number; description: string | null; content: string | null } | undefined;

        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `记录不存在（id=${id}）` }],
            isError: true,
          };
        }

        const newDesc = description !== undefined ? description : existing.description;
        const newContent = content !== undefined ? content : existing.content;

        db.prepare('UPDATE agent_memory_user SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(
          newDesc,
          newContent,
          id,
          userId
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ id, message: '更新成功' }) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `更新失败: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  // -------- 工具5: delete_user_memory --------
  server.registerTool(
    'delete_user_memory',
    {
      description:
        '【注意：仅当用户明确提到"记忆"的文字时才调用此工具，例如"删除记忆"、"移除记忆"等。】' +
        '【删除用户/AI 记忆】根据 id 删除用户/AI 记忆记录。' +
        '删除后不可恢复。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要删除的记忆记录 ID'),
      }),
    },
    async ({ id }) => {
      try {
        const result = db
          .prepare('DELETE FROM agent_memory_user WHERE id = ? AND user_id = ?')
          .run(id, userId);

        if (result.changes === 0) {
          return {
            content: [{ type: 'text' as const, text: `记录不存在（id=${id}）` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ id, message: '删除成功' }) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `删除失败: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ========== MCP Streamable HTTP 端点 ==========
// POST /:username/memory/mcp
router.post('/memory/mcp', async (req: Request, res: Response) => {
  try {
    const username = (req.params as Record<string, string>).username;
    const userId = getUserIdByUsername(username);

    if (!userId) {
      res.status(404).json({ error: { message: 'User not found', type: 'invalid_request' } });
      return;
    }

    const server = buildUserMemoryServer(userId);

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp-user-memory] Error:', (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_error' } });
    }
  }
});

export default router;
