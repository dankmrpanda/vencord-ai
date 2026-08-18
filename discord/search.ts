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
  channelId?: string;
  guildId?: string;
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

// In-memory cache for recent search queries (only non-empty results are cached)
const searchCache = new Map<string, { data: SearchResponse; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

// Rate limiter / serial queue
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1200;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Searches messages using Discord's server-side search index
 */
export async function searchDiscordMessages(
  options: SearchOptions,
  retriesRemaining: number = 3
): Promise<SearchResponse> {
  // Compute effective min_id / max_id from dates if specified
  let effectiveMinId = options.minId;
  let effectiveMaxId = options.maxId;

  if (options.duringDate) {
    const d = new Date(options.duringDate);
    if (!isNaN(d.getTime())) {
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
      effectiveMinId = dateToSnowflake(start);
      effectiveMaxId = dateToSnowflake(end);
    }
  } else {
    if (options.afterDate) {
      const d = new Date(options.afterDate);
      if (!isNaN(d.getTime())) {
        effectiveMinId = dateToSnowflake(d);
      }
    }
    if (options.beforeDate) {
      const d = new Date(options.beforeDate);
      if (!isNaN(d.getTime())) {
        effectiveMaxId = dateToSnowflake(d);
      }
    }
  }

  const normalizedKey = JSON.stringify({
    q: options.query?.trim() || '',
    ch: options.channelId || '',
    g: options.guildId || '',
    a: options.authorId || '',
    h: options.has || '',
    min: effectiveMinId || '',
    max: effectiveMaxId || '',
    sort: options.sortBy || '',
    ord: options.sortOrder || '',
    off: options.offset || 0,
    pin: options.pinned || '',
    men: options.mentions || '',
  });

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
  if (options.query && options.query.trim()) {
    queryObj.content = options.query.trim();
  }
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
    if (options.channelId) {
      queryObj.channel_id = options.channelId;
    }
  } else if (options.channelId) {
    relativeEndpoint = `/channels/${options.channelId}/messages/search`;
  } else {
    throw new Error('Either channelId or guildId must be provided for searching');
  }

  const queryParams = new URLSearchParams(queryObj);
  const queryString = queryParams.toString();
  const http = getHTTP();
  let rawData: any = null;

  try {
    if (http && typeof http.get === 'function') {
      try {
        const res = await http.get({
          url: relativeEndpoint,
          query: queryObj,
        });
        rawData = res?.body ?? res;

        const isIndexing = res?.status === 202 || res?.statusCode === 202 || rawData?.retry_after;
        if (isIndexing && retriesRemaining > 0) {
          const retryAfter = Number(rawData?.retry_after) || 2;
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
          return searchDiscordMessages(options, retriesRemaining - 1);
        }
      } catch (httpErr: any) {
        if ((httpErr?.status === 429 || httpErr?.status === 202 || httpErr?.body?.retry_after) && retriesRemaining > 0) {
          const retryAfter = Number(httpErr?.body?.retry_after) || 2;
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
          return searchDiscordMessages(options, retriesRemaining - 1);
        }
        throw httpErr;
      }
    } else {
      // Fallback to fetch
      const token = getAuthToken();
      const fullFetchUrl = `https://discord.com/api/v9${relativeEndpoint}${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(fullFetchUrl, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 429 && retriesRemaining > 0) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 2;
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
        return searchDiscordMessages(options, retriesRemaining - 1);
      }

      if (response.status === 202 && retriesRemaining > 0) {
        const data = await response.json().catch(() => ({}));
        const retryAfter = data?.retry_after || Number(response.headers.get('Retry-After')) || 2;
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
        return searchDiscordMessages(options, retriesRemaining - 1);
      }

      if (!response.ok) {
        throw new Error(`Discord search failed with status ${response.status}: ${response.statusText}`);
      }

      rawData = await response.json();

      if (rawData?.retry_after && retriesRemaining > 0) {
        const retryAfter = Number(rawData.retry_after) || 2;
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
        return searchDiscordMessages(options, retriesRemaining - 1);
      }
    }
  } catch (err: any) {
    if ((err?.status === 429 || err?.body?.retry_after) && retriesRemaining > 0) {
      const retryAfter = Number(err?.body?.retry_after) || 2;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
      return searchDiscordMessages(options, retriesRemaining - 1);
    }
    console.error('[VencordAI] Search error:', err);
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
