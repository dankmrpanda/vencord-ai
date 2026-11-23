/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Zero-Mutation Assurance: Enforces that HTTP methods and endpoints are strictly read-only.
 */
export class MutationSecurityError extends Error {
  constructor(message: string) {
    super(`[Security Guardrail Violation] ${message}`);
    this.name = 'MutationSecurityError';
  }
}

export function assertReadOnlyOperation(method: string, endpoint: string): void {
  const normalizedMethod = (method || 'GET').trim().toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    throw new MutationSecurityError(
      `Forbidden HTTP method '${normalizedMethod}' for endpoint '${endpoint}'. Only read-only operations are permitted.`,
    );
  }
}

/**
 * Strips null/control characters (preserving `\n`, `\r`, `\t`), Unicode bidi overrides,
 * zero-width / invisible characters (preserving ZWNJ/ZWJ for emoji and scripts), and
 * Unicode tag characters (`U+E0000`–`U+E007F`).
 */
export function stripInvisibleAndBidi(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u200B\u2060-\u2064\uFEFF]/g, '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '');
}

/**
 * Sanitizes untrusted message content, stripping dangerous control characters,
 * bidirectional Unicode overrides, and neutralizing LLM injection sequences.
 */
export function sanitizeUntrustedContent(text?: string | null): string {
  if (!text || typeof text !== 'string') return '';

  // All deletions run before token rewrites so invisible characters cannot split a token.
  return stripInvisibleAndBidi(text)
    // Neutralize LLM special tokens / prompt hijacking markers. `<|name|>` covers ChatML, Llama 3,
    // harmony and similar templates; Gemma uses bare turn tags. Llama 2 `<s>` is left alone (ordinary HTML).
    .replace(/<\|([a-z0-9_]{1,40})\|>/gi, '[$1]')
    // DeepSeek uses fullwidth bars (U+FF5C), e.g. `<｜User｜>` and `<｜end▁of▁sentence｜>`.
    // Brackets are excluded so a token rewritten by another rule (`<｜<think>｜>`) cannot match on a second pass.
    .replace(/<｜([^｜<>[\]\n]{1,40})｜>/g, '[$1]')
    .replace(/<(\/?)(start_of_turn|end_of_turn)>/gi, '[$1$2]')
    // Gemma 4 thought, call, response, and turn control tokens.
    .replace(/<\|?(thought|turn)\|?>/gi, '[$1]')
    .replace(/<\|(call|response):/gi, '[$1:')
    .replace(/<(call|response)\|>/gi, '[$1]')
    // Qwen/Hermes tool and reasoning tags.
    .replace(/<(\/?)(tool_call|tool_response|think|tools)>/gi, '[$1$2]')
    // Mistral control tokens. This runs after the bar-token rewrites, so `<|SYSTEM_PROMPT|>` ends up here too.
    .replace(/\[(\/?)(SYSTEM_PROMPT|TOOL_CALLS|TOOL_RESULTS|TOOL_CONTENT|AVAILABLE_TOOLS)\]/gi, '[$1$2_TAG]')
    .replace(/\[INST\]/gi, '[INST_TAG]')
    .replace(/\[\/INST\]/gi, '[/INST_TAG]')
    .replace(/<<SYS>>/gi, '<<SYS_TAG>>')
    .replace(/<\/SYS>>/gi, '<</SYS_TAG>>')
    // Horizontal whitespace only (Unicode included): `\s` would match a preceding blank line and quote that line instead of the heading.
    .replace(/^([^\S\r\n\u2028\u2029]*#{1,6}[^\S\r\n\u2028\u2029]*(?:system|instructions|override|admin))/gim, '> $1')
    .trim();
}
