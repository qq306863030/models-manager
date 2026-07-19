/**
 * MCP Skills 服务
 *
 * 提供 agent_memory_skills 表的 CRUD 操作，通过 MCP Streamable HTTP 对外暴露。
 * 地址格式: POST /<username>/skills/mcp
 *
 * 工具列表:
 *   - search_skills     — 根据关键词在标题和内容中搜索，返回 id + description 列表
 *   - get_skill_detail  — 根据 id 获取完整标题和内容
 *   - create_skill      — 新增记录
 *   - update_skill      — 更新记录
 *   - delete_skill      — 删除记录
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

// ========== API Key 验证中间件 ==========
router.use((req: Request, res: Response, next) => {
  const username = (req.params as Record<string, string>).username;
  if (!username) {
    res.status(400).json({ error: { message: 'Missing username', type: 'invalid_request' } });
    return;
  }

  const storedApiKey = getUserApiKey(username);
  if (!storedApiKey) {
    // 未设置 API Key，无需验证
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
function buildSkillsServer(userId: number): McpServer {
  const server = new McpServer({
    name: 'ai-models-manager-skills',
    version: '1.0.0',
  });

  // -------- 工具1: search_skills --------
  server.registerTool(
    'search_skills',
    {
      description:
        '【处置方案搜索】根据关键词在标题(description)和内容(content)中搜索处置方案记录。' +
        '返回匹配记录的 id 和标题(description)列表，不包含完整内容。' +
        '使用方法：模型应先调用此工具，根据用户问题在标题和内容中查找最相关的记录，' +
        '获取目标记录的 id 后，再调用 get_skill_detail 查看完整详情。' +
        '如果关键词为空，则返回所有记录。',
      inputSchema: z.object({
        keyword: z
          .string()
          .optional()
          .default('')
          .describe('搜索关键词，在标题和内容中模糊匹配。留空返回全部记录。'),
      }),
    },
    async ({ keyword }) => {
      try {
        let rows: { id: number; description: string | null }[];
        if (keyword) {
          const like = `%${keyword}%`;
          rows = db
            .prepare(
              'SELECT id, description FROM agent_memory_skills WHERE user_id = ? AND (description LIKE ? OR content LIKE ?) ORDER BY id'
            )
            .all(userId, like, like) as any[];
        } else {
          rows = db
            .prepare('SELECT id, description FROM agent_memory_skills WHERE user_id = ? ORDER BY id')
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

  // -------- 工具2: get_skill_detail --------
  server.registerTool(
    'get_skill_detail',
    {
      description:
        '【处置方案详情】根据 id 获取处置方案记录的完整详情。' +
        '返回完整的标题(description)和内容(content)。' +
        '使用方法：先用 search_skills 搜索到目标记录的 id，再调用此工具查看完整内容。' +
        '如果记录不存在或不属于当前用户，会返回错误信息。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('处置方案记录的 ID，来源于 search_skills 返回结果中的 id 字段'),
      }),
    },
    async ({ id }) => {
      try {
        const row = db
          .prepare(
            'SELECT id, description, content FROM agent_memory_skills WHERE id = ? AND user_id = ?'
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

  // -------- 工具3: create_skill --------
  server.registerTool(
    'create_skill',
    {
      description:
        '【新增处置方案】调用此工具保存解决方案，以便将来遇到类似问题时可以复用。' +
        '需要提供标题(description)和内容(content)。' +
        '注意：description 必须简洁，不超过50字；' +
        'content 必须使用 Markdown 格式编写，包含完整的解决步骤和关键信息。' +
        '标题和内容不能同时为空。创建成功后返回新记录的 id。',
      inputSchema: z.object({
        description: z
          .string()
          .optional()
          .default('')
          .describe('处置方案的标题，必须简洁，不超过50字，用于概括该解决方案的主题'),
        content: z
          .string()
          .optional()
          .default('')
          .describe('处置方案的详细内容，必须使用 Markdown 格式编写，包含完整的解决步骤和关键信息，方便将来遇到类似问题时复用'),
      }),
    },
    async ({ description, content }) => {
      try {
        const desc = description || null;
        const cont = content || null;
        if (!desc && !cont) {
          return {
            content: [{ type: 'text' as const, text: '标题和内容不能同时为空' }],
            isError: true,
          };
        }
        const result = db
          .prepare('INSERT INTO agent_memory_skills (description, content, user_id) VALUES (?, ?, ?)')
          .run(desc, cont, userId);
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

  // -------- 工具4: update_skill --------
  server.registerTool(
    'update_skill',
    {
      description:
        '【修改处置方案】根据 id 修改处置方案记录，保存修改后的解决方案，以便将来遇到类似问题时可以复用。' +
        '只更新提供的字段，不传的字段保持不变。' +
        '注意：description 必须简洁，不超过50字；' +
        'content 必须使用 Markdown 格式编写，包含完整的解决步骤和关键信息。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要修改的处置方案记录 ID'),
        description: z
          .string()
          .optional()
          .describe('修改后的标题，必须简洁，不超过50字。不传则保持原值'),
        content: z
          .string()
          .optional()
          .describe('修改后的内容，必须使用 Markdown 格式编写，包含完整的解决步骤和关键信息。不传则保持原值'),
      }),
    },
    async ({ id, description, content }) => {
      try {
        // 先检查记录是否存在且属于当前用户
        const existing = db
          .prepare('SELECT id, description, content FROM agent_memory_skills WHERE id = ? AND user_id = ?')
          .get(id, userId) as { id: number; description: string | null; content: string | null } | undefined;

        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `记录不存在（id=${id}）` }],
            isError: true,
          };
        }

        const newDesc = description !== undefined ? description : existing.description;
        const newContent = content !== undefined ? content : existing.content;

        db.prepare('UPDATE agent_memory_skills SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(
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

  // -------- 工具5: delete_skill --------
  server.registerTool(
    'delete_skill',
    {
      description:
        '【删除处置方案】根据 id 删除处置方案记录。' +
        '删除后不可恢复。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要删除的处置方案记录 ID'),
      }),
    },
    async ({ id }) => {
      try {
        const result = db
          .prepare('DELETE FROM agent_memory_skills WHERE id = ? AND user_id = ?')
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
// POST /:username/skills/mcp
router.post('/skills/mcp', async (req: Request, res: Response) => {
  try {
    const username = (req.params as Record<string, string>).username;
    const userId = getUserIdByUsername(username);

    if (!userId) {
      res.status(404).json({ error: { message: 'User not found', type: 'invalid_request' } });
      return;
    }

    // 创建 MCP Server（注入 userId）
    const server = buildSkillsServer(userId);

    // 创建 stateless transport（每次请求独立）
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp-skills] Error:', (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_error' } });
    }
  }
});

export default router;
