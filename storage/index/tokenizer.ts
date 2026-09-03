/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Standard English and Discord conversational stopwords.
 */
export const CONVERSATIONAL_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'll', 'm', 'me', 'might',
  'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'o', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 're', 's', 'same', 'she', 'should',
  'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 've',
  'very', 'was', 'wasn', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'won', 'would', 'y', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // Conversational filler & chat slang
  'lol', 'lmao', 'lmfao', 'omg', 'idk', 'tbh', 'imo', 'imho', 'btw', 'thx', 'thanks', 'pls', 'please',
  'ok', 'okay', 'yeah', 'yea', 'yep', 'nope', 'gg', 'hey', 'hello', 'hi', 'ur', 'u', 'r',
]);

export interface TokenizationResult {
  terms: string[];
  frequencies: Map<string, number>;
  totalTokens: number;
}

/**
 * Fast character code classification functions.
 */
function isPunctuationOrSymbolCode(code: number): boolean {
  if (code < 48) return true; // ASCII control, space, !"#$%&'()*+,-./ (hyphen 45 handled separately)
  if (code >= 58 && code <= 64) return true; // :;<=>?@
  if (code >= 91 && code <= 96 && code !== 95) return true; // [\]^` (underscore 95 handled separately)
  if (code >= 123 && code <= 191) return true; // {|}~ and Latin-1 symbols
  if (code >= 0x2000 && code <= 0x2BFF) return true; // General punctuation, currency, arrows, math, box, misc symbols
  if (code >= 0x2E00 && code <= 0x2E7F) return true; // Supplemental Punctuation
  if (code >= 0x3000 && code <= 0x303F) return true; // CJK Symbols and Punctuation (。, 、, 「, 」, 【, 】, 〜)
  if (
    (code >= 0xFF01 && code <= 0xFF0F) ||
    (code >= 0xFF1A && code <= 0xFF20) ||
    (code >= 0xFF3B && code <= 0xFF40) ||
    (code >= 0xFF5B && code <= 0xFF65) ||
    (code >= 0xFFE0 && code <= 0xFFEE) ||
    code === 0xFEFF
  ) {
    return true; // Fullwidth and halfwidth punctuation & symbols
  }
  return false;
}

export function isWordCharCode(code: number): boolean {
  if (
    (code >= 48 && code <= 57) ||  // 0-9
    (code >= 65 && code <= 90) ||  // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 45 || code === 95     // - _
  ) {
    return true;
  }
  if (code >= 192 && code <= 65535) {
    return !isPunctuationOrSymbolCode(code);
  }
  return false;
}

export function isCJKCharCode(code: number): boolean {
  return (
    (code >= 0x4E00 && code <= 0x9FFF) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4DBF) || // CJK Unified Ideographs Extension A
    (code >= 0x3040 && code <= 0x309F) || // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) || // Katakana
    (code >= 0x31F0 && code <= 0x31FF) || // Katakana Phonetic Extensions
    (code >= 0xAC00 && code <= 0xD7AF) || // Hangul Syllables
    (code >= 0x1100 && code <= 0x11FF) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318F) || // Hangul Compatibility Jamo
    (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
    (code >= 0xFF66 && code <= 0xFF9F)    // Halfwidth Katakana
  );
}

export function hasCJK(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isCJKCharCode(text.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * Cleans Discord-specific syntax (mentions, custom emoji, URLs) and normalizes Unicode punctuation.
 */
export function sanitizeDiscordText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<@!?(\d+)>/g, ' mention_$1 ') // User mentions
    .replace(/<#(\d+)>/g, ' channel_$1 ')   // Channel mentions
    .replace(/<@&(\d+)>/g, ' role_$1 ')     // Role mentions
    .replace(/<a?:(\w+):\d+>/g, ' $1 ')     // Custom emoji
    .replace(/https?:\/\/[^\s]+/g, (url) => {
      // Split URLs into host and path tokens
      try {
        const parsed = new URL(url);
        return ` ${parsed.hostname} ${parsed.pathname.replace(/[^\w]/g, ' ')} `;
      } catch {
        return ' ';
      }
    })
    .replace(/[“”„‟«»]/g, '"')               // Smart double quotes -> "
    .replace(/[‘’‚‛′‵]/g, "'")               // Smart single quotes -> '
    .replace(/[—―]/g, ' ')                   // Em-dashes / horizontal bars -> space
    .replace(/[–]/g, '-')                    // En-dash -> -
    .replace(/[…]/g, ' ')                    // Ellipsis -> space
    .replace(/[。、，．！？：；【】「」『』（）〔〕《》〈〉〜～・]/g, ' '); // CJK punctuation -> space
}

/**
 * Tokenizes text into normalized lower-case terms, computing exact term frequencies.
 */
export function tokenizeText(
  rawText: string,
  options: { removeStopwords?: boolean; minTokenLen?: number; maxTokenLen?: number } = {},
): TokenizationResult {
  const {
    removeStopwords = true,
    minTokenLen = 2,
    maxTokenLen = 64,
  } = options;

  const text = sanitizeDiscordText(rawText);
  const len = text.length;
  const frequencies = new Map<string, number>();
  const terms: string[] = [];
  let totalTokens = 0;

  const addTerm = (term: string) => {
    if (!term || term.length > maxTokenLen) return;
    const isCjk = hasCJK(term);
    if (term.length < minTokenLen && !isCjk) return;
    if (removeStopwords && CONVERSATIONAL_STOPWORDS.has(term)) return;

    totalTokens++;
    const currentCount = frequencies.get(term) || 0;
    if (currentCount === 0) {
      terms.push(term);
    }
    frequencies.set(term, currentCount + 1);
  };

  let start = -1;

  for (let i = 0; i <= len; i++) {
    const code = i < len ? text.charCodeAt(i) : 32;

    if (isWordCharCode(code)) {
      if (start === -1) {
        start = i;
      }
    } else {
      if (start !== -1) {
        let token = text.slice(start, i).toLowerCase();
        start = -1;

        // Strip leading/trailing dots or hyphens
        token = token.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
        if (!token) continue;

        if (hasCJK(token)) {
          // Add full CJK token
          addTerm(token);

          // Word segmentation via Intl.Segmenter if available
          if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
            try {
              const segmenter = new (Intl as any).Segmenter(['ja', 'zh', 'ko'], { granularity: 'word' });
              for (const seg of segmenter.segment(token)) {
                const segText = seg.segment.trim().toLowerCase();
                if (segText && segText !== token) {
                  addTerm(segText);
                }
              }
            } catch {
              // fallback if segmenter fails
            }
          }

          // Unigrams & Bigrams for CJK substrings
          const chars = Array.from(token);
          for (let c = 0; c < chars.length; c++) {
            const ch = chars[c];
            if (isCJKCharCode(ch.charCodeAt(0))) {
              addTerm(ch);
            }
          }
          for (let c = 0; c < chars.length - 1; c++) {
            const bi = chars[c] + chars[c + 1];
            addTerm(bi);
          }
        } else {
          addTerm(token);
        }
      }
    }
  }

  return { terms, frequencies, totalTokens };
}

/**
 * Extracts normalized query tokens for search, relaxing stopword removal if the query is very short.
 */
export function extractQueryTokens(query: string): string[] {
  if (!query || !query.trim()) return [];

  // If query is 1 or 2 words, do not remove stopwords (e.g. "who is", "the error")
  const rawSplit = query.trim().split(/\s+/);
  const allowStopwords = rawSplit.length <= 2;

  const result = tokenizeText(query, {
    removeStopwords: !allowStopwords,
    minTokenLen: 1,
  });

  return result.terms;
}
