/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordMessage, ToolExecutionResult } from '../types';
import {
  detectPatternFromQuery,
  generateRelaxedQueries,
  resolveDateSnowflakeBounds,
  searchDiscordMessages,
  snowflakeToDate,
} from './search';
import {
  compileRegexSafely,
  fetchRecentMessages,
  filterMessagesLocally,
  scoreMessageRelevance,
} from './messages';
import { filterIndexQueryToScope, filterMessagesToScope, isChannelAllowedInScope } from './scope';
import { getChannel } from './stores';
import { retrievalEngine } from '../storage/retrieval';
import { MESSAGE_FLAGS } from '../storage/index/types';

export interface MessageSearchRequest {
  query?: string;
  pattern?: string;
  channelId?: string;
  guildWide?: boolean;
  authorId?: string;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  date?: string;
  afterDate?: string;
  beforeDate?: string;
  sortBy?: 'timestamp' | 'relevance';
  sortOrder?: 'desc' | 'asc';
  offset?: number;
  pinned?: boolean;
  mentions?: string;
  limit: number;
  scanLimit: number;
  beforeMessageId?: string;
}

export interface MessageSearchData {
  messages: DiscordMessage[];
  variants: string[];
  fallbackUsed?: 'local_index' | 'local_scan' | 'none';
}

function hitMessages(groups: DiscordMessage[][]): DiscordMessage[] {
  return groups.flatMap((group) => {
    const hit = group.find((message) => message.hit) || group[0];
    return hit ? [hit] : [];
  });
}

function deduplicate(messages: DiscordMessage[]): DiscordMessage[] {
  return Array.from(new Map(messages.map((message) => [message.id, message])).values());
}

/** Date-only values must name a real calendar day; other values must parse to a finite time. */
function isValidSearchDate(value: string): boolean {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  return Number.isFinite(new Date(value).getTime());
}

