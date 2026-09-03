/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  CompletionRequest,
  CompletionResult,
  LLMToolCall,
  PluginSettings,
  ProviderCapabilities,
  ToolDefinition,
} from '../types';

export interface TransportCallbacks {
  onToken?: (token: string) => void;
  onToolCallDelta?: (toolCalls: LLMToolCall[]) => void;
}

function normalizeTools(tools: ToolDefinition[], capabilities: ProviderCapabilities): ToolDefinition[] {
  return tools.map((tool) => {
    if (!capabilities.strictSchemas) return tool;
    const originallyRequired = new Set(tool.function.parameters.required || []);
    const properties = Object.fromEntries(Object.entries(tool.function.parameters.properties).map(([key, schema]: [string, any]) => [
      key,
      originallyRequired.has(key)
        ? schema
        : {
          ...schema,
          type: [schema.type, 'null'],
          ...(Array.isArray(schema.enum) ? { enum: [...schema.enum, null] } : {}),
        },
    ]));
    return {
      ...tool,
      function: {
        ...tool.function,
        strict: true,
        parameters: {
          ...tool.function.parameters,
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    };
  });
}
function mergeToolCalls(target: Map<number, { id: string; name: string; arguments: string }>, raw: any[]): void {
  for (const item of raw) {
    const index = Number(item.index) || 0;
    const existing = target.get(index) || { id: item.id || `call_${index}`, name: '', arguments: '' };
    if (item.id) existing.id = item.id;
    const name = item.function?.name;
    if (name) existing.name = name.startsWith(existing.name) ? name : existing.name + name;
    if (item.function?.arguments) existing.arguments += item.function.arguments;
    target.set(index, existing);
  }
}
function materialize(target: Map<number, { id: string; name: string; arguments: string }>): LLMToolCall[] {
  return Array.from(target.entries()).sort(([left], [right]) => left - right).map(([, item]) => item)
    .filter((item) => item.name).map((item) => ({
      id: item.id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments },
    }));
}

export async function consumeChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: TransportCallbacks = {},
): Promise<CompletionResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let buffer = '';
  let content = '';
  let finishReason: string | undefined;
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]' || trimmed.startsWith(':')) return;
    const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return; }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    finishReason = choice.finish_reason || finishReason;
    const delta = choice.delta || choice.message || {};
    const token = delta.content ?? choice.text;
    if (typeof token === 'string') {
      content += token;
      callbacks.onToken?.(token);
    }
    if (Array.isArray(delta.tool_calls)) {
      mergeToolCalls(toolCalls, delta.tool_calls);
      callbacks.onToolCallDelta?.(materialize(toolCalls));
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(consumeLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }
  const calls = materialize(toolCalls);
  return { content, toolCalls: calls.length ? calls : undefined, finishReason };
}

export class OpenAICompatibleTransport {
  constructor(
    private settings: PluginSettings,
    private capabilities: ProviderCapabilities,
  ) {}

  update(settings: PluginSettings, capabilities: ProviderCapabilities): void {
    this.settings = settings;
    this.capabilities = capabilities;
  }

  async complete(
    request: CompletionRequest,
    callbacks: TransportCallbacks = {},
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const baseUrl = (this.settings.baseUrl || 'http://localhost:8000/v1').trim().replace(/\/$/, '');
    const messages = request.messages.map((message) => message.role === 'developer' && !this.capabilities.developerMessages
      ? { ...message, role: 'system' as const }
      : message);
    const payload: Record<string, unknown> = {
      model: this.settings.model || 'default',
      messages,
      temperature: request.temperature ?? this.settings.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? this.settings.maxTokens ?? 2048,
      stream: request.stream !== false,
    };
    if (request.tools?.length && request.toolChoice !== 'none') {
      payload.tools = normalizeTools(request.tools, this.capabilities);
      payload.tool_choice = request.toolChoice || 'auto';
      if (this.capabilities.parallelToolCalls) payload.parallel_tool_calls = true;
    }
    const maxRetries = 3;
    let response: Response | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('LLM completion cancelled.');
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiKey?.trim() || 'local-no-auth'}`,
        },
        body: JSON.stringify(payload),
        signal,
      });
      if (response.status === 429 && attempt < maxRetries) {
        const retryHeader = response.headers.get('Retry-After');
        const retrySec = retryHeader ? parseFloat(retryHeader) : NaN;
        const delayMs = !isNaN(retrySec) && retrySec > 0
          ? retrySec * 1000 + 200
          : Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 400;
        console.warn(`[VencordAI] LLM rate limit (429). Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error(`LLM completion failed (${response?.status || 'unknown'}).`);
    if (request.stream !== false) {
      if (!response.body) throw new Error('LLM completion returned no stream.');
      return consumeChatCompletionStream(response.body, callbacks);
    }
    const json = await response.json();
    const choice = json.choices?.[0] || {};
    const result: CompletionResult = {
      content: choice.message?.content || choice.text || '',
      toolCalls: choice.message?.tool_calls,
      finishReason: choice.finish_reason,
    };
    if (result.content) callbacks.onToken?.(result.content);
    return result;
  }
}
