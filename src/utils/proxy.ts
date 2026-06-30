/**
 * Proxy 工具函数 - Responses API 格式转换
 *
 * Responses API 请求 ↔ Chat Completion 请求 的字段映射，
 * 供 /v1/responses 端点使用。
 */

// ========== Responses API 格式转换 ==========

// 生成随机字符串
export function generateRandomString(length = 12): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length))
  }
  return result
}

function convertResponsesContentToChatContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content

  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const obj = content as Record<string, unknown>
      return (obj.text || obj.output_text || obj.input_text || JSON.stringify(content)) as string
    }
    return String(content ?? '')
  }

  const parts = content
    .map((item) => {
      if (typeof item === 'string') return { type: 'text', text: item }

      if (!item || typeof item !== 'object') return { type: 'text', text: String(item ?? '') }

      const obj = item as Record<string, unknown>
      if (
        obj.type === 'input_text' ||
        obj.type === 'output_text' ||
        obj.type === 'text'
      ) {
        return { type: 'text', text: (obj.text as string) || '' }
      }
      if (obj.type === 'input_image' && obj.image_url) {
        return { type: 'image_url', image_url: { url: (obj.image_url as any).url || obj.image_url } }
      }
      return {
        type: 'text',
        text: (obj.text as string) || (obj.output_text as string) || (obj.input_text as string) || JSON.stringify(item),
      }
    })
    .filter((item) => (item as any).type !== 'text' || (item as any).text !== '')

  if (parts.length === 1 && (parts[0] as any).type === 'text') {
    return (parts[0] as any).text
  }
  return parts
}

function convertResponsesInputToChatMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []

  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input || body.messages || []

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: String(input ?? '') })
    return messages
  }

  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item })
      continue
    }

    if (!item || typeof item !== 'object') continue

    const obj = item as Record<string, unknown>

    if (obj.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: (obj.call_id || obj.id || 'call_0') as string,
        content:
          typeof obj.output === 'string'
            ? (obj.output as string)
            : JSON.stringify(obj.output ?? ''),
      })
      continue
    }

    if (obj.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: (obj.call_id || obj.id || `call_${generateRandomString(8)}`) as string,
            type: 'function',
            function: {
              name: obj.name,
              arguments:
                typeof obj.arguments === 'string'
                  ? (obj.arguments as string)
                  : JSON.stringify(obj.arguments || {}),
            },
          },
        ],
      })
      continue
    }

    const role = obj.role === 'developer' ? 'system' : ((obj.role as string) || 'user')
    messages.push({
      role,
      content: convertResponsesContentToChatContent(
        obj.content ?? obj.text ?? obj.output ?? '',
      ),
    })
  }

  return messages
}

function convertResponsesToolsToChatTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined

  const converted = (tools as Array<Record<string, unknown>>)
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null

      if (tool.type === 'function') {
        return {
          type: 'function',
          function: {
            name: tool.name || (tool.function as any)?.name,
            description: tool.description || (tool.function as any)?.description || '',
            parameters:
              tool.parameters || (tool.function as any)?.parameters || { type: 'object', properties: {} },
          },
        }
      }
      if (tool.type && tool.function) return tool
      return null
    })
    .filter(Boolean)

  return converted.length > 0 ? converted : undefined
}

// Responses API 请求 → Chat Completion 请求
export function convertResponsesRequestToChatRequest(body: Record<string, unknown>): Record<string, unknown> {
  const chatBody: Record<string, unknown> = { ...body }
  ;(chatBody as any).messages = convertResponsesInputToChatMessages(body)

  delete chatBody.input
  delete chatBody.instructions
  delete chatBody.previous_response_id
  delete chatBody.store
  delete chatBody.metadata
  delete chatBody.reasoning
  delete chatBody.truncation
  delete chatBody.text

  if (body.max_output_tokens !== undefined) {
    chatBody.max_tokens = body.max_output_tokens
    delete chatBody.max_output_tokens
  }

  const tools = convertResponsesToolsToChatTools(body.tools)
  if (tools) {
    ;(chatBody as any).tools = tools
  } else {
    delete chatBody.tools
    delete chatBody.tool_choice
    delete chatBody.parallel_tool_calls
  }

  return chatBody
}

// Chat Completion 响应 → Responses API 响应
export function convertChatCompletionToResponse(
  chatCompletion: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const choice = (chatCompletion.choices && (chatCompletion.choices as any)[0]) || {}
  const message: any = choice.message || {}
  const output: Array<Record<string, unknown>> = []

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      const tc = toolCall as any
      output.push({
        id: tc.id || `fc_${generateRandomString(12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: tc.id || `call_${generateRandomString(12)}`,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      })
    }
  }

  if (typeof message.content === 'string' && message.content !== '') {
    output.push({
      id: `msg_${generateRandomString(12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: message.content,
          annotations: [],
        },
      ],
    })
  }

  return {
    id: (chatCompletion.id as string) || `resp_${generateRandomString(12)}`,
    object: 'response',
    created_at: (chatCompletion.created as number) || Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions || null,
    max_output_tokens: requestBody.max_output_tokens || requestBody.max_tokens || null,
    model: (chatCompletion.model as string) || requestBody.model,
    output,
    output_text: output
      .flatMap((item) => (item.content as Array<any>) || [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join(''),
    parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
    previous_response_id: requestBody.previous_response_id || null,
    reasoning: requestBody.reasoning || null,
    store: requestBody.store ?? false,
    temperature: requestBody.temperature ?? null,
    text: requestBody.text || { format: { type: 'text' } },
    tool_choice: requestBody.tool_choice || 'auto',
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? null,
    truncation: requestBody.truncation || 'disabled',
    usage: chatCompletion.usage || null,
  }
}
