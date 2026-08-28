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
import { filterMessagesToScope, isChannelAllowedInScope } from './scope';
import { getChannel } from './stores';

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
  const guildWide = Boolean(request.guildWide && scope.isGuild);
  const channelId = guildWide ? undefined : (request.channelId || scope.channelId);
  if (channelId && !isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested channel is outside the permitted Discord scope.' };
  }
  if (scope.isDM && request.channelId && request.channelId !== scope.channelId
    && !scope.mutualGroupDMs?.some((group) => group.id === request.channelId)) {
    return { ok: false, code: 'dm_scope_denied', summary: 'Only the active DM or an explicitly requested mutual group DM may be searched.' };
  }

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
  let localNextBeforeMessageId: string | undefined;
  for (const variant of variants.length ? variants : [undefined]) {
    if (!variant && !request.authorId && !request.has && !request.date && !request.afterDate
      && !request.beforeDate && request.pinned === undefined && !request.mentions) break;
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
  }

  if (channelId && candidates.length < request.limit) {
    const recent = await fetchRecentMessages(channelId, request.scanLimit, request.beforeMessageId);
    if (recent.length === request.scanLimit) {
      localNextBeforeMessageId = recent.reduce((oldest, message) =>
        new Date(message.timestamp).getTime() < new Date(oldest.timestamp).getTime() ? message : oldest,
      ).id;
    }
    candidates.push(...filterMessagesLocally(recent, {
      query,
      pattern,
      authorId: request.authorId,
      has: request.has,
      duringDate: request.date,
      afterDate: request.afterDate,
      beforeDate: request.beforeDate,
      pinned: request.pinned,
      mentions: request.mentions,
    }));
  }

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
      ? `Found ${messages.length} permitted message${messages.length === 1 ? '' : 's'} across ${Math.max(variants.length, 1)} bounded search variant(s).`
      : 'No permitted messages matched the bounded search.',
    data: { messages, variants: variants.filter(Boolean) as string[] },
    scope: { channelIds: channelId ? [channelId] : scope.accessibleGuildChannels?.map((channel) => channel.id) || [], guildId: scope.guildId },
    pagination: { nextOffset, nextBeforeMessageId: localNextBeforeMessageId },
    truncation: { truncated: ranked.length > messages.length || Boolean(localNextBeforeMessageId), returned: messages.length, available: ranked.length },
  };
}