export async function runMessageSearch(
  request: MessageSearchRequest,
  scope: CurrentScopeContext,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<MessageSearchData>> {
  // 1. Fail-Closed Scope Pre-Check
  const isGuildWideAllowed = Boolean(scope.isGuild && (scope.scopeMode === 'server' || scope.scopeMode === undefined));
  const guildWide = Boolean(request.guildWide && isGuildWideAllowed);
  const channelId = guildWide ? undefined : (request.channelId || scope.channelId);

  if (channelId && !isChannelAllowedInScope(channelId, scope)) {
    return {
      ok: false,
      code: 'scope_denied',
      summary: 'The requested channel is outside the permitted Discord scope.',
      untrustedData: true,
      scope: { channelIds: [channelId], guildId: scope.guildId },
    };
  }

  // 2. Query Preprocessing & Pattern Extraction
  let query = request.query?.trim();
  let pattern = request.pattern?.trim();
  if (query) {
    const detected = detectPatternFromQuery(query);
    pattern ||= detected.pattern || undefined;
    query = detected.cleanedQuery || (detected.pattern ? undefined : query);
  }
  if (pattern && !compileRegexSafely(pattern)) {
    return {
      ok: false,
      code: 'invalid_pattern',
      summary: 'The search pattern is invalid or failed regex safety analysis.',
      untrustedData: true,
    };
  }
  const invalidDate = [request.date, request.afterDate, request.beforeDate].find((value) => value && !isValidSearchDate(value));
  if (invalidDate) {
    return {
      ok: false,
      code: 'invalid_date',
      summary: `The date "${invalidDate}" is not a valid date; use YYYY-MM-DD or an ISO 8601 timestamp.`,
      untrustedData: true,
    };
  }

  const variants = query
    ? [query, ...generateRelaxedQueries(query)].slice(0, 3)
    : [];
  const candidates: DiscordMessage[] = [];
  let fallbackUsed: 'local_index' | 'local_scan' | 'none' = 'none';
  let remoteSearchFailed = false;
  const offset = request.offset || 0;
  // The offset cursor belongs to the primary remote variant; other sources do not share it.
  let primary: { hits: DiscordMessage[]; totalResults: number } | undefined;

  // 3. Remote Discord Search with Throttling & 429 Backoff
  for (const variant of variants.length ? variants : [undefined]) {
    if (
      !variant &&
      !request.authorId &&
      !request.has &&
      !request.date &&
      !request.afterDate &&
      !request.beforeDate &&
      request.pinned === undefined &&
      !request.mentions
    ) {
      break;
    }

    try {
      const response = await searchDiscordMessages({
        query: variant,
        pattern,
        channelId,
        guildId: scope.isGuild ? scope.guildId : getChannel(channelId || scope.channelId)?.guild_id,
        guildWide,
        authorId: request.authorId,
        has: request.has,
        duringDate: request.date,
        afterDate: request.afterDate,
        beforeDate: request.beforeDate,
        sortBy: request.sortBy,
        sortOrder: request.sortOrder,
        offset: request.offset,
        pinned: request.pinned,
        mentions: request.mentions,
      }, 3, signal);
      const hits = hitMessages(response.messages);
      if (variant === variants[0]) primary = { hits, totalResults: response.totalResults };
      candidates.push(...hits);
      if (offset > 0) break;
    } catch (remoteErr) {
      // A cancelled run must stop, not fall back to local sources.
      if (signal?.aborted) throw remoteErr;
      console.warn('[VencordAI] Remote Discord search failed, falling back to local index:', remoteErr);
      remoteSearchFailed = true;
      break;
    }
  }

  // Later pages have no local fallback: report the failure so it is not read as the end of the results.
  if (remoteSearchFailed && offset > 0) {
    return {
      ok: false,
      code: 'remote_search_failed',
      summary: 'Discord search failed for this page (rate limited or unavailable); retry later with the same offset.',
      untrustedData: true,
    };
  }

  // 4. Seamless Hybrid Search Fallback (Local Inverted Index)
  if (offset === 0 && (remoteSearchFailed || candidates.length < request.limit)) {
    // Compact index records do not retain mention identities or full media metadata.
    // Use Discord/recent-message results when those filters cannot be verified.
    if (!request.has && !request.mentions && (query || pattern || request.authorId || request.date || request.afterDate || request.beforeDate || request.pinned !== undefined)) {
      try {
        const bounds = resolveDateSnowflakeBounds({
          duringDate: request.date,
          afterDate: request.afterDate,
          beforeDate: request.beforeDate,
        });
        const indexQuery = filterIndexQueryToScope(
          {
            query,
            pattern,
            channelIds: channelId ? [channelId] : undefined,
            authorId: request.authorId,
            date: request.date,
            minTimestamp: bounds.minId ? snowflakeToDate(bounds.minId).getTime() : undefined,
            maxTimestamp: bounds.maxId ? snowflakeToDate(bounds.maxId).getTime() : undefined,
            flagsRequired: request.pinned === true ? MESSAGE_FLAGS.IS_PINNED : undefined,
            flagsExcluded: request.pinned === false ? MESSAGE_FLAGS.IS_PINNED : undefined,
            limit: request.limit * 2,
          },
          scope,
        );

        const localIndexResult = await retrievalEngine.search(indexQuery, scope);
        if (localIndexResult.hits.length > 0) {
          const localMessages: DiscordMessage[] = localIndexResult.hits.map((h) => ({
            id: h.record.id,
            channel_id: h.record.channelId,
            guild_id: h.record.guildId,
            author: { id: h.record.authorId, username: h.record.authorName },
            content: h.record.content,
            timestamp: new Date(h.record.timestamp).toISOString(),
            pinned: Boolean(h.record.flags & MESSAGE_FLAGS.IS_PINNED),
            attachments: (h.record.attachmentNames || []).map((fn) => ({
              id: '0',
              filename: fn,
              size: 0,
              url: '',
              proxy_url: '',
            })),
            embeds: [],
            mentions: [],
            hit: true,
          }));
          candidates.push(...localMessages);
          fallbackUsed = 'local_index';
        }
      } catch (indexErr) {
        console.warn('[VencordAI] Local index search error:', indexErr);
      }
    }
  }

  // 5. Local Channel MessageStore Recent Scan Fallback
  let localNextBeforeMessageId: string | undefined;
  if (offset === 0 && channelId && candidates.length < request.limit) {
    try {
      const recent = await fetchRecentMessages(channelId, request.scanLimit, request.beforeMessageId, signal);
      if (recent.length === request.scanLimit) {
        localNextBeforeMessageId = recent.reduce((oldest, message) =>
          new Date(message.timestamp).getTime() < new Date(oldest.timestamp).getTime() ? message : oldest,
        ).id;
      }
      const filteredRecent = filterMessagesLocally(recent, {
        query,
        pattern,
        authorId: request.authorId,
        has: request.has,
        duringDate: request.date,
        afterDate: request.afterDate,
        beforeDate: request.beforeDate,
        pinned: request.pinned,
        mentions: request.mentions,
      });
      candidates.push(...filteredRecent);
      if (fallbackUsed === 'none') fallbackUsed = 'local_scan';
    } catch (scanErr) {
      if (signal?.aborted) throw scanErr;
    }
  }

  // 6. Deduplication, Ranking & Fail-Closed Post-Filtering
  const scoped = filterMessagesToScope(filterMessagesLocally(deduplicate(candidates), {
    pattern,
    authorId: request.authorId,
    has: request.has,
    duringDate: request.date,
    afterDate: request.afterDate,
    beforeDate: request.beforeDate,
    pinned: request.pinned,
    mentions: request.mentions,
  }), scope);
  const ranked = scoped.sort((a, b) => {
    if (request.sortBy === 'timestamp') {
      const timeDifference = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      return request.sortOrder === 'asc' ? timeDifference : -timeDifference;
    }
    const score = scoreMessageRelevance(b, query || '') - scoreMessageRelevance(a, query || '');
    return score || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
  // A page consumes primary hits in Discord order, so the next offset neither skips nor repeats them.
  const consumed = primary ? primary.hits.slice(0, request.limit) : [];
  const nextOffset = primary && offset + consumed.length < primary.totalResults && consumed.length > 0
    ? offset + consumed.length
    : undefined;
  let messages = ranked.slice(0, request.limit);
  if (nextOffset !== undefined) {
    // While more primary pages remain, the page is exactly the consumed primary hits (ranked locally);
    // other sources would crowd them out or repeat on later pages.
    const pageIds = new Set(consumed.map((message) => message.id));
    messages = ranked.filter((message) => pageIds.has(message.id));
  }

  return {
    ok: true,
    code: messages.length ? 'search_results' : 'empty_results',
    summary: messages.length
      ? `Found ${messages.length} permitted message${messages.length === 1 ? '' : 's'} across ${Math.max(variants.length, 1)} search variant(s)${fallbackUsed !== 'none' ? ` via ${fallbackUsed}` : ''}.`
      : 'No permitted messages matched the bounded search.',
    untrustedData: true,
    data: { messages, variants: variants.filter(Boolean) as string[], fallbackUsed },
    scope: { channelIds: channelId ? [channelId] : scope.accessibleGuildChannels?.map((c) => c.id) || [], guildId: scope.guildId },
    pagination: { nextOffset, nextBeforeMessageId: localNextBeforeMessageId },
    truncation: { truncated: ranked.length > messages.length || Boolean(localNextBeforeMessageId), returned: messages.length, available: ranked.length },
  };
}
