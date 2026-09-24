// scripts/update-models.js
// 手动更新 models.json 脚本，复用 src/services/modelSyncService 的核心逻辑
const path = require('path');

let updateModelsJson;

try {
  // 如果已构建，优先使用 dist
  const service = require('../dist/services/modelSyncService');
  updateModelsJson = service.updateModelsJson;
} catch (e) {
  // 未构建或开发模式下使用 ts-node 执行 src
  try {
    require('ts-node').register({
      project: path.resolve(__dirname, '../tsconfig.json'),
      transpileOnly: true,
    });
    const service = require('../src/services/modelSyncService');
    updateModelsJson = service.updateModelsJson;
  } catch (err) {
    console.error('[update-models] 无法加载 modelSyncService:', err.message);
    process.exit(1);
  }
}

updateModelsJson({ isCli: true })
  .then((res) => {
    if (!res.success) {
      console.error(`[update-models] 更新失败: ${res.error || '未知错误'}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('[update-models] 执行异常:', err);
    process.exit(1);
  });
