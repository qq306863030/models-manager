import fs from 'fs';
import path from 'path';
import { formatTimestamp } from '../utils/timezone';

const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface ModelConfig {
  model: string;
  content_length: string;
  max_token: string;
  capabilities: string[];
}

export interface UpdateModelsResult {
  success: boolean;
  total?: number;
  newCount?: number;
  error?: string;
}

export interface UpdateModelsOptions {
  isStartup?: boolean;
  isScheduled?: boolean;
  isCli?: boolean;
}

// 并发防重入锁
let isUpdating = false;
let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * 获取需要同步的 models.json 文件路径列表
 * 兼容开发环境 (src/config) 与构建部署环境 (dist/config)
 */
function getTargetFilePaths(): string[] {
  const currentPath = path.resolve(__dirname, '../config/models.json');
  const targets: string[] = [currentPath];

  const projectRoot = path.resolve(__dirname, '../..');
  const srcConfig = path.join(projectRoot, 'src', 'config', 'models.json');
  const distConfig = path.join(projectRoot, 'dist', 'config', 'models.json');

  if (fs.existsSync(path.dirname(srcConfig)) && !targets.includes(srcConfig)) {
    targets.push(srcConfig);
  }
  if (fs.existsSync(path.dirname(distConfig)) && !targets.includes(distConfig)) {
    targets.push(distConfig);
  }

  return targets;
}

/**
 * 执行 models.json 更新同步
 */
