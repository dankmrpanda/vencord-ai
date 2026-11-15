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
import { normalizeBaseUrl, resolveModelIdentifier } from './modelSettings';

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
    let index = Number(item.index) || 0;
    if (item.index === undefined || item.index === null) {
      // Non-conforming servers omit `index`: a new call id starts a new call, otherwise continue the latest one.
      const latest = target.size ? Math.max(...target.keys()) : -1;
      index = latest < 0 ? 0 : item.id && item.id !== target.get(latest)!.id ? latest + 1 : latest;
    }
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

/** Longest a 429 Retry-After is honoured before retrying. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Short, single-line provider error detail with credentials removed: the configured key, key-shaped tokens
 * (including masked echoes such as "sk-****abcd"), bearer values and long opaque strings.
 */
async function providerErrorDetail(response: Response, apiKey: string): Promise<string> {
  let text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof message === 'string') text = message;
  } catch {}
  return redactProviderText(text, apiKey);
}

/** Redacts and caps provider-supplied error text; shared by non-OK responses and `error` events inside a stream. */
function redactProviderText(text: string, apiKey: string): string {
  const key = apiKey.trim();
  if (key) text = text.split(key).join('***');
  text = text
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\b(?:sk|pk|rk|gsk|key|api[-_]?key)[-_][\w*.-]{3,}/gi, '***')
    .replace(/[\w*.-]{32,}/g, '***')
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason || new Error('LLM completion cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function consumeChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: TransportCallbacks = {},
  apiKey = '',
): Promise<CompletionResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let buffer = '';
  let content = '';
  let finished = false;
  let finishReason: string | undefined;
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (finished || !trimmed || trimmed.startsWith(':')) return;
    const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (raw === '[DONE]') {
      finished = true;
      return;
    }
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (parsed?.error) {
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
      const detail = typeof message === 'string' ? redactProviderText(message, apiKey) : '';
      throw new Error(detail || 'LLM stream returned an error.');
    }
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
    while (!finished) {
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
    await reader.cancel().catch(() => undefined);
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
    signal?.throwIfAborted();
    // Throws a fixed message before any request unless the URL is absolute http(s) without credentials.
    const baseUrl = normalizeBaseUrl(this.settings.baseUrl);
    const messages = request.messages.map((message) => message.role === 'developer' && !this.capabilities.developerMessages
      ? { ...message, role: 'system' as const }
      : message);
    const payload: Record<string, unknown> = {
      model: await resolveModelIdentifier(this.settings),
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
        await response.body?.cancel().catch(() => undefined);
        const retryHeader = response.headers.get('Retry-After');
        const retrySec = retryHeader ? parseFloat(retryHeader) : NaN;
        const delayMs = !isNaN(retrySec) && retrySec > 0
          ? Math.min(retrySec * 1000 + 200, MAX_RETRY_DELAY_MS)
          : Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 400;
        console.warn(`[VencordAI] LLM rate limit (429). Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await waitForRetry(delayMs, signal);
        continue;
      }
      break;
    }
    if (!response) throw new Error('LLM completion failed (unknown).');
    if (!response.ok) {
      const detail = await providerErrorDetail(response, this.settings.apiKey || '');
      throw new Error(`LLM completion failed (${response.status})${detail ? `: ${detail}` : '.'}`);
    }
    if (request.stream !== false) {
      if (!response.body) throw new Error('LLM completion returned no stream.');
      return consumeChatCompletionStream(response.body, callbacks, this.settings.apiKey || '');
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
