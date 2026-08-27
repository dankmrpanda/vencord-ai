/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { getAuthToken, getHTTP, getLoadedMessages } from './stores';

export interface LocalMessageFilter {
  query?: string;
  pattern?: string | RegExp;
  extractPattern?: boolean;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  authorId?: string;
  beforeDate?: string | Date;
  afterDate?: string | Date;
  duringDate?: string | Date;
}

/**
 * Compiles a string or RegExp pattern safely with global flag
 */
export function compileRegexSafely(pattern?: string | RegExp): RegExp | null {
  if (!pattern) return null;
  try {
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      return new RegExp(pattern.source, flags);
    }
    const trimmed = pattern.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      const flags = match[2].includes('g') ? match[2] : match[2] + 'g';
      return new RegExp(match[1], flags);
    }
    return new RegExp(trimmed, 'g');
  } catch (err) {
    console.warn('[VencordAI] Invalid regex pattern:', pattern, err);
    return null;
  }
}

/**
 * Safely extracts all matching occurrences of a regex pattern from text
 */
export function extractPatternMatches(text: string, pattern: string | RegExp): string[] {
  if (!text || !pattern) return [];
  const regex = compileRegexSafely(pattern);
  if (!regex) return [];

  try {
    const matches: string[] = [];
    let matchResult: RegExpExecArray | null;
    let guard = 0;
    while ((matchResult = regex.exec(text)) !== null && guard++ < 200) {
      if (matchResult[0]) {
        matches.push(matchResult[0]);
      } else {
        regex.lastIndex++;
      }
    }
    // Return unique values preserving order
    return Array.from(new Set(matches));
  } catch (err) {
    console.warn('[VencordAI] Failed to extract pattern matches:', err);
    return [];
  }
}

/**
 * Tokenizes and normalizes a search query into clean search tokens
 */
