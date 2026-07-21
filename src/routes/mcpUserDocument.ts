/**
 * MCP User Document 服务
 *
 * 提供 agent_memory_docs 表的 CRUD 操作，通过 MCP Streamable HTTP 对外暴露。
 * 地址格式: POST /<username>/docs/mcp
 *
 * 工具列表:
 *   - ai_mm_search_user_docs      — 根据关键词在标题和内容中搜索，返回 id + description 列表
 *   - ai_mm_get_user_doc_detail   — 根据 id 获取完整标题和内容
 *   - ai_mm_create_user_doc       — 新增记录
 *   - ai_mm_update_user_doc       — 更新记录
 *   - ai_mm_delete_user_doc       — 删除记录
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
function buildUserDocumentServer(userId: number): McpServer {
  const server = new McpServer({
    name: 'ai-models-manager-docs',
    version: '1.0.0',
  });

  // -------- 工具1: search_user_docs --------
  server.registerTool(
    'ai_mm_search_user_docs',
    {
      description:
        '【注意：仅当用户明确提到"我的文档、用户文档"的文字时才调用此工具，例如"查询文档"、"搜索文档"等。】' +
        '【用户文档搜索】根据关键词在标题(description)和内容(content)中搜索用户文档记录。' +
        '返回匹配记录的 id 和标题(description)列表，不包含完整内容。' +
        '使用方法：模型应先调用此工具，根据用户问题在标题和内容中查找最相关的记录，' +
        '获取目标记录的 id 后，再调用 get_user_doc_detail 查看完整详情。' +
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
              'SELECT id, description FROM agent_memory_docs WHERE user_id = ? AND (description LIKE ? OR content LIKE ?) ORDER BY id'
            )
            .all(userId, like, like) as any[];
        } else {
          rows = db
            .prepare('SELECT id, description FROM agent_memory_docs WHERE user_id = ? ORDER BY id')
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

  // -------- 工具2: get_user_doc_detail --------
  server.registerTool(
    'ai_mm_get_user_doc_detail',
    {
      description:
        '【注意：仅当用户明确提到"我的文档、用户文档"的文字时才调用此工具，例如"查看文档"、"文档详情"等。】' +
        '【用户文档详情】根据 id 获取用户文档记录的完整详情。' +
        '返回完整的标题(description)和内容(content)。' +
        '使用方法：先用 search_user_docs 搜索到目标记录的 id，再调用此工具查看完整内容。' +
        '如果记录不存在或不属于当前用户，会返回错误信息。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('文档记录的 ID，来源于 search_user_docs 返回结果中的 id 字段'),
      }),
    },
    async ({ id }) => {
      try {
        const row = db
          .prepare(
            'SELECT id, description, content FROM agent_memory_docs WHERE id = ? AND user_id = ?'
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

  // -------- 工具3: create_user_doc --------
  server.registerTool(
    'ai_mm_create_user_doc',
    {
      description:
        '【注意：仅当用户明确提到"我的文档、用户文档"的文字时才调用此工具，例如"添加文档"、"新建文档"等。】' +
        '【新增用户文档】调用此工具保存用户文档，以便将来可以随时查阅。' +
        '需要提供标题(description)和内容(content)。' +
        '注意：description 必须简洁，不超过50字，记录文档的主题；' +
        'content 必须使用 Markdown 格式编写。' +
        '标题和内容不能同时为空。创建成功后返回新记录的 id。',
      inputSchema: z.object({
        description: z
          .string()
          .optional()
          .default('')
          .describe('文档的标题，必须简洁，不超过50字，用于概括该文档的主题'),
        content: z
          .string()
          .optional()
          .default('')
          .describe('文档的详细内容，必须使用 Markdown 格式编写，包含完整的文档信息'),
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
          .prepare('INSERT INTO agent_memory_docs (description, content, user_id) VALUES (?, ?, ?)')
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

  // -------- 工具4: update_user_doc --------
  server.registerTool(
    'ai_mm_update_user_doc',
    {
      description:
        '【注意：仅当用户明确提到"我的文档、用户文档"的文字时才调用此工具，例如"修改文档"、"更新文档"等。】' +
        '【修改用户文档】根据 id 修改用户文档记录。' +
        '只更新提供的字段，不传的字段保持不变。' +
        '注意：description 必须简洁，不超过50字；' +
        'content 必须使用 Markdown 格式编写。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要修改的文档记录 ID'),
        description: z
          .string()
          .optional()
          .describe('修改后的标题，必须简洁，不超过50字。不传则保持原值'),
        content: z
          .string()
          .optional()
          .describe('修改后的内容，必须使用 Markdown 格式编写。不传则保持原值'),
      }),
    },
    async ({ id, description, content }) => {
      try {
        // 先检查记录是否存在且属于当前用户
        const existing = db
          .prepare('SELECT id, description, content FROM agent_memory_docs WHERE id = ? AND user_id = ?')
          .get(id, userId) as { id: number; description: string | null; content: string | null } | undefined;

        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `记录不存在（id=${id}）` }],
            isError: true,
          };
        }

        const newDesc = description !== undefined ? description : existing.description;
        const newContent = content !== undefined ? content : existing.content;

        db.prepare('UPDATE agent_memory_docs SET description = ?, content = ? WHERE id = ? AND user_id = ?').run(
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

  // -------- 工具5: delete_user_doc --------
  server.registerTool(
    'ai_mm_delete_user_doc',
    {
      description:
        '【注意：仅当用户明确提到"我的文档、用户文档"的文字时才调用此工具，例如"删除文档"、"移除文档"等。】' +
        '【删除用户文档】根据 id 删除用户文档记录。' +
        '删除后不可恢复。' +
        '如果记录不存在或不属于当前用户，会返回错误。',
      inputSchema: z.object({
        id: z.number().int().positive().describe('要删除的文档记录 ID'),
      }),
    },
    async ({ id }) => {
      try {
        const result = db
          .prepare('DELETE FROM agent_memory_docs WHERE id = ? AND user_id = ?')
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
// POST /:username/docs/mcp
router.post('/docs/mcp', async (req: Request, res: Response) => {
  try {
    const username = (req.params as Record<string, string>).username;
    const userId = getUserIdByUsername(username);

    if (!userId) {
      res.status(404).json({ error: { message: 'User not found', type: 'invalid_request' } });
      return;
    }

    // 创建 MCP Server（注入 userId）
    const server = buildUserDocumentServer(userId);

    // 创建 stateless transport（每次请求独立）
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp-user-document] Error:', (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_error' } });
    }
  }
});

export default router;
