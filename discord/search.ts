/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import {
  abortableSleep,
  DISCORD_EPOCH,
  discordGetOnce,
  extractRetryAfterSeconds,
  MAX_RETRY_AFTER_SECONDS,
  throwIfAborted,
} from './rest';
import { getChannel } from './stores';

/**
 * Converts a Date, timestamp, or date string into a Discord Snowflake ID
 */
export function dateToSnowflake(date: Date | string | number): string {
  try {
    const ms = typeof date === 'string' ? new Date(date).getTime() : typeof date === 'number' ? date : date.getTime();
    if (isNaN(ms)) return '0';
    const snowflake = (BigInt(ms) - DISCORD_EPOCH) << 22n;
    return snowflake > 0n ? snowflake.toString() : '0';
  } catch {
    return '0';
  }
}

/**
 * Converts a Discord Snowflake ID into a JavaScript Date
 */
export function snowflakeToDate(snowflake: string): Date {
  try {
    const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
    return new Date(Number(ms));
  } catch {
    return new Date();
  }
}

export interface SearchOptions {
  query?: string;
  pattern?: string | RegExp;
  channelId?: string;
  guildId?: string;
  guildWide?: boolean;
  authorId?: string;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  minId?: string;
  maxId?: string;
  beforeDate?: string | Date;
  afterDate?: string | Date;
  duringDate?: string | Date;
  sortBy?: 'timestamp' | 'relevance';
  sortOrder?: 'desc' | 'asc';
  offset?: number;
  pinned?: boolean;
  mentions?: string;
  skipPatternDetection?: boolean;
}

export interface SearchResponse {
  totalResults: number;
  messages: DiscordMessage[][];
  documentsIndexed?: number;
}

export interface DetectedPatternInfo {
  pattern: string | null;
  cleanedQuery: string;
  patternDescription: string | null;
}

const NUMBER_WORD_MAP: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  sixteen: 16,
  twenty: 20,
  thirty: 30,
  thirtytwo: 32,
  sixtyfour: 64,
};

function parseDigitWordOrNum(val: string): number | null {
  if (!val) return null;
  const num = parseInt(val, 10);
  if (!isNaN(num) && num > 0) return num;
  return NUMBER_WORD_MAP[val.toLowerCase()] || null;
}

/**
 * Detects whether a search query represents a pattern request (e.g. "6-digit numbers",
 * "4-digit pins", regex, phone numbers, OTPs, etc.) and separates the regex from anchor keywords.
 */
