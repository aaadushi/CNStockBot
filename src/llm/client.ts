/**
 * OpenAI 兼容协议的 LLM 客户端。
 * 国内可直连的服务（DeepSeek、通义千问 DashScope 兼容模式、Kimi、智谱）
 * 都提供 /chat/completions 端点，因此无需官方 SDK，一个 fetch 即可。
 */
import { config } from '../config.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export async function chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
  if (!config.llm.apiKey) {
    throw new Error('未配置 LLM_API_KEY，请复制 .env.example 为 .env 并填入 API Key');
  }
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    // 显式超时：防对端"连接建立但不返回 body"的半挂状态导致对话永久卡死
    signal: AbortSignal.timeout(config.llm.timeoutMs),
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM 请求失败 ${res.status}: ${body.slice(0, 300)}`);
  }
  let data: { choices?: { message: ChatMessage }[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error('LLM 响应不是合法 JSON（可能是网关错误页），请检查 LLM_BASE_URL 配置');
  }
  // 部分兼容服务业务错误时也返回 200 + 错误体，必须校验结构，否则报难解的 TypeError
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error(`LLM 响应格式异常（无 choices[0].message）：${JSON.stringify(data).slice(0, 300)}`);
  }
  return message;
}
