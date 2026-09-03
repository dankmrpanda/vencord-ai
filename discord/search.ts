/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { getAuthToken, getChannel, getHTTP } from './stores';

const DISCORD_EPOCH = 1420070400000n;

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
    const otpMatch = workQuery.match(/\b(?:2fa|mfa|otp|verification|auth(?:entication)?)\s*(?:codes?|numbers?|tokens?|pins?)?\b/i);
    if (otpMatch) {
      pattern = `\\b\\d{4,8}\\b`;
      patternDescription = 'verification/OTP code';
      workQuery = workQuery.replace(/\b(?:codes?|numbers?|tokens?|pins?)\b/gi, ' ');
    }
    const pinMatch = workQuery.match(/\b(?:pins?|pin\s*codes?)\b/i);
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
    const ipMatch = workQuery.match(/\b(?:ip addresses?|ipv4|ips?)\b/i);
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
  const cleaned = workQuery.toLowerCase().replace(/[^\w\s-]/g, ' ');
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
  const cleaned = query.toLowerCase().replace(/[^\w\s-]/g, ' ');
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

// Rate limiter / serial queue
let lastRequestTime = 0;
let searchStartQueue: Promise<void> = Promise.resolve();
const MIN_REQUEST_INTERVAL_MS = 1200;

async function throttle(): Promise<void> {
  const scheduled = searchStartQueue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();
  });
  searchStartQueue = scheduled.catch(() => undefined);
  await scheduled;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    off: options.offset || 0,
    pin: options.pinned === undefined ? '' : options.pinned,
    men: options.mentions || '',
  });
}

export function resolveDateSnowflakeBounds(options: SearchOptions): { minId?: string; maxId?: string } {
  if (options.duringDate) {
    const raw = options.duringDate;
    const d = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T00:00:00`)
      : new Date(raw);
    if (!isNaN(d.getTime())) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const end = new Date(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime() - 1);
      return { minId: dateToSnowflake(start), maxId: dateToSnowflake(end) };
    }
  }
  const localizeDateOnly = (value: string | Date): string | Date =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00`)
      : value;
  const minId = options.afterDate ? dateToSnowflake(localizeDateOnly(options.afterDate)) : options.minId;
  const maxId = options.beforeDate ? dateToSnowflake(localizeDateOnly(options.beforeDate)) : options.maxId;
  return {
    minId: minId && minId !== '0' ? minId : undefined,
    maxId: maxId && maxId !== '0' ? maxId : undefined,
  };
}

function extractRetryAfterSeconds(target: any): number | null {
  if (!target) return null;
  const status = target.status ?? target.statusCode;
  const retryVal = target.headers?.get?.('Retry-After') ?? target.body?.retry_after ?? target.retry_after;
  if (retryVal) {
    const sec = Number(retryVal);
    return isNaN(sec) ? 2 : Math.max(sec, 1);
  }
  if (status === 429 || status === 202) {
    return 2;
  }
  return null;
}

/**
 * Searches messages using Discord's server-side search index
 */
export async function searchDiscordMessages(
  options: SearchOptions,
  retriesRemaining: number = 3
): Promise<SearchResponse> {
  const { minId: effectiveMinId, maxId: effectiveMaxId } = resolveDateSnowflakeBounds(options);

  // Check if options.query is a pure pattern descriptor with no keyword (e.g. "6-digit")
  let sanitizedQuery = options.query?.trim();
  if (sanitizedQuery) {
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

  await throttle();

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
  if (options.offset) queryObj.offset = String(options.offset);
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

  const http = getHTTP();
  let rawData: any = null;

  try {
    if (http && typeof http.get === 'function') {
      const res = await http.get({ url: relativeEndpoint, query: queryObj });
      rawData = res?.body ?? res;
    } else {
      const token = getAuthToken();
      const queryString = new URLSearchParams(queryObj).toString();
      const fullFetchUrl = `https://discord.com/api/v9${relativeEndpoint}${queryString ? `?${queryString}` : ''}`;
      const response = await fetch(fullFetchUrl, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        const err: any = new Error(`Discord search failed with status ${response.status}: ${errorText}`);
        err.status = response.status;
        err.headers = response.headers;
        throw err;
      }

      rawData = await response.json();
    }

    const retrySec = extractRetryAfterSeconds(rawData);
    if (retrySec !== null && retriesRemaining > 0) {
      console.info('[VencordAI] discord_search_retry', { retriesRemaining, retryAfterSeconds: retrySec });
      await sleep(retrySec * 1000 + 500);
      lastRequestTime = Date.now();
      return searchDiscordMessages(options, retriesRemaining - 1);
    }
  } catch (err: any) {
    const retrySec = extractRetryAfterSeconds(err);
    if (retrySec !== null && retriesRemaining > 0) {
      console.info('[VencordAI] discord_search_retry', { retriesRemaining, retryAfterSeconds: retrySec });
      await sleep(retrySec * 1000 + 500);
      lastRequestTime = Date.now();
      return searchDiscordMessages(options, retriesRemaining - 1);
    }
    console.error('[VencordAI] Search error', { status: err?.status ?? err?.statusCode ?? 'unknown' });
    throw err;
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
    searchCache.set(normalizedKey, { data: result, timestamp: Date.now() });
  }

  return result;
}