export function detectPatternFromQuery(query?: string): DetectedPatternInfo {
  if (!query || typeof query !== 'string') {
    return { pattern: null, cleanedQuery: '', patternDescription: null };
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return { pattern: null, cleanedQuery: '', patternDescription: null };
  }

  // 1. Check if the string looks like an explicit regex string (e.g. \b\d{6}\b or /.../)
  if (/^(\/.*\/[gimsuy]*|\^.*\$|\\b.*\\b|\\d[\+\*\{\d,\}]*|\[\d-\d\][\+\*\{\d,\}]*)$/.test(trimmed)) {
    try {
      const matchRegex = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
      if (matchRegex) {
        new RegExp(matchRegex[1], matchRegex[2]);
        return { pattern: trimmed, cleanedQuery: '', patternDescription: 'regex pattern' };
      }
      new RegExp(trimmed);
      return { pattern: trimmed, cleanedQuery: '', patternDescription: 'regex pattern' };
    } catch {}
  }

  let pattern: string | null = null;
  let patternDescription: string | null = null;
  let workQuery = trimmed;

  // 2. Exact or range digit counts (e.g. "6-digit", "6 digits", "six digit", "6 digit numbers", "4-8 digits")
  // Range: "4 to 8 digits", "4-8 digits", "4 - 8 digit numbers"
  const rangeMatch = workQuery.match(
    /\b(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|sixteen)\s*(?:to|-|–|—)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|sixteen)\s*digits?)(?:\s+(?:numbers?|codes?|pins?|sequences?|values?|tokens?|integers?))?\b/i
  );
  if (rangeMatch) {
    const min = parseDigitWordOrNum(rangeMatch[1]);
    const max = parseDigitWordOrNum(rangeMatch[2]);
    if (min && max) {
      pattern = `\\b\\d{${min},${max}}\\b`;
      patternDescription = `${min}-${max} digit number`;
      workQuery = workQuery.replace(rangeMatch[0], ' ');
    }
  }

  // "at least N digits", "minimum N digits", "up to N digits"
  if (!pattern) {
    const atLeastMatch = workQuery.match(/\b(?:at least|minimum|min)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*digits?\b/i);
    if (atLeastMatch) {
      const count = parseDigitWordOrNum(atLeastMatch[1]);
      if (count) {
        pattern = `\\b\\d{${count},}\\b`;
        patternDescription = `at least ${count} digits`;
        workQuery = workQuery.replace(atLeastMatch[0], ' ');
      }
    }
    const maxMatch = workQuery.match(/\b(?:up to|maximum|max)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*digits?\b/i);
    if (maxMatch && !pattern) {
      const count = parseDigitWordOrNum(maxMatch[1]);
      if (count) {
        pattern = `\\b\\d{1,${count}}\\b`;
        patternDescription = `up to ${count} digits`;
        workQuery = workQuery.replace(maxMatch[0], ' ');
      }
    }
  }

  // Single digit count: "6-digit", "6 digits", "6-digits", "six digit", "6 digit numbers", etc.
  if (!pattern) {
    const singleMatch = workQuery.match(
      /\b(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|sixteen)[- ]?digits?)(?:\s+(?:numbers?|codes?|pins?|sequences?|values?|tokens?|integers?))?\b/i
    );
    if (singleMatch) {
      const count = parseDigitWordOrNum(singleMatch[1]);
      if (count) {
        pattern = `\\b\\d{${count}}\\b`;
        patternDescription = `${count}-digit number`;
        workQuery = workQuery.replace(singleMatch[0], ' ');
      }
    }
  }

  // 3. Verification / OTP / 2FA / PIN codes
  if (!pattern) {
    const otpMatch = workQuery.match(
      /\b(?:(?:2fa|mfa|otp)(?:\s*(?:codes?|numbers?|tokens?|pins?))?|(?:verification|auth(?:entication)?)\s*(?:codes?|numbers?|tokens?|pins?))\b/i
    );
    if (otpMatch) {
      pattern = `\\b\\d{4,8}\\b`;
      patternDescription = 'verification/OTP code';
      workQuery = workQuery.replace(/\b(?:codes?|numbers?|tokens?|pins?)\b/gi, ' ');
    }
    const pinMatch = workQuery.match(/\bpins?\s*(?:codes?|numbers?)\b/i);
    if (pinMatch && !pattern) {
      pattern = `\\b\\d{4,8}\\b`;
      patternDescription = 'PIN code';
      workQuery = workQuery.replace(pinMatch[0], ' ');
    }
  }

  // 4. Phone numbers
  if (!pattern) {
    const phoneMatch = workQuery.match(/\b(?:phone numbers?|phone#?|cell phone|mobile number)\b/i);
    if (phoneMatch) {
      pattern = `\\b(?:\\+?\\d{1,3}[-.\\s]?)?\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b`;
      patternDescription = 'phone number';
      workQuery = workQuery.replace(phoneMatch[0], ' ');
    }
  }

  // 5. Emails
  if (!pattern) {
    const emailMatch = workQuery.match(/\b(?:emails?|email addresses?)\b/i);
    if (emailMatch) {
      pattern = `\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b`;
      patternDescription = 'email address';
      workQuery = workQuery.replace(emailMatch[0], ' ');
    }
  }

  // 6. Hex codes / hashes
  if (!pattern) {
    const hexMatch = workQuery.match(/\b(?:hex codes?|hex colors?|hex values?|hashes?|txid|tx hash)\b/i);
    if (hexMatch) {
      pattern = `\\b#[0-9a-fA-F]{3,8}\\b|\\b0x[0-9a-fA-F]{4,}\\b|\\b[0-9a-fA-F]{32,64}\\b`;
      patternDescription = 'hex code/hash';
      workQuery = workQuery.replace(hexMatch[0], ' ');
    }
  }

  // 7. IP addresses
  if (!pattern) {
    const ipMatch = workQuery.match(/\b(?:ip\s+address(?:es)?|ipv4(?:\s+address(?:es)?)?)\b/i);
    if (ipMatch) {
      pattern = `\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b`;
      patternDescription = 'IP address';
      workQuery = workQuery.replace(ipMatch[0], ' ');
    }
  }

  // 8. General numbers/digits
  if (!pattern) {
    const numMatch = workQuery.match(/\b(?:all|any)?\s*(?:numbers?|digits?|numerical sequences?|integers?)\b/i);
    if (numMatch) {
      pattern = `\\b\\d+\\b`;
      patternDescription = 'numerical sequence';
      workQuery = workQuery.replace(numMatch[0], ' ');
    }
  }

  // Clean remaining words from workQuery (strip stopwords, meta words, punctuation)
  const cleaned = workQuery.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const nonStopwords = words.filter((w) => !COMMON_CONVERSATIONAL_STOPWORDS.has(w));
  const cleanedQuery = nonStopwords.join(' ').trim();

  return { pattern, cleanedQuery, patternDescription };
}

const COMMON_CONVERSATIONAL_STOPWORDS = new Set([
  'find', 'the', 'message', 'messages', 'where', 'i', 'me', 'my', 'myself',
  'talk', 'talked', 'talking', 'about', 'say', 'said', 'saying', 'tell', 'told',
  'around', 'only', 'just', 'being', 'been', 'is', 'was', 'were', 'are', 'am',
  'a', 'an', 'and', 'or', 'to', 'for', 'in', 'on', 'at', 'by', 'from', 'with',
  'that', 'this', 'it', 'its', 'have', 'had', 'has', 'do', 'did', 'does',
  'show', 'get', 'look', 'looking', 'what', 'which', 'who', 'when', 'why', 'how',
  'some', 'any', 'could', 'would', 'should', 'can', 'will', 'of', 'up', 'out',
  'dm', 'dms', 'channel', 'channels', 'server', 'servers', 'chat', 'chats',
  'all', 'every', 'each', 'here', 'there', 'digit', 'digits', 'number', 'numbers',
  'numerical', 'text', 'string', 'strings', 'contain', 'contains', 'containing',
]);

/**
 * Strips conversational filler and extracts anchor keywords from a query
 */
export function extractAnchorKeywords(query: string): string[] {
  if (!query || typeof query !== 'string') return [];

  // Remove common punctuation except hyphens
  const cleaned = query.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);

  const nonStopwords = words.filter((w) => !COMMON_CONVERSATIONAL_STOPWORDS.has(w));
  return nonStopwords.length > 0 ? nonStopwords : words;
}

