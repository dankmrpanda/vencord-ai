/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AssistantChatMessage, LLMMessage, PluginSettings } from '../types';
export const estimateTokens = (value: string): number => Math.ceil(value.length / 3.2);
function summarizeHistory(history: AssistantChatMessage[]): string {
  return history.map((message) => {
    const compact = message.content.replace(/\s+/g, ' ').slice(0, 180);
    return `${message.role}: ${compact}${message.content.length > compact.length ? '…' : ''}`;
  }).join('\n');
}
export function compactToolResult(content: string, maxChars = 12_000): string {
  if (content.length <= maxChars) return content;
  try {
    const parsed = JSON.parse(content);
    const compact = (value: any, depth = 0): any => {
      if (typeof value === 'string') return value.slice(0, depth < 3 ? 2000 : 800);
      if (Array.isArray(value)) return value.slice(0, 20).map((item) => compact(item, depth + 1));
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, current]) => [key, compact(current, depth + 1)]));
      }
      return value;
    };
    const safe = compact(parsed);
    safe.truncation = { ...(safe.truncation || {}), truncated: true };
    let serialized = JSON.stringify(safe);
    while (serialized.length > maxChars && Array.isArray(safe?.data?.messages) && safe.data.messages.length > 1) {
      safe.data.messages.pop();
      serialized = JSON.stringify(safe);
    }
    if (serialized.length <= maxChars) return serialized;
    return JSON.stringify({
      ok: Boolean(parsed.ok),
      code: parsed.code || 'compacted',
      summary: String(parsed.summary || 'Tool result compacted.').slice(0, 1000),
      untrustedData: Boolean(parsed.untrustedData),
      truncation: { truncated: true, returned: 0 },
    });
  } catch {}
  return JSON.stringify({ ok: false, code: 'invalid_tool_output', summary: 'Tool output could not be compacted safely.' });
}
export function buildConversationContext(
  systemContent: string,
  history: AssistantChatMessage[],
  userPrompt: string,
  settings: PluginSettings,
): LLMMessage[] {
  const maxMessages = Math.max(1, settings.maxContextMessages || 12);
  const selected = history.slice(-maxMessages);
  const older = history.slice(0, Math.max(0, history.length - selected.length));
  const messages: LLMMessage[] = [{ role: 'developer', content: systemContent }];
  if (older.length) {
    messages.push({
      role: 'system',
      content: `[Deterministic summary of older session history]\n${summarizeHistory(older).slice(0, 3000)}`,
    });
  }
  selected.forEach((message) => messages.push({ role: message.role, content: message.content }));
  messages.push({ role: 'user', content: userPrompt });
  const estimatedWindow = Math.max(settings.maxTokens * 4, 8192);
  const inputBudget = Math.max(1024, estimatedWindow - settings.maxTokens);
  while (messages.length > 2 && estimateTokens(messages.map((message) => String(message.content || '')).join('\n')) > inputBudget) {
    messages.splice(1, 1);
  }
  return messages;
}
