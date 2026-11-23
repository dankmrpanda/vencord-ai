/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { compileSafeRegex } from '../storage/regex';
import { abortableSleep, MAX_RETRY_AFTER_SECONDS, parseRetryAfterSeconds, throwIfAborted } from './search';
import { getAuthToken, getHTTP, getLoadedMessages } from './stores';

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

/**
 * Concatenates searchable text from a Discord message: content, attachment filenames/descriptions,
 * embed author/title/description/fields/footer, and forwarded message snapshots.
 */
export function extractMessageSearchText(msg: DiscordMessage): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (a?.filename) parts.push(a.filename);
      if (a?.description) parts.push(a.description);
    }
  }
  if (Array.isArray(msg.embeds)) {
    for (const e of msg.embeds) {
      if (!e) continue;
      if (e.author?.name) parts.push(e.author.name);
      if (e.title) parts.push(e.title);
      if (e.description) parts.push(e.description);
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f?.name) parts.push(f.name);
          if (f?.value) parts.push(f.value);
        }
      }
      if (e.footer?.text) parts.push(e.footer.text);
    }
  }
  if (Array.isArray(msg.message_snapshots)) {
    for (const snap of msg.message_snapshots) {
      const inner = snap?.message;
      if (!inner) continue;
      if (inner.content) parts.push(inner.content);
      if (Array.isArray(inner.attachments)) {
        for (const a of inner.attachments) {
          if (a?.filename) parts.push(a.filename);
        }
      }
      if (Array.isArray(inner.embeds)) {
        for (const e of inner.embeds) {
          if (e?.title) parts.push(e.title);
          if (e?.description) parts.push(e.description);
        }
      }
    }
  }
  return parts.join(' ');
}

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
  const dateTime = (value: string | Date): number => {
    const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00`
      : value;
    return new Date(normalized).getTime();
  };
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
 * Helper to fetch messages from Discord API using RestAPI with fetch fallback
 */
export async function fetchDiscordMessagesApi(
  channelId: string,
  queryObj: Record<string, string>,
  retriesRemaining = 3,
  signal?: AbortSignal,
): Promise<DiscordMessage[]> {
  const relativeEndpoint = `/channels/${channelId}/messages`;
  const http = getHTTP();
  throwIfAborted(signal);

  if (http && typeof http.get === 'function') {
    try {
      const res = await http.get({ url: relativeEndpoint, query: queryObj });
      const body = res?.body ?? res;
      if (Array.isArray(body)) return body;
    } catch (httpErr: any) {
      const status = httpErr?.status ?? httpErr?.statusCode;
      const retryVal = httpErr?.headers?.get?.('Retry-After') ?? httpErr?.body?.retry_after ?? httpErr?.retry_after;
      const retrySec = retryVal ? parseRetryAfterSeconds(retryVal) : status === 429 ? 2 : null;
      if (retrySec !== null && retrySec > MAX_RETRY_AFTER_SECONDS) {
        // A raw fetch would land in the same rate-limited bucket; let the caller fall back.
        console.warn(`[VencordAI] Discord 429 on ${relativeEndpoint}, retry_after ${retrySec}s exceeds the cap`);
        return [];
      }
      if (retrySec !== null && retriesRemaining > 0) {
        console.warn(`[VencordAI] Discord 429 on ${relativeEndpoint}, retrying after ${retrySec}s...`);
        await abortableSleep(retrySec * 1000 + 300, signal);
        return fetchDiscordMessagesApi(channelId, queryObj, retriesRemaining - 1, signal);
      }
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
      signal,
    });
    if (response.status === 429 && retriesRemaining > 0) {
      const retryHeader = response.headers.get('Retry-After');
      const retrySec = retryHeader ? parseRetryAfterSeconds(retryHeader) : 2;
      if (retrySec > MAX_RETRY_AFTER_SECONDS) return [];
      console.warn(`[VencordAI] Discord 429 on fetch ${relativeEndpoint}, retrying after ${retrySec}s...`);
      await abortableSleep(retrySec * 1000 + 300, signal);
      return fetchDiscordMessagesApi(channelId, queryObj, retriesRemaining - 1, signal);
    }
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error(`[VencordAI] Failed to fetch messages for channel ${channelId}:`, err);
  }

  return [];
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

function detectImageMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Normalizes an image Blob into a clean JPEG/PNG data URL safe for local VLMs (e.g. oMLX / mlx-vlm).
 * In browser environments, decodes via Image/canvas and caps dimensions at 1536px to avoid AVIF/octet-stream
 * or oversized 4K PNG rejections; in headless/Node environments, inspects magic bytes to ensure a valid MIME type.
 */
export async function normalizeImageBlobToDataUrl(blob: Blob, maxDimension = 1536): Promise<string> {
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('Image exceeds the 10 MB inspection limit.');
  }

  // Browser / Electron canvas normalization: guarantees real JPEG/PNG encoding and bounded resolution.
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Image !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const dims = await new Promise<{ img: HTMLImageElement; width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
        img.onerror = () => reject(new Error('Image decode failed.'));
        img.src = objectUrl;
      });
      if (dims.width > 0 && dims.height > 0) {
        const scale = Math.min(1, maxDimension / Math.max(dims.width, dims.height));
        const width = Math.max(1, Math.round(dims.width * scale));
        const height = Math.max(1, Math.round(dims.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(dims.img, 0, 0, width, height);
          const keepPng = blob.type === 'image/png' && width <= 1024 && height <= 1024;
          const outMime = keepPng ? 'image/png' : 'image/jpeg';
          return canvas.toDataURL(outMime, keepPng ? undefined : 0.88);
        }
      }
    } catch {
      // Fall through to magic-byte normalization when canvas decode is unavailable.
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const detectedMime = detectImageMimeFromBytes(bytes);
  const rawType = (blob.type || '').split(';')[0].trim().toLowerCase();
  const validType = rawType.startsWith('image/') && rawType !== 'image/avif' ? rawType : null;
  const mime = detectedMime || validType || 'image/png';
  return `data:${mime};base64,${uint8ToBase64(bytes)}`;
}

/**
 * Encodes an image attachment URL to a normalized base64 data URL for vision models.
 * Retries cdn.discordapp.com failures against media.discordapp.net.
 */
export async function fetchImageAsBase64(imageUrl: string, signal?: AbortSignal): Promise<string> {
  const fetchOnce = async (url: string): Promise<Blob> => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const declaredSize = Number(response.headers.get('Content-Length') || 0);
    if (declaredSize > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB inspection limit.');
    const blob = await response.blob();
    if (blob.size > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB inspection limit.');
    return blob;
  };

  try {
    let blob: Blob;
    try {
      blob = await fetchOnce(imageUrl);
    } catch (primaryErr) {
      if (signal?.aborted) throw primaryErr;
      const mediaUrl = imageUrl.replace(/^https:\/\/cdn\.discord(?:app)?\.com\//i, 'https://media.discordapp.net/');
      if (mediaUrl === imageUrl) throw primaryErr;
      blob = await fetchOnce(mediaUrl);
    }
    return await normalizeImageBlobToDataUrl(blob);
  } catch (err) {
    console.error('[VencordAI] Failed to fetch image as base64:', err);
    throw err;
  }
}
