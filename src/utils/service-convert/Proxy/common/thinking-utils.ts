/**
 * Thinking 相关工具函数
 *
 * 实现思考签名整流器和思考预算整流器，参考 CC Switch 的实现。
 * 用于自动检测和修复 thinking 参数相关的兼容性问题。
 */

// ========== 常量定义 ==========

/** 思考预算修复时设置的 budget_tokens 目标值 */
export const MAX_THINKING_BUDGET = 32000;

/** 思考预算修复时设置的 max_tokens 目标值 */
export const MAX_TOKENS_VALUE = 64000;

/** max_tokens 必须大于 thinking.budget_tokens 的最小值 */
export const MIN_MAX_TOKENS_FOR_BUDGET = 32001;

// ========== 类型定义 ==========

/** 思考预算快照 */
export interface ThinkingBudgetSnapshot {
  maxTokens: number | undefined;
  thinkingType: string | undefined;
  thinkingBudgetTokens: number | undefined;
}

/** 思考预算修复结果 */
export interface BudgetRectifyResult {
  applied: boolean;
  before: ThinkingBudgetSnapshot;
  after: ThinkingBudgetSnapshot;
}

// ========== 思考签名整流器 ==========

/**
 * 检测是否需要修复思考签名错误
 *
 * @param errorMessage API 返回的错误消息
 * @returns 是否需要修复
 */
export function shouldRectifyThinkingSignature(errorMessage: string): boolean {
  if (!errorMessage) return false;

  const lowerError = errorMessage.toLowerCase();

  // 检测特定的签名错误模式
  const patterns = [
    /invalid.*signature.*thinking/i,
    /thought signature is not valid/i,
    /must start with a thinking block/i,
    /expected.*thinking.*redacted_thinking/i,
    /signature.*field required/i,
    /signature.*extra inputs are not permitted/i,
    /thinking.*redacted_thinking blocks.*cannot be modified/i,
    /invalid request/i,
    /illegal request/i,
    /非法请求/i,
  ];

  return patterns.some(pattern => pattern.test(errorMessage));
}

/**
 * 修复 Anthropic 请求中的思考签名问题
 *
 * @param body 请求体
 * @returns 是否应用了修复
 */
export function rectifyThinkingSignature(body: Record<string, unknown>): boolean {
  let applied = false;

  // 遍历所有消息
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message !== 'object' || message === null) continue;

      const content = message.content;
      if (!Array.isArray(content)) continue;

      // 移除 thinking 和 redacted_thinking 块
      const filteredContent = content.filter((block: any) => {
        if (typeof block !== 'object' || block === null) return true;

        const blockType = block.type as string;
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          applied = true;
          return false;
        }
        return true;
      });

      // 清理遗留签名
      for (const block of filteredContent) {
        if (typeof block !== 'object' || block === null) continue;

        const blockObj = block as Record<string, unknown>;
        if ('signature' in blockObj) {
          delete blockObj.signature;
          applied = true;
        }
      }

      // 更新内容
      if (filteredContent.length !== content.length) {
        message.content = filteredContent;
      }
    }
  }

  return applied;
}

// ========== 思考预算整流器 ==========

/**
 * 检测是否需要修复思考预算错误
 *
 * @param errorMessage API 返回的错误消息
 * @returns 是否需要修复
 */
export function shouldRectifyThinkingBudget(errorMessage: string): boolean {
  if (!errorMessage) return false;

  const lowerError = errorMessage.toLowerCase();

  // 检测预算相关的错误模式
  const hasBudgetKeyword = lowerError.includes('budget_tokens') || lowerError.includes('budget tokens');
  const hasThinkingKeyword = lowerError.includes('thinking');
  const hasMinConstraint = lowerError.includes('1024') || lowerError.includes('>= 1024') || lowerError.includes('greater than or equal to 1024');

  return hasBudgetKeyword && hasThinkingKeyword && hasMinConstraint;
}

/**
 * 创建思考预算快照
 *
 * @param body 请求体
 * @returns 思考预算快照
 */
export function snapshotThinkingBudget(body: Record<string, unknown>): ThinkingBudgetSnapshot {
  const thinking = body.thinking as Record<string, unknown> | undefined;

  return {
    maxTokens: body.max_tokens as number | undefined,
    thinkingType: thinking?.type as string | undefined,
    thinkingBudgetTokens: thinking?.budget_tokens as number | undefined,
  };
}

/**
 * 修复思考预算错误
 *
 * @param body 请求体
 * @returns 修复结果
 */
export function rectifyThinkingBudget(body: Record<string, unknown>): BudgetRectifyResult {
  const snapshot = snapshotThinkingBudget(body);

  // 跳过自适应模式
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === 'adaptive') {
    return {
      applied: false,
      before: snapshot,
      after: snapshot,
    };
  }

  // 确保 thinking 对象存在
  if (!body.thinking || typeof body.thinking !== 'object') {
    body.thinking = {};
  }

  const thinkingObj = body.thinking as Record<string, unknown>;

  // 设置思考参数
  thinkingObj.type = 'enabled';
  thinkingObj.budget_tokens = MAX_THINKING_BUDGET;

  // 调整 max_tokens
  const currentMaxTokens = body.max_tokens as number | undefined;
  if (!currentMaxTokens || currentMaxTokens < MIN_MAX_TOKENS_FOR_BUDGET) {
    body.max_tokens = MAX_TOKENS_VALUE;
  }

  const afterSnapshot = snapshotThinkingBudget(body);

  return {
    applied: true,
    before: snapshot,
    after: afterSnapshot,
  };
}

// ========== 思考参数优化 ==========

/**
 * 检查模型是否使用自适应思考
 *
 * @param model 模型名称
 * @returns 是否使用自适应思考
 */
export function usesAdaptiveThinking(model: string): boolean {
  if (!model) return false;

  const normalizedModel = normalizeModelName(model);

  // 支持自适应思考的模型列表
  const adaptiveModels = [
    'fable-5',
    'mythos-5',
    'sonnet-5',
    'opus-4-8',
    'claude-opus-4-8',
    'claude-sonnet-5',
  ];

  return adaptiveModels.some(m => normalizedModel.includes(m));
}

/**
 * 标准化模型名称
 *
 * @param model 模型名称
 * @returns 标准化后的模型名称
 */
export function normalizeModelName(model: string): string {
  if (!model) return '';

  return model
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/_/g, '-');
}

/**
 * 优化思考参数
 *
 * @param body 请求体
 * @param enabled 是否启用思考优化
 */
export function optimizeThinkingParams(body: Record<string, unknown>, enabled: boolean = true): void {
  if (!enabled) return;

  const model = body.model as string;
  if (!model) return;

  const normalizedModel = normalizeModelName(model);

  // 跳过 Haiku 模型
  if (normalizedModel.includes('haiku')) {
    return;
  }

  // 确保 thinking 对象存在
  if (!body.thinking || typeof body.thinking !== 'object') {
    body.thinking = {};
  }

  const thinkingObj = body.thinking as Record<string, unknown>;

  // 自适应路径：新模型
  if (usesAdaptiveThinking(model)) {
    thinkingObj.type = 'adaptive';
    // 设置输出努力程度为 max
    if (!body.output_config || typeof body.output_config !== 'object') {
      body.output_config = {};
    }
    (body.output_config as Record<string, unknown>).effort = 'max';
  } else {
    // 遗留路径：旧模型
    thinkingObj.type = 'enabled';
    const maxTokens = body.max_tokens as number | undefined;
    thinkingObj.budget_tokens = (maxTokens || 4096) - 1;
  }
}