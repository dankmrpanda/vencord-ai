/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchImageAsBase64 } from '../discord/messages';
import { LLMMessage, LLMToolCall, PluginSettings, ToolDefinition } from '../types';

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onToolCallDelta?: (toolCalls: LLMToolCall[]) => void;
}

export class OpenAICompatibleClient {
  private settings: PluginSettings;

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  public updateSettings(settings: PluginSettings) {
    this.settings = settings;
  }

  /**
   * Executes a chat completion request with streaming support and tool calling
   */
  public async chatCompletion(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<{ content: string; toolCalls?: LLMToolCall[] }> {
    let cleanBaseUrl = (this.settings.baseUrl || 'http://localhost:8000/v1').trim();
    if (cleanBaseUrl.endsWith('/')) {
      cleanBaseUrl = cleanBaseUrl.slice(0, -1);
    }
    const url = `${cleanBaseUrl}/chat/completions`;

    const authKey = this.settings.apiKey?.trim() || 'local-no-auth';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authKey}`,
    };

    const payload: Record<string, any> = {
      model: this.settings.model || 'default',
      messages,
      temperature: this.settings.temperature ?? 0.7,
      max_tokens: this.settings.maxTokens ?? 2048,
      stream: true,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`LLM API Error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    let accumulatedContent = '';
    const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              const content = delta?.content ?? choice.message?.content ?? choice.text;
              if (content) {
                accumulatedContent += content;
                callbacks?.onToken?.(content);
              }

              const rawToolCalls = delta?.tool_calls ?? choice.message?.tool_calls;
              if (rawToolCalls && Array.isArray(rawToolCalls)) {
                for (const tc of rawToolCalls) {
                  const idx = tc.index ?? 0;
                  const existing = accumulatedToolCalls.get(idx) || {
                    id: tc.id || `call_${idx}`,
                    name: tc.function?.name || '',
                    arguments: '',
                  };

                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) {
                    if (!existing.name) {
                      existing.name = tc.function.name;
                    } else if (!existing.name.includes(tc.function.name)) {
                      existing.name += tc.function.name;
                    }
                  }
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments;

                  accumulatedToolCalls.set(idx, existing);
                }

                const currentToolCalls: LLMToolCall[] = Array.from(
                  accumulatedToolCalls.values()
                )
                  .filter((t) => Boolean(t.name))
                  .map((t) => ({
                    id: t.id,
                    type: 'function',
                    function: {
                      name: t.name,
                      arguments: t.arguments,
                    },
                  }));

                if (currentToolCalls.length > 0) {
                  callbacks?.onToolCallDelta?.(currentToolCalls);
                }
              }
            } catch (parseErr) {
              // Ignore non-JSON lines or partial frames
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCallsResult: LLMToolCall[] = Array.from(accumulatedToolCalls.values())
      .filter((t) => Boolean(t.name))
      .map((t) => ({
        id: t.id,
        type: 'function',
        function: {
          name: t.name,
          arguments: t.arguments,
        },
      }));

    return {
      content: accumulatedContent,
      toolCalls: toolCallsResult.length > 0 ? toolCallsResult : undefined,
    };
  }

  /**
   * Helper to perform a single vision query on an image
   */
  public async analyzeImage(
    imageUrl: string,
    question: string,
    signal?: AbortSignal
  ): Promise<string> {
    let cleanBaseUrl = (this.settings.baseUrl || 'http://localhost:8000/v1').trim();
    if (cleanBaseUrl.endsWith('/')) cleanBaseUrl = cleanBaseUrl.slice(0, -1);
    const url = `${cleanBaseUrl}/chat/completions`;

    const authKey = this.settings.apiKey?.trim() || 'local-no-auth';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authKey}`,
    };

    let resolvedImageUrl = imageUrl;
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      try {
        resolvedImageUrl = await fetchImageAsBase64(imageUrl);
      } catch (err) {
        console.warn('[VencordAI] Could not convert image to base64, passing original URL:', err);
      }
    }

    const payload = {
      model: this.settings.model || 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question || 'Please describe this image and any text or key elements in it.' },
            { type: 'image_url', image_url: { url: resolvedImageUrl } },
          ],
        },
      ],
      max_tokens: 1000,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Vision query failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'No image description returned.';
  }
}