export function extractSearchTokens(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  // Split on whitespace, quotes, and punctuation except hyphens/dots in words
  return query
    .toLowerCase()
    .replace(/[^\w\s\.-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Checks if a specific token or range matches text (e.g. "3-5" matches "3-5", "3 - 5", "3 to 5", or "3" and "5")
 */
function tokenMatchesText(token: string, textLower: string): boolean {
  if (textLower.includes(token)) return true;

  // Handle number ranges like "3-5"
  const rangeMatch = token.match(/^(\d+)[-–—](\d+)$/);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    return (
      textLower.includes(`${start} - ${end}`) ||
      textLower.includes(`${start} to ${end}`) ||
      textLower.includes(`${start}-${end}`) ||
      (textLower.includes(start) && textLower.includes(end))
    );
  }

  // Handle minutes abbreviation: "minutes", "minute", "mins", "min"
  if (/^(?:mins?|minutes?)$/.test(token)) {
    return /\b(?:mins?|minutes?)\b/.test(textLower);
  }

  return false;
}

/**
 * Calculates a search relevance score for a message against query tokens
 */
export function scoreMessageRelevance(msg: DiscordMessage, query: string): number {
  if (!query || !query.trim()) return 1;

  const queryLower = query.trim().toLowerCase();
  const content = msg.content || '';
  const attachments = msg.attachments?.map((a) => a.filename).join(' ') || '';
  const embeds = msg.embeds?.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ') || '';
  const author = `${msg.author?.username || ''} ${msg.author?.globalName || ''}`;
  const fullTextLower = `${content} ${attachments} ${embeds} ${author}`.toLowerCase();

  let score = 0;

  // 1. Exact continuous substring match (highest priority)
  if (fullTextLower.includes(queryLower)) {
    score += 100;
  }

  // 2. Tokenized multi-word matching
  const tokens = extractSearchTokens(query);
  if (tokens.length === 0) return score > 0 ? score : 1;

  let matchedTokens = 0;
  for (const token of tokens) {
    if (tokenMatchesText(token, fullTextLower)) {
      matchedTokens++;
    }
  }

  const matchFraction = matchedTokens / tokens.length;

  if (matchFraction === 1) {
    // All tokens matched
    score += 60;
  } else if (matchFraction >= 0.7) {
    // High token match fraction (e.g. 3 of 4 tokens)
    score += Math.round(matchFraction * 40);
  } else if (tokens.length === 2 && matchedTokens === 1) {
    score += 20;
  }

  return score;
}

/**
 * Filters a list of Discord messages locally according to search criteria
 */
export function filterMessagesLocally(
  messages: DiscordMessage[],
  filter: LocalMessageFilter
): DiscordMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const rawQuery = filter.query?.trim();

  // Prepare pattern regex if present
  const patternRegex = compileRegexSafely(filter.pattern);
  const scoredList: { msg: DiscordMessage; score: number }[] = [];

  for (const msg of messages) {
    if (!msg) continue;

    // Filter by author ID
    if (filter.authorId && msg.author?.id !== filter.authorId) {
      continue;
    }

    // Filter by date range
    if (filter.duringDate) {
      const targetDate = new Date(filter.duringDate).toISOString().slice(0, 10);
      const msgDate = new Date(msg.timestamp).toISOString().slice(0, 10);
      if (targetDate !== msgDate) continue;
    }
    if (filter.afterDate) {
      const afterTime = new Date(filter.afterDate).getTime();
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime < afterTime) continue;
    }
    if (filter.beforeDate) {
      const beforeTime = new Date(filter.beforeDate).getTime();
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime > beforeTime) continue;
    }

    // Filter by 'has' media type
    if (filter.has) {
      let hasMatch = true;
      switch (filter.has) {
        case 'link': {
          const hasUrlInContent = /https?:\/\/[^\s]+/i.test(msg.content || '');
          const hasUrlInEmbeds = Boolean(msg.embeds?.some((e) => e.url || e.title || e.description));
          if (!hasUrlInContent && !hasUrlInEmbeds) hasMatch = false;
          break;
        }
        case 'file': {
          if (!msg.attachments || msg.attachments.length === 0) hasMatch = false;
          break;
        }
        case 'image': {
          const hasImgAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('image/') ||
              /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(a.filename || a.url || '')
          );
          const hasImgEmbed = msg.embeds?.some((e) => Boolean(e.image || e.thumbnail));
          if (!hasImgAttachment && !hasImgEmbed) hasMatch = false;
          break;
        }
        case 'video': {
          const hasVideoAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('video/') ||
              /\.(mp4|webm|mov|mkv|avi)$/i.test(a.filename || a.url || '')
          );
          const hasVideoEmbed = msg.embeds?.some((e) => e.type === 'video');
          if (!hasVideoAttachment && !hasVideoEmbed) hasMatch = false;
          break;
        }
        case 'sound': {
          const hasSoundAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('audio/') ||
              /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(a.filename || a.url || '')
          );
          if (!hasSoundAttachment) hasMatch = false;
          break;
        }
        case 'embed': {
          if (!msg.embeds || msg.embeds.length === 0) hasMatch = false;
          break;
        }
      }
      if (!hasMatch) continue;
    }

    const fullMessageText = `${msg.content || ''} ${msg.attachments?.map((a) => a.filename).join(' ') || ''} ${msg.embeds?.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ') || ''}`;

    // Filter by pattern if specified
    if (patternRegex) {
      patternRegex.lastIndex = 0;
      const patternMatches = patternRegex.test(fullMessageText);
      if (!patternMatches) {
        continue;
      }
    }

    let score = 1;
    if (rawQuery) {
      score = scoreMessageRelevance(msg, rawQuery);
      if (score <= 0 && !patternRegex) continue;
      if (score <= 0 && patternRegex) score = 10;
    }

    if (patternRegex) {
      score += 80;
    }

    scoredList.push({ msg, score });
  }

  // Sort by score descending (highest relevance first), then timestamp
  scoredList.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return new Date(b.msg.timestamp).getTime() - new Date(a.msg.timestamp).getTime();
  });

  return scoredList.map((item) => item.msg);
}

/**
 * Helper to fetch messages from Discord API using RestAPI with fetch fallback
 */
