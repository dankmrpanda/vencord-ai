/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordChannel, DiscordMessage, ToolExecutionResult } from '../types';
import { discordGet, fetchOneMessage, isSnowflake, throwIfAborted } from './rest';
import { isChannelAllowedInScope } from './scope';
import { getChannel } from './stores';

export async function getMessageDetails(
  scope: CurrentScopeContext,
  channelId: string,
  messageId: string,
  replyDepth: number,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<{ message: DiscordMessage; replyChain: DiscordMessage[] }>> {
  if (!isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested message channel is outside the permitted scope.' };
  }
  if (!isSnowflake(messageId)) {
    return { ok: false, code: 'invalid_arguments', summary: 'message_id must be a numeric Discord message ID.' };
  }
  const message = await fetchOneMessage(channelId, messageId, signal);
  if (!message) {
    return { ok: false, code: 'not_found', summary: 'The message was not found, or this account cannot read it.' };
  }
  if (message.channel_id !== channelId) {
    return { ok: false, code: 'scope_denied', summary: 'The returned message does not belong to the requested channel.' };
  }
  const replyChain: DiscordMessage[] = [];
  let current = message;
  for (let depth = 0; depth < replyDepth; depth++) {
    const reference = current.referenced_message;
    const referenceId = reference?.id || current.message_reference?.message_id;
    const referenceChannel = reference?.channel_id || current.message_reference?.channel_id || channelId;
    if (!isSnowflake(referenceId) || !isChannelAllowedInScope(referenceChannel, scope)) break;
    const next = reference || await fetchOneMessage(referenceChannel, referenceId, signal);
    if (!next || (next.channel_id && next.channel_id !== referenceChannel)) break;
    current = next;
    replyChain.push(current);
  }
  return {
    ok: true,
    code: 'message_details',
    summary: `Retrieved one scoped message and ${replyChain.length} referenced repl${replyChain.length === 1 ? 'y' : 'ies'}.`,
    data: { message, replyChain },
    scope: { channelIds: [channelId], guildId: scope.guildId },
    truncation: { truncated: replyChain.length === replyDepth && Boolean(current.message_reference?.message_id), returned: 1 + replyChain.length },
  };
}

export async function listChannelPins(
  scope: CurrentScopeContext,
  channelId: string,
  limit: number,
  before?: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<{ messages: DiscordMessage[] }>> {
  if (!isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested pin channel is outside the permitted scope.' };
  }
  let body: any;
  try {
    body = await discordGet(`/channels/${channelId}/messages/pins`, {
      limit: String(limit),
      ...(before ? { before } : {}),
    }, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    body = await discordGet(`/channels/${channelId}/pins`, {}, { signal });
  }
  const items = Array.isArray(body) ? body.map((message) => ({ message })) : body?.items || [];
  const messages = items
    .map((item: any) => item?.message || item)
    .filter((message: DiscordMessage) => message?.channel_id === channelId)
    .slice(0, limit);
  return {
    ok: true,
    code: messages.length ? 'channel_pins' : 'empty_results',
    summary: `Retrieved ${messages.length} scoped pinned message${messages.length === 1 ? '' : 's'}.`,
    data: { messages },
    scope: { channelIds: [channelId], guildId: scope.guildId },
    pagination: { nextCursor: body?.has_more ? items[items.length - 1]?.pinned_at : undefined },
    truncation: { truncated: Boolean(body?.has_more), returned: messages.length },
  };
}

export interface ThreadListItem {
  thread: DiscordChannel;
  parent?: DiscordChannel;
  starterMessage?: DiscordMessage;
}

export async function listThreads(
  scope: CurrentScopeContext,
  channelId: string | undefined,
  limit: number,
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<{ threads: ThreadListItem[] }>> {
  const targetChannelId = channelId || scope.channelId;
  if (!isChannelAllowedInScope(targetChannelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested thread parent is outside the permitted scope.' };
  }
  const target = getChannel(targetChannelId);
  const parentId = target?.isThread?.() ? target.parent_id || targetChannelId : targetChannelId;
  if (!scope.guildId) return { ok: false, code: 'unavailable', summary: 'Discord threads are only available in guild scope.' };
  const payloads = [await discordGet(`/guilds/${scope.guildId}/threads/active`, {}, { signal })];
  if (includeArchived) {
    payloads.push(await discordGet(`/channels/${parentId}/threads/archived/public`, { limit: String(limit) }, { signal }));
  }
  const threads = payloads.flatMap((payload) => payload?.threads || []) as DiscordChannel[];
  const permitted = threads.filter((thread) => {
    const parent = thread.parent_id || parentId;
    const requestedParentMatches = !channelId || parent === parentId || thread.id === targetChannelId;
    return requestedParentMatches && (isChannelAllowedInScope(parent, scope) || isChannelAllowedInScope(thread.id, scope));
  }).slice(0, limit);
  const items: ThreadListItem[] = [];
  for (let i = 0; i < permitted.length; i++) {
    throwIfAborted(signal);
    const thread = permitted[i];
    let starterMessage: DiscordMessage | undefined;
    // Fetch starter messages sequentially for at most the top 10 threads to avoid 429 bursts.
    if (i < 10 && isSnowflake(thread.id)) {
      try {
        const starter = await fetchOneMessage(thread.id, thread.id, signal);
        if (starter?.channel_id === thread.id || (thread.parent_id && starter?.channel_id === thread.parent_id)) starterMessage = starter;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    items.push({ thread, parent: getChannel(thread.parent_id || '') || undefined, starterMessage });
  }
  return {
    ok: true,
    code: items.length ? 'threads' : 'empty_results',
    summary: `Retrieved ${items.length} scoped active${includeArchived ? ' or archived' : ''} thread${items.length === 1 ? '' : 's'}.`,
    data: { threads: items },
    scope: { channelIds: [parentId], guildId: scope.guildId },
    truncation: { truncated: threads.length > items.length, returned: items.length, available: threads.length },
  };
}
