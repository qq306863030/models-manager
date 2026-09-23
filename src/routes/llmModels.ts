import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import companies from '../config/llm-data.json';

const router = Router();

export interface ModelConfig {
  model: string;
  content_length: string;
  max_token: string;
  capabilities: string[];
}

const modelsFilePath = path.resolve(__dirname, '../config/models.json');
let cachedModels: ModelConfig[] = [];
let cachedModelMap = new Map<string, ModelConfig>();
let cachedLowerModelMap = new Map<string, ModelConfig>();
let lastMtime = 0;

function getModelsData(): {
  models: ModelConfig[];
  modelMap: Map<string, ModelConfig>;
  lowerModelMap: Map<string, ModelConfig>;
} {
  try {
    const stats = fs.statSync(modelsFilePath);
    if (!cachedModels.length || stats.mtimeMs !== lastMtime) {
      const raw = fs.readFileSync(modelsFilePath, 'utf8');
      cachedModels = JSON.parse(raw);
      cachedModelMap = new Map(cachedModels.map((m: any) => [m.model, m]));
      cachedLowerModelMap = new Map(cachedModels.map((m: any) => [m.model.toLowerCase(), m]));
      lastMtime = stats.mtimeMs;
    }
  } catch (err) {
    console.error('Failed to read models.json:', err);
  }
  return {
    models: cachedModels,
    modelMap: cachedModelMap,
    lowerModelMap: cachedLowerModelMap,
  };
}

// 获取 llm-data.json 数据，调用时从 models.json 中匹配模型详细配置
router.get('/', (req: Request, res: Response) => {
  try {
    const { modelMap, lowerModelMap } = getModelsData();
    const data = companies.map((company) => ({
      ...company,
      models: company.models
        .map((modelId: string) => {
          return (
            modelMap.get(modelId) ||
            lowerModelMap.get(modelId.toLowerCase()) || {
              model: modelId,
              content_length: '200000',
              max_token: '64000',
              capabilities: ['completion', 'tools', 'thinking'],
            }
          );
        })
        .filter(Boolean),
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: '读取模型配置失败', error });
  }
});

// 获取所有模型配置列表（来自 models.json）
router.get('/models', (req: Request, res: Response) => {
  try {
    const { models } = getModelsData();
    res.json({ success: true, data: models });
  } catch (error) {
    res.status(500).json({ success: false, message: '读取模型列表失败', error });
  }
});

export default router;