/**
 * Generates alternative/relaxed query variations in order of priority
 */
export function generateRelaxedQueries(query: string): string[] {
  if (!query || typeof query !== 'string') return [];

  const rawTrimmed = query.trim();
  const patternInfo = detectPatternFromQuery(rawTrimmed);
  if (patternInfo.pattern && !patternInfo.cleanedQuery) {
    // Pure pattern query; do not generate keyword variations
    return [];
  }

  const effectiveRaw = patternInfo.cleanedQuery || rawTrimmed;
  const variations: string[] = [];
  const seen = new Set<string>();

  const addVar = (v: string) => {
    const t = v.trim();
    if (t && t.length >= 2 && !seen.has(t.toLowerCase()) && t.toLowerCase() !== effectiveRaw.toLowerCase()) {
      seen.add(t.toLowerCase());
      variations.push(t);
    }
  };

  const anchorWords = extractAnchorKeywords(effectiveRaw);

  // 1. All anchor words joined
  if (anchorWords.length > 0 && anchorWords.length < effectiveRaw.split(/\s+/).length) {
    addVar(anchorWords.join(' '));
  }

  // 2. Remove number ranges/details (e.g. "3-5", "3", "5", "minutes") if there are core nouns
  const withoutNumbersOrUnits = anchorWords.filter(
    (w) => !/^\d+([-\/]\d+)?$/.test(w) && !['minutes', 'minute', 'mins', 'min', 'hours', 'hour', 'hrs', 'hr', 'seconds', 'sec', 'secs'].includes(w)
  );
  if (withoutNumbersOrUnits.length > 0 && withoutNumbersOrUnits.length < anchorWords.length) {
    addVar(withoutNumbersOrUnits.join(' '));
  }

  // 3. First two anchor words / primary anchor word
  if (withoutNumbersOrUnits.length >= 2) {
    addVar(withoutNumbersOrUnits.slice(0, 2).join(' '));
    addVar(withoutNumbersOrUnits[0]);
  } else if (anchorWords.length >= 2) {
    addVar(anchorWords.slice(0, 2).join(' '));
    addVar(anchorWords[0]);
  }

  // 4. Individual non-stopword tokens (longest first)
  const sortedByLength = [...(withoutNumbersOrUnits.length > 0 ? withoutNumbersOrUnits : anchorWords)].sort(
    (a, b) => b.length - a.length
  );
  for (const token of sortedByLength) {
    if (token.length >= 3) {
      addVar(token);
    }
  }

  return variations.slice(0, 4);
}

