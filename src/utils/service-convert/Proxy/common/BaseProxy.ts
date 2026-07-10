/**
 * BaseProxy — 代理转换基类
 *
 * 定义完整的代理/转换生命周期，参考 cc-switch 的转换模式：
 *
 *   convert()
 *     ├── 1. validate()           — 输入校验
 *     ├── 2. optimizeInput()      — 设置默认值、清理无效字段
 *     ├── 3. transformRequest()   — 请求格式转换（如 Anthropic → Chat/Responses）
 *     ├── 4. buildEndpoint()      — 构建上游 URL
 *     ├── 5. proxy()              — HTTP 转发（SSE 流或 JSON）
 *     ├── 6. transformResponse()  — 响应格式转换（反向）
 *     └── 7. optimizeOutput()     — 最终输出处理
 *
 * 子类只需覆写需要定制的步骤，未覆写的步骤走默认直通逻辑。
 *
 * @template TInput  输入类型
 * @template TOutput 输出类型
 * @template TBody   请求体类型（转换后发给上游的格式）
 */
export default abstract class BaseProxy<TInput = any, TOutput = any, TBody = Record<string, unknown>> {

  // ========== 生命周期步骤（子类覆写） ==========

  /**
   * 1. 输入校验 — 检查必填字段，抛出明确错误
   * 默认直通（不校验）
   */
  protected validate(input: TInput): void | never {
    // 默认不校验，子类按需覆写
  }

  /**
   * 2. 输入优化 — 设置默认值、清理字段、归一化结构
   * 默认直通
   */
  protected optimizeInput(input: TInput): TInput {
    return input;
  }

  /**
   * 3. 请求格式转换 — 将输入格式转换为目标 API 格式
   *
   * 参考 cc-switch：
   * - Anthropic → OpenAI Chat：system 提取、tool_use 提升、thinking 处理
   * - Anthropic → Responses：system→instructions、tool_use→function_call
   * - 纯代理模式：直接返回 body（不转换）
   *
   * 默认直通（返回 input 中的 body 字段）
   */
  protected transformRequest(input: TInput): TBody {
    return ((input as any).body ?? input) as unknown as TBody;
  }

  /**
   * 4. 构建上游端点 URL
   * 默认使用 config.baseUrl + 路径
   */
  protected buildEndpoint(input: TInput): string {
    const config = (input as any).config;
    return `${config?.baseUrl ?? ''}/chat/completions`;
  }

  /**
   * 5. HTTP 代理转发 — 发送请求到上游并返回 Response
   * 默认实现：POST JSON + SSE
   */
  protected async proxy(input: TInput, body: TBody, endpoint: string): Promise<any> {
    const config = (input as any).config;
    const controller = new AbortController();
    const timeoutMs = config?.timeoutMs ?? 300_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config?.apiKey ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        throw new Error(`${config?.providerLabel ?? 'Upstream'} API error (${response.status}): ${errorMessage}`);
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 6. 响应格式转换 — 将上游响应转换为目标格式
   *
   * 参考 cc-switch：
   * - OpenAI Chat → Anthropic：choices→content、tool_calls→tool_use
   * - OpenAI Responses → Anthropic：output→content、function_call→tool_use
   * - 纯代理模式：直传
   *
   * 默认直传
   */
  protected transformResponse(upstreamResponse: any, originalInput: TInput): any {
    return upstreamResponse;
  }

  /**
   * 7. 输出优化 — 最终处理（日志、统计等）
   * 默认直传
   */
  protected optimizeOutput(response: any, originalInput: TInput): TOutput {
    return response as TOutput;
  }

  // ========== 核心执行流程 ==========

  /**
   * 执行完整的代理转换流程
   *
   * 子类通常不需要覆写此方法，而是覆写上面的各个步骤。
   */
  public async convert(input: TInput): Promise<TOutput> {
    // 1. 校验
    this.validate(input);

    // 2. 输入优化
    const optimizedInput = this.optimizeInput(input);

    // 3. 请求格式转换
    const transformedBody = this.transformRequest(optimizedInput);

    // 4. 构建端点
    const endpoint = this.buildEndpoint(optimizedInput);

    // 5. HTTP 转发
    const upstreamResponse = await this.proxy(optimizedInput, transformedBody, endpoint);

    // 6. 响应格式转换
    const convertedResponse = await this.transformResponse(upstreamResponse, optimizedInput);

    // 7. 输出优化
    return this.optimizeOutput(convertedResponse, optimizedInput);
  }

  // ========== 内置日志 ==========

  protected log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]): void {
    const tag = `[${this.constructor.name}]`;
    console[level](`${tag} ${message}`, ...args);
  }
}