export async function updateModelsJson(options: UpdateModelsOptions = {}): Promise<UpdateModelsResult> {
  if (isUpdating) {
    console.warn('[ModelSync] ⚠️ 当前已有同步任务正在进行，跳过本次执行');
    return { success: false, error: 'Task already in progress' };
  }

  isUpdating = true;
  const tag = options.isStartup
    ? '[服务启动同步]'
    : options.isScheduled
    ? '[每日凌晨定时同步]'
    : '[手动触发同步]';

  console.log(`[ModelSync] ${tag} 开始从 ${MODELS_DEV_URL} 获取最新模型配置...`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'models-manager/1.0',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP 请求错误: ${res.status} ${res.statusText}`);
    }

    const data: any = await res.json();
    if (!data || typeof data !== 'object') {
      throw new Error('返回的数据格式无效');
    }

    const targetFiles = getTargetFilePaths();

    // 读取现有模型数据
    let existingModels: ModelConfig[] = [];
    for (const filePath of targetFiles) {
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            existingModels = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    const initialCount = existingModels.length;
    const modelMap = new Map<string, ModelConfig>();

    // 1. 保留已有模型的配置
    for (const item of existingModels) {
      if (item && typeof item.model === 'string' && item.model.trim()) {
        const id = item.model.trim();
        modelMap.set(id, {
          model: id,
          content_length: String(item.content_length || '200000'),
          max_token: String(item.max_token || '64000'),
          capabilities: Array.isArray(item.capabilities)
            ? [...item.capabilities]
            : ['completion', 'tools', 'thinking'],
        });
      }
    }

    // 2. 解析 models.dev 数据
    let newCount = 0;
    for (const provider of Object.values<any>(data)) {
      if (!provider || typeof provider !== 'object' || !provider.models) continue;

      for (const [mKey, m] of Object.entries<any>(provider.models)) {
        if (!m || typeof m !== 'object') continue;
        const id = (m.id || mKey || '').trim();
        if (!id) continue;

        const capsSet = new Set<string>(['completion']);
        if (m.tool_call) capsSet.add('tools');
        if (m.reasoning) capsSet.add('thinking');
        if (m.modalities?.input?.includes('image') || m.attachment) capsSet.add('vision');

        const context = Number(m.limit?.context || m.limit?.input) || 200000;
        const output = Number(m.limit?.output) || 64000;

        const processModelEntry = (modelId: string) => {
          if (!modelId) return;
          if (modelMap.has(modelId)) {
            // 已存在：合并模态能力，保留更大的上下文与 Token 上限
            const existing = modelMap.get(modelId)!;
            const mergedCaps = new Set(existing.capabilities || []);
            capsSet.forEach((c) => mergedCaps.add(c));
            existing.capabilities = Array.from(mergedCaps);

            if (context > Number(existing.content_length || 0)) {
              existing.content_length = String(context);
            }
            if (output > Number(existing.max_token || 0)) {
              existing.max_token = String(output);
            }
          } else {
            // 新模型：添加
            modelMap.set(modelId, {
              model: modelId,
              content_length: String(context),
              max_token: String(output),
              capabilities: Array.from(capsSet),
            });
            newCount++;
          }
        };

        // 处理完整 ID
        processModelEntry(id);

        // 如果 ID 包含斜杠（如 anthropic/claude-3-opus），若短 ID 未占用也一并登记
        if (id.includes('/')) {
          const shortId = id.split('/').pop()?.trim();
          if (shortId && !modelMap.has(shortId)) {
            processModelEntry(shortId);
          }
        }
      }
    }

    const finalModels = Array.from(modelMap.values());

    // 唯一性校验
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    for (const m of finalModels) {
      if (seenIds.has(m.model)) {
        duplicateIds.push(m.model);
      }
      seenIds.add(m.model);
    }

    if (duplicateIds.length > 0) {
      throw new Error(`检测到重复模型ID: ${duplicateIds.join(', ')}`);
    }

    // 写入文件
    const fileContent = JSON.stringify(finalModels, null, 2) + '\n';
    let writeSuccessCount = 0;
    for (const targetPath of targetFiles) {
      try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, fileContent, 'utf8');
        writeSuccessCount++;
      } catch (writeErr: any) {
        console.warn(`[ModelSync] 写入 ${targetPath} 失败:`, writeErr.message);
      }
    }

    console.log(`[ModelSync] ✅ ${tag} 模型更新成功！`);
    console.log(`[ModelSync] 📊 模型总数: ${finalModels.length} (原数量: ${initialCount}, 新增: ${finalModels.length - initialCount})`);
    console.log(`[ModelSync] 💾 已同步写入 ${writeSuccessCount} 处目标文件`);

    return {
      success: true,
      total: finalModels.length,
      newCount: finalModels.length - initialCount,
    };
  } catch (err: any) {
    console.error(`[ModelSync] ❌ ${tag} 更新失败:`, err.message);
    return {
      success: false,
      error: err.message,
    };
  } finally {
    isUpdating = false;
  }
}

/**
 * 计算距离下一个目标时间（默认每天凌晨 2 点）的毫秒数
 */
function getMsUntilTargetTime(targetHour = 2, targetMinute = 0): { ms: number; targetDate: Date } {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);

  // 如果当天设定的时间已过，则安排在明天同一时间
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return {
    ms: next.getTime() - now.getTime(),
    targetDate: next,
  };
}

/**
 * 启动每日凌晨 2 点定时更新调度器
 */
function scheduleNextDailyRun(): void {
  const { ms, targetDate } = getMsUntilTargetTime(2, 0);
  const hours = (ms / 3_600_000).toFixed(2);
  console.log(`[ModelSync] ⏰ 下一次每日定时同步将在: ${formatTimestamp(targetDate)} (约 ${hours} 小时后)`);

  schedulerTimer = setTimeout(async () => {
    console.log('[ModelSync] ⏰ 触发每日凌晨 2 点定时同步任务...');
    try {
      await updateModelsJson({ isScheduled: true });
    } catch (err: any) {
      console.error('[ModelSync] 定时同步任务发生未捕获异常:', err.message);
    } finally {
      // 安排下一次每日更新
      scheduleNextDailyRun();
    }
  }, ms);

  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }
}

/**
 * 初始化模型配置同步调度器
 * 1. 服务启动 3 秒后自动执行一次异步更新（避免阻塞服务启动）
 * 2. 每天凌晨 2 点自动定时执行一次更新
 */
export function initModelSyncScheduler(): void {
  console.log('[ModelSync] 正在初始化 models.json 自动同步调度服务...');

  // 1. 服务启动后稍作延迟（3秒）执行首次同步更新
  setTimeout(() => {
    updateModelsJson({ isStartup: true }).catch((err) => {
      console.error('[ModelSync] 启动时首次同步更新异常:', err);
    });
  }, 3000);

  // 2. 调度每日凌晨 2 点定时同步
  scheduleNextDailyRun();
}

/**
 * 停止模型同步调度器
 */
export function stopModelSyncScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    console.log('[ModelSync] 定时调度服务已停止');
  }
}
