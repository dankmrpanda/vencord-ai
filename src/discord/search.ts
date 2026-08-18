import { DiscordMessage } from '../types';
import { getAuthToken, getHTTP } from './stores';

export interface SearchOptions {
  query?: string;
  channelId?: string;
  guildId?: string;
  authorId?: string;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed';
  minId?: string;
  maxId?: string;
  offset?: number;
}

export interface SearchResponse {
  totalResults: number;
  messages: DiscordMessage[][];
  documentsIndexed?: number;
}

// In-memory cache for recent search queries
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
export async function searchDiscordMessages(options: SearchOptions): Promise<SearchResponse> {
  const cacheKey = JSON.stringify(options);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  await throttle();

  const queryParams = new URLSearchParams();
  if (options.query) queryParams.set('content', options.query);
  if (options.authorId) queryParams.set('author_id', options.authorId);
  if (options.has) queryParams.set('has', options.has);
  if (options.minId) queryParams.set('min_id', options.minId);
  if (options.maxId) queryParams.set('max_id', options.maxId);
  if (options.offset) queryParams.set('offset', String(options.offset));

  let url = '';
  if (options.guildId) {
    url = `/api/v9/guilds/${options.guildId}/messages/search`;
    if (options.channelId) {
      queryParams.set('channel_id', options.channelId);
    }
  } else if (options.channelId) {
    url = `/api/v9/channels/${options.channelId}/messages/search`;
  } else {
    throw new Error('Either channelId or guildId must be provided for searching');
  }

  const queryString = queryParams.toString();
  const fullUrl = queryString ? `${url}?${queryString}` : url;

  const token = getAuthToken();
  const http = getHTTP();

  let rawData: any = null;

  try {
    if (http && typeof http.get === 'function') {
      const res = await http.get({ url: fullUrl });
      rawData = res.body ?? res;
    } else {
      const response = await fetch(`https://discord.com${fullUrl}`, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After')) || 2;
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
        return searchDiscordMessages(options);
      }

      if (!response.ok) {
        throw new Error(`Discord search failed with status ${response.status}: ${response.statusText}`);
      }

      rawData = await response.json();
    }
  } catch (err: any) {
    if (err?.status === 429 || err?.body?.retry_after) {
      const retryAfter = err?.body?.retry_after ?? 2;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 500));
      return searchDiscordMessages(options);
    }
    console.error('[VencordAI] Search error:', err);
    throw err;
  }

  const result: SearchResponse = {
    totalResults: rawData.total_results ?? 0,
    messages: rawData.messages ?? [],
    documentsIndexed: rawData.documents_indexed,
  };

  searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}