// In-memory cache for recent search queries (only non-empty results are cached)
const searchCache = new Map<string, { data: SearchResponse; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute
const SEARCH_CACHE_MAX_ENTRIES = 100;

/** Drops expired entries on write and keeps only the newest SEARCH_CACHE_MAX_ENTRIES. */
function cacheSearchResult(key: string, data: SearchResponse): void {
  const now = Date.now();
  for (const [entryKey, entry] of searchCache) {
    if (now - entry.timestamp >= CACHE_TTL_MS) searchCache.delete(entryKey);
  }
  searchCache.delete(key);
  searchCache.set(key, { data, timestamp: now });
  for (const oldestKey of searchCache.keys()) {
    if (searchCache.size <= SEARCH_CACHE_MAX_ENTRIES) break;
    searchCache.delete(oldestKey);
  }
}

// Rate limiter / serial queue
let lastRequestTime = 0;
let searchStartQueue: Promise<void> = Promise.resolve();
const MIN_REQUEST_INTERVAL_MS = 1200;

async function throttle(signal?: AbortSignal): Promise<void> {
  const scheduled = searchStartQueue.then(async () => {
    // Re-check after each wait: a 429 elsewhere may push the start time forward meanwhile.
    let deadline = 0;
    while (lastRequestTime + MIN_REQUEST_INTERVAL_MS > Math.max(Date.now(), deadline)) {
      deadline = lastRequestTime + MIN_REQUEST_INTERVAL_MS;
      await abortableSleep(deadline - Date.now(), signal);
    }
    lastRequestTime = Date.now();
  });
  searchStartQueue = scheduled.catch(() => undefined);
  await scheduled;
}

/** Holds every queued search start until the rate-limit window has passed. */
function deferSearchStarts(delayMs: number): void {
  lastRequestTime = Math.max(lastRequestTime, Date.now() + delayMs - MIN_REQUEST_INTERVAL_MS);
}

/** Discord accepts only a positive whole-number offset; anything else means the first page. */
function sanitizeOffset(offset?: number): number | undefined {
  return Number.isInteger(offset) && offset! > 0 ? offset : undefined;
}

export function buildSearchCacheKey(
  options: SearchOptions,
  sanitizedQuery = options.query?.trim() || '',
  effectiveMinId?: string,
  effectiveMaxId?: string,
): string {
  return JSON.stringify({
    q: sanitizedQuery,
    pat: options.pattern ? String(options.pattern) : '',
    ch: options.channelId || '',
    g: options.guildId || '',
    gw: Boolean(options.guildWide),
    a: options.authorId || '',
    h: options.has || '',
    min: effectiveMinId || '',
    max: effectiveMaxId || '',
    sort: options.sortBy || '',
    ord: options.sortOrder || '',
    off: sanitizeOffset(options.offset) || 0,
    pin: options.pinned === undefined ? '' : options.pinned,
    men: options.mentions || '',
  });
}

/** Parses a strict YYYY-MM-DD calendar day at local midnight or a general Date/ISO timestamp. */
export function parseLocalSearchDate(value: string | Date): Date | null {
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const [year, month, day] = dateOnly.slice(1).map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
    }
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function resolveDateSnowflakeBounds(options: SearchOptions): { minId?: string; maxId?: string } {
  if (options.duringDate) {
    const d = parseLocalSearchDate(options.duringDate);
    if (d) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const end = new Date(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime() - 1);
      return { minId: dateToSnowflake(start), maxId: dateToSnowflake(end) };
    }
  }
  const afterParsed = options.afterDate ? parseLocalSearchDate(options.afterDate) : null;
  const beforeParsed = options.beforeDate ? parseLocalSearchDate(options.beforeDate) : null;
  const minId = afterParsed ? dateToSnowflake(afterParsed) : options.minId;
  const maxId = beforeParsed ? dateToSnowflake(beforeParsed) : options.maxId;
  return {
    minId: minId && minId !== '0' ? minId : undefined,
    maxId: maxId && maxId !== '0' ? maxId : undefined,
  };
}

/**
 * Searches messages using Discord's server-side search index
 */
