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
  const data = (await res.json()) as { choices: { message: ChatMessage }[] };
  return data.choices[0].message;
}
