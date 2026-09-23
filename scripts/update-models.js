const fs = require('fs');
const path = require('path');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const TARGET_FILE = path.resolve(__dirname, '../src/config/models.json');

async function updateModels() {
  console.log(`[update-models] 正在从 ${MODELS_DEV_URL} 获取最新模型配置...`);

  let data;
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
      throw new Error(`HTTP 错误: ${res.status} ${res.statusText}`);
    }
    data = await res.json();
  } catch (err) {
    console.error(`[update-models] 获取数据失败:`, err.message);
    process.exit(1);
  }

  // 读取已有的 models.json 文件
  let existingModels = [];
  if (fs.existsSync(TARGET_FILE)) {
    try {
      existingModels = JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8'));
      if (!Array.isArray(existingModels)) {
        existingModels = [];
      }
    } catch (e) {
      console.warn(`[update-models] 读取已有 ${TARGET_FILE} 失败，将重新生成:`, e.message);
      existingModels = [];
    }
  }

  const initialCount = existingModels.length;
  console.log(`[update-models] 已有模型数量: ${initialCount}`);

  // 使用 Map 保存并去重，以 model ID 为 key
  const modelMap = new Map();

  // 1. 先保留已有模型的配置
  for (const item of existingModels) {
    if (item && typeof item.model === 'string' && item.model.trim()) {
      const id = item.model.trim();
      modelMap.set(id, {
        model: id,
        content_length: String(item.content_length || '200000'),
        max_token: String(item.max_token || '64000'),
        capabilities: Array.isArray(item.capabilities) ? [...item.capabilities] : ['completion', 'tools', 'thinking'],
      });
    }
  }

  // 2. 解析 models.dev 数据
  let newCount = 0;
  for (const provider of Object.values(data)) {
    if (!provider || typeof provider !== 'object' || !provider.models) continue;

    for (const [mKey, m] of Object.entries(provider.models)) {
      if (!m || typeof m !== 'object') continue;
      const id = (m.id || mKey || '').trim();
      if (!id) continue;

      const capsSet = new Set(['completion']);
      if (m.tool_call) capsSet.add('tools');
      if (m.reasoning) capsSet.add('thinking');
      if (m.modalities?.input?.includes('image') || m.attachment) capsSet.add('vision');

      const context = Number(m.limit?.context || m.limit?.input) || 200000;
      const output = Number(m.limit?.output) || 64000;

      const processModelEntry = (modelId) => {
        if (!modelId) return;
        if (modelMap.has(modelId)) {
          // 已存在时，合并能力并采用更大上下文与输出限制
          const existing = modelMap.get(modelId);
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
          // 新增模型
          modelMap.set(modelId, {
            model: modelId,
            content_length: String(context),
            max_token: String(output),
            capabilities: Array.from(capsSet),
          });
          newCount++;
        }
      };

      // 记录完整模型 ID
      processModelEntry(id);

      // 若包含斜杠（如 anthropic/claude-3-opus），若短名称尚未记录，也一并补充短名称
      if (id.includes('/')) {
        const shortId = id.split('/').pop().trim();
        if (shortId && !modelMap.has(shortId)) {
          processModelEntry(shortId);
        }
      }
    }
  }

  // 转换为数组并确保严格唯一
  const finalModels = Array.from(modelMap.values());

  // 唯一性校验
  const seenIds = new Set();
  const duplicateIds = [];
  for (const m of finalModels) {
    if (seenIds.has(m.model)) {
      duplicateIds.push(m.model);
    }
    seenIds.add(m.model);
  }

  if (duplicateIds.length > 0) {
    console.error(`[update-models] 严重错误: 检测到重复模型ID:`, duplicateIds);
    process.exit(1);
  }

  // 写入文件
  fs.writeFileSync(TARGET_FILE, JSON.stringify(finalModels, null, 2) + '\n', 'utf8');

  console.log(`[update-models] ✅ 成功更新 ${TARGET_FILE}`);
  console.log(`[update-models] 📊 模型总数: ${finalModels.length} (原数量: ${initialCount}, 新增: ${finalModels.length - initialCount})`);
  console.log(`[update-models] 🔍 唯一性校验通过：0 重复项`);
}

updateModels();