async function fetchDiscordMessagesApi(
  channelId: string,
  queryObj: Record<string, string>
): Promise<DiscordMessage[]> {
  const relativeEndpoint = `/channels/${channelId}/messages`;
  const http = getHTTP();

  if (http && typeof http.get === 'function') {
    try {
      const res = await http.get({ url: relativeEndpoint, query: queryObj });
      const body = res?.body ?? res;
      if (Array.isArray(body)) return body;
    } catch (httpErr) {
      console.warn('[VencordAI] RestAPI.get failed, falling back to fetch:', httpErr);
    }
  }

  try {
    const token = getAuthToken();
    const qs = new URLSearchParams(queryObj).toString();
    const fullUrl = `https://discord.com/api/v9${relativeEndpoint}?${qs}`;
    const response = await fetch(fullUrl, {
      headers: {
        Authorization: token || '',
        'Content-Type': 'application/json',
      },
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error(`[VencordAI] Failed to fetch messages for channel ${channelId}:`, err);
  }

  return [];
}

/**
 * Fetches messages around a specific message ID to provide conversational context
 */
export async function fetchSurroundingMessages(
  channelId: string,
  messageId: string,
  limit: number = 10
): Promise<DiscordMessage[]> {
  const messages = await fetchDiscordMessagesApi(channelId, {
    around: messageId,
    limit: String(Math.min(limit, 50)),
  });

  return [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * Fetches the latest N messages from a channel, integrating local MessageStore cache and REST API
 */
export async function fetchRecentMessages(
  channelId: string,
  limit: number = 50
): Promise<DiscordMessage[]> {
  const loadedFromCache = getLoadedMessages(channelId);
  const targetLimit = Math.min(Math.max(limit, 1), 100);
  const fetchedMessages = await fetchDiscordMessagesApi(channelId, {
    limit: String(targetLimit),
  });

  const combinedMap = new Map<string, DiscordMessage>();
  if (Array.isArray(loadedFromCache)) {
    loadedFromCache.forEach((m) => m?.id && combinedMap.set(m.id, m));
  }
  if (Array.isArray(fetchedMessages)) {
    fetchedMessages.forEach((m) => m?.id && combinedMap.set(m.id, m));
  }

  // If user requested limit > 100 and we have an oldest message, fetch additional pages
  if (limit > 100 && fetchedMessages.length > 0) {
    try {
      const oldestId = [...fetchedMessages].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )[0]?.id;
      if (oldestId) {
        const remainingLimit = Math.min(limit - 100, 100);
        const secondBatch = await fetchDiscordMessagesApi(channelId, {
          before: oldestId,
          limit: String(remainingLimit),
        });
        if (Array.isArray(secondBatch)) {
          secondBatch.forEach((m) => m?.id && combinedMap.set(m.id, m));
        }
      }
    } catch {}
  }

  const allMessages = Array.from(combinedMap.values());
  if (allMessages.length > 0) {
    return allMessages
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-limit);
  }

  return Array.isArray(loadedFromCache) ? loadedFromCache.slice(-limit) : [];
}

/**
 * Formats a Discord message into a structured, readable string for the LLM
 */
export function formatMessageForLLM(msg: DiscordMessage, channelName?: string): string {
  const author = msg.author?.globalName || msg.author?.username || 'Unknown';
  const authorId = msg.author?.id || '';
  const date = new Date(msg.timestamp).toISOString().replace('T', ' ').slice(0, 19);
  const chInfo = channelName ? ` [#${channelName}]` : '';

  let text = `[${date}]${chInfo} ${author} (${authorId}) [ID:${msg.id}]: ${msg.content || ''}`;

  if (msg.attachments && msg.attachments.length > 0) {
    const attachmentSummaries = msg.attachments.map(
      (a) => `[Attachment: ${a.filename} (${a.content_type || 'file'}) - ${a.url}]`
    );
    text += `\n  ${attachmentSummaries.join('\n  ')}`;
  }

  if (msg.embeds && msg.embeds.length > 0) {
    const embedSummaries = msg.embeds
      .filter((e) => e.title || e.description || e.url)
      .map((e) => `[Embed: "${e.title || ''}" - ${e.description || e.url || ''}]`);
    if (embedSummaries.length > 0) {
      text += `\n  ${embedSummaries.join('\n  ')}`;
    }
  }

  return text;
}

/**
 * Formats a Discord message for LLM and annotates any extracted pattern values
 */
export function formatMessageWithPattern(
  msg: DiscordMessage,
  channelName?: string,
  pattern?: string | RegExp
): { formatted: string; matchedValues: string[] } {
  let formatted = formatMessageForLLM(msg, channelName);
  let matchedValues: string[] = [];

  if (pattern) {
    const fullText = `${msg.content || ''} ${msg.attachments?.map((a) => a.filename).join(' ') || ''} ${msg.embeds?.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ') || ''}`;
    matchedValues = extractPatternMatches(fullText, pattern);
    if (matchedValues.length > 0) {
      formatted += `\n  [Matched Pattern Value(s): ${matchedValues.map((v) => `"${v}"`).join(', ')}]`;
    }
  }

  return { formatted, matchedValues };
}

/**
 * Encodes an image attachment URL to base64 for vision models
 */
export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error('[VencordAI] Failed to fetch image as base64:', err);
    throw err;
  }
}
