/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { compileSafeRegex } from '../storage/regex';
import { isImageAttachment } from './media';
import { extractMessageSearchText } from './messageFormat';
import { discordGet } from './rest';
import { parseLocalSearchDate } from './search';
import { getLoadedMessages } from './stores';

const MAX_PATTERN_TEXT_LENGTH = 4000;

export interface LocalMessageFilter {
  query?: string;
  pattern?: string | RegExp;
  extractPattern?: boolean;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  authorId?: string;
  beforeDate?: string | Date;
  afterDate?: string | Date;
  duringDate?: string | Date;
  pinned?: boolean;
  mentions?: string;
}

/**
 * Compiles a string or RegExp pattern safely with global flag
 */
export function compileRegexSafely(pattern?: string | RegExp): RegExp | null {
  return pattern ? compileSafeRegex(pattern).regex : null;
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
 * Tokenizes and normalizes a search query into clean search tokens (Unicode-aware).
 */
export function extractSearchTokens(query: string): string[] {
  if (!query || typeof query !== 'string') return [];
  // Split on whitespace, quotes, and punctuation except hyphens/dots in words
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const RELEVANCE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'in', 'on', 'at', 'by', 'from', 'with',
  'is', 'was', 'were', 'are', 'be', 'been', 'that', 'this', 'it', 'its', 'of', 'about',
  'what', 'when', 'where', 'who', 'why', 'how', 'did', 'do', 'does', 'find', 'show',
]);

function escapeRegExpToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageMentionsUser(msg: DiscordMessage, targetUserId: string): boolean {
  if (Array.isArray(msg.mentions)) {
    for (const entry of msg.mentions as Array<string | { id?: string }>) {
      if (typeof entry === 'string' && entry === targetUserId) return true;
      if (entry && typeof entry === 'object' && entry.id === targetUserId) return true;
    }
  }
  if (msg.content) {
    if (new RegExp(`<@!?${escapeRegExpToken(targetUserId)}>`).test(msg.content)) return true;
  }
  return false;
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
  const searchable = extractMessageSearchText(msg);
  const author = `${msg.author?.username || ''} ${msg.author?.globalName || ''}`;
  const fullTextLower = `${searchable} ${author}`.toLowerCase();

  let score = 0;

  // 1. Exact continuous substring match (highest priority)
  if (fullTextLower.includes(queryLower)) {
    score += 100;
  }

  // 2. Tokenized multi-word matching (prefer non-stopwords when any exist)
  const rawTokens = extractSearchTokens(query);
  if (rawTokens.length === 0) return score > 0 ? score : 1;
  const nonStop = rawTokens.filter((t) => !RELEVANCE_STOPWORDS.has(t));
  const tokens = nonStop.length > 0 ? nonStop : rawTokens;

  let matchedTokens = 0;
  let wholeWordMatches = 0;
  for (const token of tokens) {
    if (tokenMatchesText(token, fullTextLower)) {
      matchedTokens++;
      try {
        const boundaryRe = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExpToken(token)}(?![\\p{L}\\p{N}_])`, 'u');
        if (boundaryRe.test(fullTextLower)) wholeWordMatches++;
      } catch {}
    }
  }

  const matchFraction = matchedTokens / tokens.length;

  if (matchFraction === 1) {
    // All tokens matched
    score += 60;
  } else if (matchFraction >= 0.5) {
    // Partial multi-word match (e.g. 2 of 3 tokens = 0.67 -> 30)
    score += Math.round(matchFraction * 45);
  } else if (tokens.length === 2 && matchedTokens === 1) {
    score += 20;
  }

  if (wholeWordMatches > 0) {
    score += Math.min(10, wholeWordMatches * 4);
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
  if (filter.pattern && !patternRegex) return [];
  const dateTime = (value: string | Date): number => parseLocalSearchDate(value)?.getTime() ?? NaN;
  const scoredList: { msg: DiscordMessage; score: number }[] = [];

  for (const msg of messages) {
    if (!msg) continue;

    // Filter by author ID
    if (filter.authorId && msg.author?.id !== filter.authorId) {
      continue;
    }

    // Filter by date range
    if (filter.duringDate) {
      const rawDate = filter.duringDate;
      const target = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? rawDate
        : new Date(rawDate).toLocaleDateString('en-CA');
      const msgDate = new Date(msg.timestamp).toLocaleDateString('en-CA');
      if (target !== msgDate) continue;
    }

    if (filter.pinned !== undefined && Boolean(msg.pinned) !== filter.pinned) continue;
    if (filter.mentions && !messageMentionsUser(msg, filter.mentions)) continue;
    if (filter.afterDate) {
      const afterTime = dateTime(filter.afterDate);
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime < afterTime) continue;
    }
    if (filter.beforeDate) {
      const beforeTime = dateTime(filter.beforeDate);
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
          const hasImgAttachment = msg.attachments?.some((a) => isImageAttachment(a));
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
        case 'sticker': {
          const stickerMsg = msg as DiscordMessage & { sticker_items?: unknown[]; stickers?: unknown[] };
          if (!stickerMsg.sticker_items?.length && !stickerMsg.stickers?.length) hasMatch = false;
          break;
        }
        default:
          // Unknown media types fail closed rather than matching every message.
          hasMatch = false;
      }
      if (!hasMatch) continue;
    }

    const fullMessageText = extractMessageSearchText(msg);

    // Filter by pattern if specified (bounded input limits worst-case regex cost)
    if (patternRegex) {
      patternRegex.lastIndex = 0;
      const patternMatches = patternRegex.test(fullMessageText.slice(0, MAX_PATTERN_TEXT_LENGTH));
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
 * Helper to fetch messages from Discord API using RestAPI with fetch fallback.
 */
export async function fetchDiscordMessagesApi(
  channelId: string,
  queryObj: Record<string, string>,
  retriesRemaining = 3,
  signal?: AbortSignal,
): Promise<DiscordMessage[]> {
  try {
    const data = await discordGet<DiscordMessage[]>(`/channels/${channelId}/messages`, queryObj, {
      signal,
      retries: retriesRemaining,
      fallbackToFetchOnHttpError: true,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error(`[VencordAI] Failed to fetch messages for channel ${channelId}:`, err);
    return [];
  }
}

/** Whole-number request limit in [1, max]; non-finite values use the fallback. */
function clampLimit(value: number, fallback: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.floor(value) : fallback, 1), max);
}

/**
 * Fetches messages around a specific message ID to provide conversational context
 */
export async function fetchSurroundingMessages(
  channelId: string,
  messageId: string,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<DiscordMessage[]> {
  const messages = await fetchDiscordMessagesApi(channelId, {
    around: messageId,
    limit: String(clampLimit(limit, 10, 50)),
  }, 3, signal);

  return [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * Fetches N messages from a channel (newest by default, backward via `beforeMessageId`, or forward via `afterMessageId`),
 * integrating local MessageStore cache and REST API.
 */
export async function fetchRecentMessages(
  channelId: string,
  limit: number = 50,
  beforeMessageId?: string,
  signal?: AbortSignal,
  afterMessageId?: string,
): Promise<DiscordMessage[]> {
  const forward = Boolean(afterMessageId && !beforeMessageId);
  const loadedFromCache = beforeMessageId || forward ? [] : getLoadedMessages(channelId);
  const targetLimit = clampLimit(limit, 50, 500);
  const fetchedMessages: DiscordMessage[] = [];
  let before = beforeMessageId;
  let after = afterMessageId;
  while (fetchedMessages.length < targetLimit) {
    const query: Record<string, string> = {
      limit: String(Math.min(100, targetLimit - fetchedMessages.length)),
    };
    if (forward && after) query.after = after;
    else if (before) query.before = before;
    const page = await fetchDiscordMessagesApi(channelId, query, 3, signal);
    if (page.length === 0) break;
    fetchedMessages.push(...page);
    if (forward) {
      after = page.reduce((newest, message) => BigInt(message.id) > BigInt(newest) ? message.id : newest, page[0].id);
    } else {
      before = page.reduce((oldest, message) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, page[0].id);
    }
    if (page.length < 100) break;
  }

  const combinedMap = new Map<string, DiscordMessage>();
  if (Array.isArray(loadedFromCache)) {
    loadedFromCache.forEach((m) => m?.id && combinedMap.set(m.id, m));
  }
  if (Array.isArray(fetchedMessages)) {
    fetchedMessages.forEach((m) => m?.id && combinedMap.set(m.id, m));
  }

  const allMessages = Array.from(combinedMap.values());
  if (allMessages.length > 0) {
    const sorted = allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return forward ? sorted.slice(0, targetLimit) : sorted.slice(-targetLimit);
  }

  return Array.isArray(loadedFromCache) ? loadedFromCache.slice(-targetLimit) : [];
}
