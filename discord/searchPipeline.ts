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
import { filterIndexQueryToScope, filterMessagesToScope, getPermittedChannelIdsForScope, isChannelAllowedInScope } from './scope';
import { getChannel } from './stores';
import { retrievalEngine } from '../storage/retrieval';
import { MESSAGE_FLAGS, StoredMessageRecord } from '../storage/index/types';

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
  embeddedContext?: Record<string, DiscordMessage[]>;
}

function hitMessages(groups: DiscordMessage[][]): DiscordMessage[] {
  return groups.flatMap((group) => {
    const hit = group.find((message) => message.hit) || group[0];
    return hit ? [hit] : [];
  });
}

function collectEmbeddedContext(groups: DiscordMessage[][], target: Record<string, DiscordMessage[]>): void {
  for (const group of groups) {
    if (!Array.isArray(group) || group.length <= 1) continue;
    const hit = group.find((message) => message.hit) || group[0];
    if (hit?.id && !target[hit.id]) {
      target[hit.id] = group;
    }
  }
}

/** Messages rebuilt from a local-index record: no embeds, mentions or attachment URLs. */
const indexStubs = new WeakSet<DiscordMessage>();

export function indexStubMessage(record: StoredMessageRecord): DiscordMessage {
  const message: DiscordMessage = {
    id: record.id,
    channel_id: record.channelId,
    guild_id: record.guildId,
    author: { id: record.authorId, username: record.authorName },
    content: record.content,
    timestamp: new Date(record.timestamp).toISOString(),
    pinned: Boolean(record.flags & MESSAGE_FLAGS.IS_PINNED),
    attachments: (record.attachmentNames || []).map((fn) => ({
      id: '0',
      filename: fn,
      size: 0,
      url: '',
      proxy_url: '',
    })),
    embeds: [],
    mentions: [],
    hit: true,
  };
  indexStubs.add(message);
  return message;
}

