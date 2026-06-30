import { Router, Request, Response } from 'express';
import db from '../config/database';

const router = Router();

// 获取所有模型（按 sort_index 排序，-1 保持原添加顺序）
router.get('/', (req: Request, res: Response) => {
  try {
    const models = db.prepare(
      'SELECT * FROM models ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC'
    ).all();
    const parsedModels = models.map((model: any) => ({
      ...model,
      isLock: Number(model.isLock) || 0,
      isDisable: Boolean(model.isDisable),
      capabilities: model.capabilities ? JSON.parse(model.capabilities) : ['completion', 'tools', 'thinking']
    }));
    res.json({ success: true, data: parsedModels });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 获取单个模型
router.get('/:id', (req: Request, res: Response) => {
  try {
    const model: any = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
    if (model) {
      model.isLock = Number(model.isLock) || 0;
      model.isDisable = Boolean(model.isDisable);
      model.capabilities = model.capabilities ? JSON.parse(model.capabilities) : ['completion', 'tools', 'thinking'];
      res.json({ success: true, data: model });
    } else {
      res.status(404).json({ success: false, message: '模型不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 复制模型（仅复制基础信息，不复制统计数据）
router.post('/:id/copy', (req: Request, res: Response) => {
  try {
    const model: any = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
    if (!model) {
      res.status(404).json({ success: false, message: '模型不存在' });
      return;
    }

    // 查找当前最大 sort_index
    const maxRow: any = db.prepare('SELECT MAX(sort_index) as maxIdx FROM models').get();
    const nextIndex = (maxRow.maxIdx ?? -1) + 1;

    const stmt = db.prepare(
      'INSERT INTO models (name, model_name, url, max_content_length, max_token, api_key, sort_index, api_format, model_label_id, capabilities, isLock, isDisable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      model.name + '_copy',
      model.model_name + '_copy',
      model.url,
      model.max_content_length,
      model.max_token,
      model.api_key,
      nextIndex,
      model.api_format,
      model.model_label_id,
      model.capabilities,
      0, // 复制时清除锁定时间戳
      model.isDisable ? 1 : 0
    );

    res.status(201).json({
      success: true,
      message: '模型复制成功',
      data: { id: result.lastInsertRowid }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '复制失败', error });
  }
});

// 批量更新模型索引（拖拽排序后保存）
router.put('/reorder', (req: Request, res: Response) => {
  try {
    const items: Array<{ id: number; sort_index: number }> = req.body?.items;
    if (!Array.isArray(items)) {
      res.status(400).json({ success: false, message: '参数 items 必须为数组' });
      return;
    }

    const stmt = db.prepare('UPDATE models SET sort_index = ? WHERE id = ?');
    const updateMany = db.transaction((rows: typeof items) => {
      for (const row of rows) {
        stmt.run(row.sort_index, row.id);
      }
    });
    updateMany(items);

    res.json({ success: true, message: '排序更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '排序更新失败', error });
  }
});

// 创建模型
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, model_name, url, max_content_length, max_token, api_key, sort_index, api_format, model_label_id, capabilities, isLock, isDisable } = req.body;

    if (!name || !model_name || !url || !api_key) {
      res.status(400).json({ success: false, message: 'name, model_name, url, api_key 是必填项' });
      return;
    }

    const capabilitiesJson = JSON.stringify(capabilities || ['completion', 'tools', 'thinking']);
    const stmt = db.prepare(
      'INSERT INTO models (name, model_name, url, max_content_length, max_token, api_key, sort_index, api_format, model_label_id, capabilities, isLock, isDisable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      name, model_name, url,
      max_content_length || 4096, max_token || 2048, api_key,
      sort_index || 0, api_format || 1, model_label_id ?? null, capabilitiesJson,
      Number(isLock) || 0, isDisable ? 1 : 0
    );

    res.status(201).json({
      success: true, message: '模型创建成功',
      data: {
        id: result.lastInsertRowid, name, model_name, url,
        max_content_length: max_content_length || 4096, max_token: max_token || 2048, api_key,
        sort_index: sort_index || 0, api_format: api_format || 1, model_label_id: model_label_id ?? null,
        capabilities: capabilities || ['completion', 'tools', 'thinking'],
        isLock: Number(isLock) || 0, isDisable: Boolean(isDisable)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '创建失败', error });
  }
});

// 批量创建模型
router.post('/batch', (req: Request, res: Response) => {
  try {
    const items: Array<{
      name?: string; model_name?: string; max_content_length?: number;
      max_token?: number; model_label_id?: number | null; capabilities?: string[];
    }> = req.body?.items;
    const sharedUrl: string | undefined = req.body?.url;
    const sharedApiKey: string | undefined = req.body?.api_key;
    const sharedApiFormat: number | undefined = req.body?.api_format;

    let list: typeof items;
    if (Array.isArray(items) && items.length > 0) {
      list = items;
    } else if (Array.isArray(req.body?.models) && (req.body.models as any[]).length > 0) {
      list = req.body.models as any;
    } else {
      res.status(400).json({ success: false, message: '请至少提交一个模型' });
      return;
    }

    if (!list || list.length === 0) {
      res.status(400).json({ success: false, message: '请至少添加一个模型' });
      return;
    }

    // 查找当前最大 sort_index
    const maxRow: any = db.prepare('SELECT MAX(sort_index) as maxIdx FROM models').get();
    let nextIndex = (maxRow.maxIdx ?? -1) + 1;

    const stmt = db.prepare(
      'INSERT INTO models (name, model_name, url, max_content_length, max_token, api_key, sort_index, api_format, model_label_id, capabilities, isLock, isDisable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const insertMany = db.transaction((rows: typeof items) => {
      const inserted: number[] = [];
      for (const row of rows) {
        const name = row.name?.trim();
        const model_name = row.model_name?.trim();
        if (!name || !model_name || !sharedUrl || !sharedApiKey) continue;
        const rowCapabilities = row.capabilities || ['completion', 'tools', 'thinking'];
        const result = stmt.run(
          name, model_name, sharedUrl,
          row.max_content_length || 4096, row.max_token || 2048, sharedApiKey,
          nextIndex++, sharedApiFormat ?? 1, row.model_label_id ?? null, JSON.stringify(rowCapabilities),
          0, 0
        );
        inserted.push(Number(result.lastInsertRowid));
      }
      return inserted;
    });

    const insertedIds = insertMany(list);
    res.json({ success: true, message: `批量创建完成，成功 ${insertedIds.length} 条`, data: { insertedIds, count: insertedIds.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: '批量创建失败', error });
  }
});

// 更新模型
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { name, model_name, url, max_content_length, max_token, api_key, sort_index, api_format, model_label_id, capabilities, isLock, isDisable } = req.body;
    const capabilitiesJson = JSON.stringify(capabilities || ['completion', 'tools', 'thinking']);
    const stmt = db.prepare(
      'UPDATE models SET name = ?, model_name = ?, url = ?, max_content_length = ?, max_token = ?, api_key = ?, sort_index = ?, api_format = ?, model_label_id = ?, capabilities = ?, isLock = ?, isDisable = ? WHERE id = ?'
    );
    const result = stmt.run(
      name, model_name, url, max_content_length, max_token, api_key,
      sort_index ?? -1, api_format ?? 1, model_label_id ?? null, capabilitiesJson,
      Number(isLock) || 0, isDisable ? 1 : 0, req.params.id
    );
    if (result.changes > 0) {
      res.json({ success: true, message: '模型更新成功' });
    } else {
      res.status(404).json({ success: false, message: '模型不存在' });
    }
  } catch (error) {
    console.error('[models] /:id PUT error:', error);
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// 设置/清除模型锁定时间戳（isLock：0=解锁，>0=锁定时间戳）
router.put('/:id/lock', (req: Request, res: Response) => {
  try {
    const isLock = Number(req.body?.isLock) || 0;
    const result = db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(isLock, req.params.id);
    if (result.changes > 0) {
      res.json({ success: true, message: isLock === 0 ? '已解锁' : '已锁定' });
    } else {
      res.status(404).json({ success: false, message: '模型不存在' });
    }
  } catch (error) {
    console.error('[models] /:id/lock error:', error);
    res.status(500).json({ success: false, message: '锁定状态更新失败', error });
  }
});

// 删除模型
router.delete('/:id', (req: Request, res: Response) => {
  try {
    // 删除模型关联的统计数据
    db.prepare('DELETE FROM token_stats WHERE model_id = ?').run(req.params.id);
    const stmt = db.prepare('DELETE FROM models WHERE id = ?');
    const result = stmt.run(req.params.id);
    if (result.changes > 0) {
      res.json({ success: true, message: '模型删除成功' });
    } else {
      res.status(404).json({ success: false, message: '模型不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '删除失败', error });
  }
});

export default router;
