import { Router, Request, Response } from 'express';
import db from '../config/database';

const router = Router();

// 获取所有 token 统计
router.get('/', (req: Request, res: Response) => {
  try {
    const { model_id, model_ids, start_date, end_date } = req.query;

    let sql = 'SELECT * FROM token_stats';
    const params: any[] = [];
    const conditions: string[] = [];

    if (model_id) {
      conditions.push('model_id = ?');
      params.push(model_id);
    }

    // 支持多模型查询（逗号分隔的 id 列表）
    if (model_ids) {
      const ids = String(model_ids).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (ids.length > 0) {
        conditions.push(`model_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
    }

    if (start_date) {
      conditions.push('stat_date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      conditions.push('stat_date <= ?');
      params.push(end_date);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY stat_date DESC, model_id ASC';

    const stats = db.prepare(sql).all(...params);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 获取单个 token 统计
router.get('/:id', (req: Request, res: Response) => {
  try {
    const stat = db.prepare('SELECT * FROM token_stats WHERE id = ?').get(req.params.id);
    if (stat) {
      res.json({ success: true, data: stat });
    } else {
      res.status(404).json({ success: false, message: '统计记录不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 创建或更新 token 统计（按 model_id + date 唯一）
router.post('/', (req: Request, res: Response) => {
  try {
    const { model_id, stat_date, in_token, out_token, call_count } = req.body;

    if (!model_id || !stat_date) {
      res.status(400).json({ success: false, message: 'model_id 和 stat_date 是必填项' });
      return;
    }

    const total_token = (in_token || 0) + (out_token || 0);
    const count = call_count || 1;

    const existing = db.prepare(
      'SELECT * FROM token_stats WHERE model_id = ? AND stat_date = ?'
    ).get(model_id, stat_date);

    if (existing) {
      const stmt = db.prepare(`
        UPDATE token_stats
        SET in_token = in_token + ?, out_token = out_token + ?, total_token = total_token + ?, call_count = call_count + ?
        WHERE model_id = ? AND stat_date = ?
      `);
      stmt.run(in_token || 0, out_token || 0, total_token, count, model_id, stat_date);
      res.json({ success: true, message: '统计更新成功（累加）', data: { model_id, stat_date, in_token: in_token || 0, out_token: out_token || 0, total_token, call_count: count } });
    } else {
      const stmt = db.prepare(
        'INSERT INTO token_stats (model_id, stat_date, in_token, out_token, total_token, call_count) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const result = stmt.run(model_id, stat_date, in_token || 0, out_token || 0, total_token, count);
      res.status(201).json({ success: true, message: '统计创建成功', data: { id: result.lastInsertRowid, model_id, stat_date, in_token: in_token || 0, out_token: out_token || 0, total_token, call_count: count } });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '创建/更新失败', error });
  }
});

// 更新 token 统计
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { model_id, stat_date, in_token, out_token, call_count } = req.body;
    const total_token = (in_token || 0) + (out_token || 0);
    const stmt = db.prepare(
      'UPDATE token_stats SET model_id = ?, stat_date = ?, in_token = ?, out_token = ?, total_token = ?, call_count = ? WHERE id = ?'
    );
    const result = stmt.run(model_id, stat_date, in_token || 0, out_token || 0, total_token, call_count || 0, req.params.id);
    if (result.changes > 0) {
      res.json({ success: true, message: '统计更新成功' });
    } else {
      res.status(404).json({ success: false, message: '统计记录不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// 删除 token 统计
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const stmt = db.prepare('DELETE FROM token_stats WHERE id = ?');
    const result = stmt.run(req.params.id);
    if (result.changes > 0) {
      res.json({ success: true, message: '统计删除成功' });
    } else {
      res.status(404).json({ success: false, message: '统计记录不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '删除失败', error });
  }
});

export default router;
