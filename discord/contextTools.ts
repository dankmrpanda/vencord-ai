/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordChannel, DiscordMessage, ToolExecutionResult } from '../types';
import { isChannelAllowedInScope } from './scope';
import { abortableSleep, MAX_RETRY_AFTER_SECONDS, throwIfAborted } from './search';
import { getAuthToken, getChannel, getHTTP } from './stores';

/** Discord snowflakes are decimal; anything else must never be interpolated into a REST path. */
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

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

/**
 * GET with bounded 429 handling: waits end when the run is stopped, and a retry_after above the cap fails the
 * call at once instead of retrying in the background after the tool has timed out.
 */
async function discordGet(path: string, query: Record<string, string> = {}, signal?: AbortSignal, retriesRemaining = 3): Promise<any> {
  throwIfAborted(signal);
  const http = getHTTP();
  if (http?.get) {
    try {
      const response = await http.get({ url: path, query });
      return response?.body ?? response;
    } catch (err: any) {
      const retrySec = extractRetrySec(err);
      if (retrySec !== null && retrySec <= MAX_RETRY_AFTER_SECONDS && retriesRemaining > 0) {
        console.warn(`[VencordAI] Discord 429 rate limit on ${path}, retrying after ${retrySec}s...`);
        await abortableSleep(retrySec * 1000 + 300, signal);
        return discordGet(path, query, signal, retriesRemaining - 1);
      }
      throw err;
    }
  }
  const suffix = new URLSearchParams(query).toString();
  const response = await fetch(`https://discord.com/api/v9${path}${suffix ? `?${suffix}` : ''}`, {
    headers: { Authorization: getAuthToken() || '', 'Content-Type': 'application/json' },
    signal,
  });
  if (response.status === 429) {
    const retrySec = extractRetrySec(response) || 2;
    if (retrySec > MAX_RETRY_AFTER_SECONDS || retriesRemaining <= 0) throw new Error('Discord read rate-limited (429).');
    console.warn(`[VencordAI] Discord 429 rate limit on ${path}, retrying after ${retrySec}s...`);
    await abortableSleep(retrySec * 1000 + 300, signal);
    return discordGet(path, query, signal, retriesRemaining - 1);
  }
  if (!response.ok) throw new Error(`Discord read failed (${response.status}).`);
  return response.json();
}

/**
 * Reads one message the way a user account can. `GET /channels/{c}/messages/{id}` is bot-only (user accounts get
 * 403), so this asks for the single message around the ID and keeps it only when the ID matches.
 */
export async function fetchOneMessage(channelId: string, messageId: string, signal?: AbortSignal): Promise<DiscordMessage | undefined> {
  const page = await discordGet(`/channels/${channelId}/messages`, { around: messageId, limit: '1' }, signal);
  return Array.isArray(page) ? page.find((message: DiscordMessage | undefined) => message?.id === messageId) : undefined;
}

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
    }, signal);
  } catch {
    body = await discordGet(`/channels/${channelId}/pins`, {}, signal);
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
  const payloads = [await discordGet(`/guilds/${scope.guildId}/threads/active`, {}, signal)];
  if (includeArchived) {
    payloads.push(await discordGet(`/channels/${parentId}/threads/archived/public`, { limit: String(limit) }, signal));
  }
  const threads = payloads.flatMap((payload) => payload?.threads || []) as DiscordChannel[];
  const permitted = threads.filter((thread) => {
    const parent = thread.parent_id || parentId;
    const requestedParentMatches = !channelId || parent === parentId || thread.id === targetChannelId;
    return requestedParentMatches && (isChannelAllowedInScope(parent, scope) || isChannelAllowedInScope(thread.id, scope));
  }).slice(0, limit);
  const items = await Promise.all(permitted.map(async (thread): Promise<ThreadListItem> => {
    let starterMessage: DiscordMessage | undefined;
    if (isSnowflake(thread.id)) {
      try {
        const starter = await fetchOneMessage(thread.id, thread.id, signal);
        if (starter?.channel_id === thread.id || (thread.parent_id && starter?.channel_id === thread.parent_id)) starterMessage = starter;
      } catch {}
    }
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