export async function searchDiscordMessages(
  options: SearchOptions,
  retriesRemaining: number = 3,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  throwIfAborted(signal);
  const { minId: effectiveMinId, maxId: effectiveMaxId } = resolveDateSnowflakeBounds(options);

  // Check if options.query is a pure pattern descriptor with no keyword (e.g. "6-digit")
  let sanitizedQuery = options.query?.trim();
  if (sanitizedQuery && !options.skipPatternDetection) {
    const patInfo = detectPatternFromQuery(sanitizedQuery);
    if (patInfo.pattern && !patInfo.cleanedQuery) {
      // It's a pure pattern request like "6-digit" - omit literal content query to Discord API
      sanitizedQuery = undefined;
    } else if (patInfo.pattern && patInfo.cleanedQuery) {
      sanitizedQuery = patInfo.cleanedQuery;
    }
  }

  const normalizedKey = buildSearchCacheKey(options, sanitizedQuery || '', effectiveMinId, effectiveMaxId);

  const cached = searchCache.get(normalizedKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  await throttle(signal);
  throwIfAborted(signal);

  // Resolve guild ID from channel if not explicitly provided
  let guildId = options.guildId;
  if (!guildId && options.channelId) {
    const ch = getChannel(options.channelId);
    if (ch?.guild_id) {
      guildId = ch.guild_id;
    }
  }

  const queryObj: Record<string, string> = {};
  if (sanitizedQuery) queryObj.content = sanitizedQuery;
  if (options.authorId) queryObj.author_id = options.authorId;
  if (options.has) queryObj.has = options.has;
  if (effectiveMinId) queryObj.min_id = effectiveMinId;
  if (effectiveMaxId) queryObj.max_id = effectiveMaxId;
  if (options.sortBy) queryObj.sort_by = options.sortBy;
  if (options.sortOrder) queryObj.sort_order = options.sortOrder;
  const offset = sanitizeOffset(options.offset);
  if (offset) queryObj.offset = String(offset);
  if (options.pinned !== undefined) queryObj.pinned = String(options.pinned);
  if (options.mentions) queryObj.mentions = options.mentions;

  let relativeEndpoint = '';
  if (guildId) {
    relativeEndpoint = `/guilds/${guildId}/messages/search`;
    if (options.channelId && !options.guildWide) {
      queryObj.channel_id = options.channelId;
    }
  } else if (options.channelId) {
    relativeEndpoint = `/channels/${options.channelId}/messages/search`;
  } else {
    throw new Error('Either channelId or guildId must be provided for searching');
  }

  // If there are no search filter parameters, Discord /messages/search returns 400 Bad Request
  // Return empty immediately so local message scanner can handle channel scan
  if (Object.keys(queryObj).length === 0 || (Object.keys(queryObj).length === 1 && queryObj.channel_id)) {
    return { totalResults: 0, messages: [] };
  }

  let rawData: any = null;

  try {
    rawData = await discordGetOnce(relativeEndpoint, queryObj, { signal });

    const retrySec = extractRetryAfterSeconds(rawData, true);
    if (retrySec !== null && retriesRemaining > 0) {
      return retryAfterRateLimit(retrySec, undefined);
    }
  } catch (err: any) {
    const retrySec = signal?.aborted ? null : extractRetryAfterSeconds(err, true);
    if (retrySec !== null && retriesRemaining > 0) {
      return retryAfterRateLimit(retrySec, err);
    }
    console.error('[VencordAI] Search error', { status: err?.status ?? err?.statusCode ?? 'unknown' });
    throw err;
  }

  async function retryAfterRateLimit(retrySec: number, cause: unknown): Promise<SearchResponse> {
    // Queued and retried starts wait in throttle(), which honours the signal.
    deferSearchStarts(Math.min(retrySec, MAX_RETRY_AFTER_SECONDS) * 1000 + 500);
    if (retrySec > MAX_RETRY_AFTER_SECONDS) {
      console.warn('[VencordAI] discord_search_rate_limited', { retryAfterSeconds: retrySec });
      throw cause ?? Object.assign(new Error(`Discord search asked to retry after ${retrySec}s`), { status: 429 });
    }
    console.info('[VencordAI] discord_search_retry', { retriesRemaining, retryAfterSeconds: retrySec });
    return searchDiscordMessages(options, retriesRemaining - 1, signal);
  }

  // Normalize raw message array structure
  let normalizedMessages: DiscordMessage[][] = [];
  if (Array.isArray(rawData?.messages)) {
    normalizedMessages = rawData.messages.map((item: any) => (Array.isArray(item) ? item : [item]));
  }

  const result: SearchResponse = {
    totalResults: rawData?.total_results ?? normalizedMessages.length,
    messages: normalizedMessages,
    documentsIndexed: rawData?.documents_indexed,
  };

  // Only cache positive results so temporary empty/indexing states do not get stuck
  if (result.messages.length > 0) {
    cacheSearchResult(normalizedKey, result);
  }

  return result;
}