/** SRCH-03: the later copy of a message wins, except that an index stub never replaces a full copy. */
export function deduplicate(messages: DiscordMessage[]): DiscordMessage[] {
  const byId = new Map<string, DiscordMessage>();
  for (const message of messages) {
    const kept = byId.get(message.id);
    if (kept && indexStubs.has(message) && !indexStubs.has(kept)) continue;
    byId.set(message.id, message);
  }
  return Array.from(byId.values());
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
  const isCustomMultiChannel = Boolean(scope.isGuild && scope.scopeMode === 'custom' && !request.channelId);
  const permittedCustomChannels = isCustomMultiChannel ? getPermittedChannelIdsForScope(scope) : [];
  const guildWide = Boolean(
    (request.guildWide && isGuildWideAllowed) ||
    (isCustomMultiChannel && permittedCustomChannels.length > 4),
  );
  const channelId = guildWide
    ? undefined
    : isCustomMultiChannel && permittedCustomChannels.length > 1
      ? undefined
      : (request.channelId || scope.channelId);

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
  const embeddedContext: Record<string, DiscordMessage[]> = {};
  let fallbackUsed: 'local_index' | 'local_scan' | 'none' = 'none';
  let remoteSearchFailed = false;
  const offset = request.offset || 0;
  // The offset cursor belongs to the primary remote variant; other sources do not share it.
  let primary: { hits: DiscordMessage[]; totalResults: number } | undefined;

  const hasRemoteSearchCriteria = (variant?: string) => Boolean(
    variant ||
    request.authorId ||
    request.has ||
    request.date ||
    request.afterDate ||
    request.beforeDate ||
    request.pinned !== undefined ||
    request.mentions,
  );

  // 3. Remote Discord Search with Throttling & 429 Backoff
  if (isCustomMultiChannel && permittedCustomChannels.length > 1 && permittedCustomChannels.length <= 4 && offset === 0) {
    for (const customChId of permittedCustomChannels) {
      const variant = variants[0];
      if (!hasRemoteSearchCriteria(variant)) break;
      try {
        const response = await searchDiscordMessages({
          query: variant,
          pattern,
          channelId: customChId,
          guildId: scope.guildId,
          guildWide: false,
          authorId: request.authorId,
          has: request.has,
          duringDate: request.date,
          afterDate: request.afterDate,
          beforeDate: request.beforeDate,
          sortBy: request.sortBy,
          sortOrder: request.sortOrder,
          offset: 0,
          pinned: request.pinned,
          mentions: request.mentions,
        }, 3, signal);
        collectEmbeddedContext(response.messages, embeddedContext);
        candidates.push(...hitMessages(response.messages));
        if (candidates.length >= request.limit * 2) break;
      } catch (remoteErr) {
        if (signal?.aborted) throw remoteErr;
        console.warn('[VencordAI] Custom-scope Discord search failed, falling back:', remoteErr);
        remoteSearchFailed = true;
        break;
      }
    }
  } else {
    for (const variant of variants.length ? variants : [undefined]) {
      if (!hasRemoteSearchCriteria(variant)) {
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
        collectEmbeddedContext(response.messages, embeddedContext);
        const hits = hitMessages(response.messages);
        if (variant === variants[0]) primary = { hits, totalResults: response.totalResults };
        candidates.push(...hits);
        if (offset > 0) break;
        // Stop relaxed variants once the primary query returned plenty of permitted hits.
        if (variant === variants[0] && hits.length >= Math.max(request.limit, 5)) break;
      } catch (remoteErr) {
        // A cancelled run must stop, not fall back to local sources.
        if (signal?.aborted) throw remoteErr;
        console.warn('[VencordAI] Remote Discord search failed, falling back to local index:', remoteErr);
        remoteSearchFailed = true;
        break;
      }
    }
  }

  // Later pages have no local fallback: report the failure so it is not read as the end of the results.
  if (remoteSearchFailed && offset > 0) {
    return {
      ok: false,
      code: 'remote_search_failed',
      summary: 'Discord search failed for this page (rate limited or unavailable), so later results could not be fetched in this run; tell the user they can retry later.',
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
          const localMessages = localIndexResult.hits.map((h) => indexStubMessage(h.record));
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
  const scanChannelIds = channelId
    ? [channelId]
    : isCustomMultiChannel
      ? permittedCustomChannels.slice(0, 4)
      : [];
  if (offset === 0 && scanChannelIds.length > 0 && candidates.length < request.limit) {
    const perChannelScan = scanChannelIds.length === 1
      ? request.scanLimit
      : Math.max(25, Math.floor(request.scanLimit / scanChannelIds.length));
    for (const scanChId of scanChannelIds) {
      try {
        const recent = await fetchRecentMessages(
          scanChId,
          perChannelScan,
          scanChannelIds.length === 1 ? request.beforeMessageId : undefined,
          signal,
        );
        if (scanChannelIds.length === 1 && recent.length === request.scanLimit) {
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
  const sortByTimestamp = request.sortBy === 'timestamp' || (!query && Boolean(request.sortOrder));
  const ranked = scoped.sort((a, b) => {
    if (sortByTimestamp) {
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

  const activeFilters = [
    query ? `query=${JSON.stringify(variants.filter(Boolean))}` : '',
    pattern ? `pattern=${JSON.stringify(pattern)}` : '',
    request.authorId ? `author_id=${request.authorId}` : '',
    request.mentions ? `mentions=${request.mentions}` : '',
    request.has ? `has=${request.has}` : '',
    request.date ? `date=${request.date}` : '',
    request.afterDate ? `after=${request.afterDate}` : '',
    request.beforeDate ? `before=${request.beforeDate}` : '',
    request.pinned !== undefined ? `pinned=${request.pinned}` : '',
  ].filter(Boolean);
  const emptySummary = activeFilters.length
    ? `No permitted messages matched (${activeFilters.join(', ')}). Try broader 1-word keywords, remove optional filters, increase scan_limit, or check list_threads/list_channel_pins.`
    : 'No permitted messages matched the bounded search. Try specifying a keyword, pattern, author, date, or media filter.';

  return {
    ok: true,
    code: messages.length ? 'search_results' : 'empty_results',
    summary: messages.length
      ? `Found ${messages.length} permitted message${messages.length === 1 ? '' : 's'} across ${Math.max(variants.length, 1)} search variant(s)${fallbackUsed !== 'none' ? ` via ${fallbackUsed}` : ''}.`
      : emptySummary,
    untrustedData: true,
    data: {
      messages,
      variants: variants.filter(Boolean) as string[],
      fallbackUsed,
      ...(Object.keys(embeddedContext).length ? { embeddedContext } : {}),
    },
    scope: {
      channelIds: channelId
        ? [channelId]
        : isCustomMultiChannel
          ? permittedCustomChannels
          : scope.accessibleGuildChannels?.map((c) => c.id) || [],
      guildId: scope.guildId,
    },
    pagination: { nextOffset, nextBeforeMessageId: localNextBeforeMessageId },
    truncation: { truncated: ranked.length > messages.length || Boolean(localNextBeforeMessageId), returned: messages.length, available: ranked.length },
  };
}
