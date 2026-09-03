/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordMessage, ToolExecutionResult } from '../types';
import {
  detectPatternFromQuery,
  generateRelaxedQueries,
  searchDiscordMessages,
} from './search';
import {
  fetchRecentMessages,
  filterMessagesLocally,
  scoreMessageRelevance,
} from './messages';
import { filterIndexQueryToScope, filterMessagesToScope, isChannelAllowedInScope } from './scope';
import { getChannel } from './stores';
import { retrievalEngine } from '../storage/retrieval';

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

export async function runMessageSearch(
  request: MessageSearchRequest,
  scope: CurrentScopeContext,
): Promise<ToolExecutionResult<MessageSearchData>> {
  // 1. Fail-Closed Scope Pre-Check
  const guildWide = Boolean(request.guildWide && scope.isGuild);
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

  const variants = query
    ? [query, ...generateRelaxedQueries(query)].slice(0, 3)
    : [];
  const candidates: DiscordMessage[] = [];
  let fallbackUsed: 'local_index' | 'local_scan' | 'none' = 'none';
  let remoteSearchFailed = false;

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
      });
      candidates.push(...hitMessages(response.messages));
    } catch (remoteErr) {
      console.warn('[VencordAI] Remote Discord search failed, falling back to local index:', remoteErr);
      remoteSearchFailed = true;
      break;
    }
  }

  // 4. Seamless Hybrid Search Fallback (Local Inverted Index)
  if (remoteSearchFailed || candidates.length < request.limit) {
    if (query || pattern || request.authorId || request.date) {
      try {
        const indexQuery = filterIndexQueryToScope(
          {
            query,
            pattern,
            channelIds: channelId ? [channelId] : undefined,
            authorId: request.authorId,
            date: request.date,
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
  if (channelId && candidates.length < request.limit) {
    try {
      const recent = await fetchRecentMessages(channelId, request.scanLimit, request.beforeMessageId);
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
    } catch {}
  }

  // 6. Deduplication, Ranking & Fail-Closed Post-Filtering
  const scoped = filterMessagesToScope(deduplicate(candidates), scope);
  const ranked = scoped.sort((a, b) => {
    const score = scoreMessageRelevance(b, query || '') - scoreMessageRelevance(a, query || '');
    return score || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
  const messages = ranked.slice(0, request.limit);
  const nextOffset = candidates.length >= request.limit ? (request.offset || 0) + request.limit : undefined;

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
