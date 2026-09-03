/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AssistantChatMessage, LLMMessage, PluginSettings } from '../types';
import { ExpandedConversationalWindow } from './reranker';

/**
 * Accurate, fast multilingual token estimator.
 */
export function estimateTokens(value: string): number {
  if (!value) return 0;
  let cjkCount = 0;
  let otherCount = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana & Katakana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul Syllables
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }

  return Math.ceil(cjkCount * 0.9 + otherCount / 3.4);
}

/**
 * Summarizes older conversation history into a concise deterministic summary block.
 */
export function summarizeHistory(history: AssistantChatMessage[]): string {
  return history
    .map((message) => {
      const compact = message.content.replace(/\s+/g, ' ').trim().slice(0, 180);
      return `${message.role}: ${compact}${message.content.length > compact.length ? '…' : ''}`;
    })
    .join('\n');
}

/**
 * Compacts and safely serializes JSON tool outputs to fit within character bounds.
 */
export function compactToolResult(content: string, maxChars = 12_000): string {
  if (content.length <= maxChars) return content;

  try {
    const parsed = JSON.parse(content);
    const compactNode = (value: any, depth = 0): any => {
      if (typeof value === 'string') {
        return value.slice(0, depth < 3 ? 2000 : 800);
      }
      if (Array.isArray(value)) {
        return value.slice(0, 20).map((item) => compactNode(item, depth + 1));
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, current]) => [key, compactNode(current, depth + 1)]),
        );
      }
      return value;
    };

    const safe = compactNode(parsed);
    safe.truncation = { ...(safe.truncation || {}), truncated: true };
    let serialized = JSON.stringify(safe);

    // Progressively pop message records from data array if still exceeding character limit
    const messagesArray = safe?.data?.messages || safe?.data?.hits;
    while (serialized.length > maxChars && Array.isArray(messagesArray) && messagesArray.length > 1) {
      messagesArray.pop();
      if (safe.truncation) safe.truncation.returned = messagesArray.length;
      serialized = JSON.stringify(safe);
    }

    if (serialized.length <= maxChars) return serialized;

    // Minimal fallback JSON preserving safety boundary and metadata
    return JSON.stringify({
      ok: Boolean(parsed.ok),
      code: parsed.code || 'compacted',
      summary: String(parsed.summary || 'Tool result compacted.').slice(0, 1000),
      untrustedData: Boolean(parsed.untrustedData),
      truncation: { truncated: true, returned: 0 },
    });
  } catch {
    return JSON.stringify({
      ok: false,
      code: 'invalid_tool_output',
      summary: 'Tool output could not be compacted safely.',
    });
  }
}

/**
 * Multi-tier evidence packing formatting conversational windows into token-budgeted prompt strings.
 */
export function packEvidenceIntoBudget(
  windows: ExpandedConversationalWindow[],
  maxTokens = 8000,
): { packedText: string; totalTokens: number; includedCount: number } {
  const parts: string[] = [];
  let currentTokens = 0;
  let includedCount = 0;

  for (let idx = 0; idx < windows.length; idx++) {
    const win = windows[idx];
    let block = '';

    if (idx < 3) {
      // Tier 1: Full Context with Reply Chain
      const replyText = win.replyChain.length
        ? `  [Replies]: ${win.replyChain.map((r) => `@${r.authorName}: ${r.content}`).join(' -> ')}\n`
        : '';
      const turnsText = win.messages
        .map((m) => `  [${new Date(m.timestamp).toISOString()}] @${m.authorName}: ${m.content}`)
        .join('\n');
      block = `[Hit ${idx + 1} | Score: ${win.compositeScore.toFixed(1)} | Channel: ${win.channelId}]\n${replyText}${turnsText}\n`;
    } else if (idx < 12) {
      // Tier 2: Standard Context
      const primary = win.anchorHit.candidate;
      block = `[Hit ${idx + 1}] [${new Date(primary.timestamp).toISOString()}] @${primary.authorName} in #${primary.channelId}: ${primary.content.slice(0, 250)}\n`;
    } else {
      // Tier 3: Compact One-Line Summary
      const primary = win.anchorHit.candidate;
      block = `[${new Date(primary.timestamp).toISOString().slice(0, 10)}] @${primary.authorName}: ${primary.content.slice(0, 80)}\n`;
    }

    const blockTokens = estimateTokens(block);
    if (currentTokens + blockTokens > maxTokens) {
      break;
    }

    parts.push(block);
    currentTokens += blockTokens;
    includedCount++;
  }

  return {
    packedText: parts.join('\n'),
    totalTokens: currentTokens,
    includedCount,
  };
}

/**
 * Assembles full conversation context while enforcing max estimated input token budget.
 */
export function buildConversationContext(
  systemContent: string,
  history: AssistantChatMessage[],
  userPrompt: string,
  settings: PluginSettings,
  maxEstimatedInputTokens = 32_000,
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

  const estimatedWindow = Math.min(Math.max(settings.maxTokens * 4, 8192), maxEstimatedInputTokens);
  const inputBudget = Math.max(1024, estimatedWindow - settings.maxTokens);

  // Evict oldest history turns if over token budget
  while (
    messages.length > 2 &&
    estimateTokens(messages.map((m) => String(m.content || '')).join('\n')) > inputBudget
  ) {
    messages.splice(1, 1);
  }

  return messages;
}
