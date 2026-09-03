/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordChannel, DiscordMessage, ToolExecutionResult } from '../types';
import { isChannelAllowedInScope } from './scope';
import { getAuthToken, getChannel, getHTTP } from './stores';

function extractRetrySec(target: any): number | null {
  if (!target) return null;
  const status = target.status ?? target.statusCode;
  const retryVal = target.headers?.get?.('Retry-After') ?? target.body?.retry_after ?? target.retry_after;
  if (retryVal) {
    const sec = Number(retryVal);
    return isNaN(sec) ? 2 : Math.max(sec, 1);
  }
  if (status === 429) return 2;
  return null;
}

async function discordGet(path: string, query: Record<string, string> = {}, retriesRemaining = 3): Promise<any> {
  const http = getHTTP();
  if (http?.get) {
    try {
      const response = await http.get({ url: path, query });
      return response?.body ?? response;
    } catch (err: any) {
      const retrySec = extractRetrySec(err);
      if (retrySec !== null && retriesRemaining > 0) {
        console.warn(`[VencordAI] Discord 429 rate limit on ${path}, retrying after ${retrySec}s...`);
        await new Promise((resolve) => setTimeout(resolve, retrySec * 1000 + 300));
        return discordGet(path, query, retriesRemaining - 1);
      }
      throw err;
    }
  }
  const suffix = new URLSearchParams(query).toString();
  const response = await fetch(`https://discord.com/api/v9${path}${suffix ? `?${suffix}` : ''}`, {
    headers: { Authorization: getAuthToken() || '', 'Content-Type': 'application/json' },
  });
  if (response.status === 429 && retriesRemaining > 0) {
    const retrySec = extractRetrySec(response) || 2;
    console.warn(`[VencordAI] Discord 429 rate limit on ${path}, retrying after ${retrySec}s...`);
    await new Promise((resolve) => setTimeout(resolve, retrySec * 1000 + 300));
    return discordGet(path, query, retriesRemaining - 1);
  }
  if (!response.ok) throw new Error(`Discord read failed (${response.status}).`);
  return response.json();
}

export async function getMessageDetails(
  scope: CurrentScopeContext,
  channelId: string,
  messageId: string,
  replyDepth: number,
): Promise<ToolExecutionResult<{ message: DiscordMessage; replyChain: DiscordMessage[] }>> {
  if (!isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested message channel is outside the permitted scope.' };
  }
  const message = await discordGet(`/channels/${channelId}/messages/${messageId}`) as DiscordMessage;
  const replyChain: DiscordMessage[] = [];
  let current = message;
  for (let depth = 0; depth < replyDepth; depth++) {
    const reference = current.referenced_message;
    const referenceId = reference?.id || current.message_reference?.message_id;
    const referenceChannel = reference?.channel_id || current.message_reference?.channel_id || channelId;
    if (!referenceId || !isChannelAllowedInScope(referenceChannel, scope)) break;
    current = reference || await discordGet(`/channels/${referenceChannel}/messages/${referenceId}`) as DiscordMessage;
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
): Promise<ToolExecutionResult<{ messages: DiscordMessage[] }>> {
  if (!isChannelAllowedInScope(channelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested pin channel is outside the permitted scope.' };
  }
  let body: any;
  try {
    body = await discordGet(`/channels/${channelId}/messages/pins`, {
      limit: String(limit),
      ...(before ? { before } : {}),
    });
  } catch {
    body = await discordGet(`/channels/${channelId}/pins`);
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
): Promise<ToolExecutionResult<{ threads: ThreadListItem[] }>> {
  const targetChannelId = channelId || scope.channelId;
  if (!isChannelAllowedInScope(targetChannelId, scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested thread parent is outside the permitted scope.' };
  }
  const target = getChannel(targetChannelId);
  const parentId = target?.isThread?.() ? target.parent_id || targetChannelId : targetChannelId;
  if (!scope.guildId) return { ok: false, code: 'unavailable', summary: 'Discord threads are only available in guild scope.' };
  const payloads = [await discordGet(`/guilds/${scope.guildId}/threads/active`)];
  if (includeArchived) {
    payloads.push(await discordGet(`/channels/${parentId}/threads/archived/public`, { limit: String(limit) }));
  }
  const threads = payloads.flatMap((payload) => payload?.threads || []) as DiscordChannel[];
  const permitted = threads.filter((thread) => {
    const parent = thread.parent_id || parentId;
    const requestedParentMatches = !channelId || parent === parentId || thread.id === targetChannelId;
    return requestedParentMatches && (isChannelAllowedInScope(parent, scope) || isChannelAllowedInScope(thread.id, scope));
  }).slice(0, limit);
  const items = await Promise.all(permitted.map(async (thread): Promise<ThreadListItem> => {
    let starterMessage: DiscordMessage | undefined;
    try {
      starterMessage = await discordGet(`/channels/${thread.id}/messages/${thread.id}`);
    } catch {}
    return { thread, parent: getChannel(thread.parent_id || '') || undefined, starterMessage };
  }));
  return {
    ok: true,
    code: items.length ? 'threads' : 'empty_results',
    summary: `Retrieved ${items.length} scoped active${includeArchived ? ' or archived' : ''} thread${items.length === 1 ? '' : 's'}.`,
    data: { threads: items },
    scope: { channelIds: [parentId], guildId: scope.guildId },
    truncation: { truncated: threads.length > items.length, returned: items.length, available: threads.length },
  };
}
