/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getMessageDetails, listChannelPins, listThreads } from '../discord/contextTools';
import { fetchRecentMessages, fetchSurroundingMessages } from '../discord/messages';
import { runMessageSearch } from '../discord/searchPipeline';
import { isChannelAllowedInScope } from '../discord/scope';
import { getCurrentUser } from '../discord/stores';
import {
  RegisteredTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '../types';
import { AGENT_TOOLS } from './prompts';
import { validateToolArguments } from './validation';

type AnyTool = RegisteredTool<Record<string, unknown>, unknown>;

function definition(name: string): ToolDefinition {
  const found = AGENT_TOOLS.find((tool) => tool.function.name === name);
  if (!found) throw new Error(`Missing schema for registered tool ${name}.`);
  return found;
}

function registered(
  name: string,
  kind: 'local' | 'discord',
  execute: AnyTool['execute'],
  isAvailable: AnyTool['isAvailable'] = () => true,
  timeoutMs = 15_000,
): AnyTool {
  const schema = definition(name);
  return {
    definition: schema,
    parseArgs: (value) => validateToolArguments(schema, value),
    isAvailable,
    timeoutMs,
    readOnly: true,
    kind,
    execute,
  };
}

function ok<T>(code: string, summary: string, data: T): ToolExecutionResult<T> {
  return { ok: true, code, summary, data };
}

const getCurrentContext = registered('get_current_context', 'local', async (_, context) => {
  const scope = context.scope;
  const currentUser = scope.currentUser || getCurrentUser();
  const result = ok('current_context', 'Retrieved the active read-only Discord scope.', {
    channelId: scope.channelId,
    channelName: scope.channelName,
    channelType: scope.channelType,
    guildId: scope.guildId,
    guildName: scope.guildName,
    isDM: scope.isDM,
    isGroupDM: scope.isGroupDM,
    currentUser: currentUser ? { id: currentUser.id, username: currentUser.username, globalName: currentUser.globalName } : null,
    otherParticipant: scope.otherUser,
  });
  result.scope = { channelIds: [scope.channelId], guildId: scope.guildId };
  return result;
});

const listAvailableChannels = registered('list_available_channels', 'local', async (_, context) => {
  const scope = context.scope;
  const channels = scope.isGuild
    ? scope.accessibleGuildChannels || []
    : [{ id: scope.channelId, name: scope.channelName }];
  const result = ok('available_channels', `Listed ${channels.length} permitted channel${channels.length === 1 ? '' : 's'}.`, {
    channels,
    mutualGroupDMs: scope.isDM ? scope.mutualGroupDMs || [] : [],
  });
  result.scope = { channelIds: channels.map((channel) => channel.id), guildId: scope.guildId };
  result.truncation = { truncated: false, returned: channels.length };
  return result;
});

const searchMessages = registered('search_messages', 'discord', async (args, context) => {
  const limit = Math.min(Math.max(Number(args.limit) || context.settings.searchLimitPerQuery || 25, 1), 50);
  const result = await runMessageSearch({
    query: args.query as string | undefined,
    pattern: args.pattern as string | undefined,
    channelId: args.channel_id as string | undefined,
    guildWide: args.guild_wide as boolean | undefined,
    authorId: args.author_id as string | undefined,
    has: args.has as any,
    date: (args.date || args.during_date) as string | undefined,
    afterDate: args.after_date as string | undefined,
    beforeDate: args.before_date as string | undefined,
    sortBy: args.sort_by as any,
    sortOrder: args.sort_order as any,
    offset: args.offset as number | undefined,
    pinned: args.pinned as boolean | undefined,
    mentions: args.mentions as string | undefined,
    limit,
    scanLimit: Math.min(Math.max(Number(args.scan_limit) || 100, limit), 500),
    beforeMessageId: args.before_message_id as string | undefined,
  }, context.scope);
  result.citations = (result.data?.messages || []).map((message) => context.addCitation(message));
  return result;
}, () => true, 30_000);

const surroundingMessages = registered('fetch_surrounding_messages', 'discord', async (args, context) => {
  const channelId = String(args.channel_id || context.scope.channelId);
  if (!context.scope.channelId || !channelId) return { ok: false, code: 'invalid_scope', summary: 'No active channel is available.' };
  if (!isChannelAllowedInScope(channelId, context.scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested channel is outside the permitted scope.' };
  }
  const messages = await fetchSurroundingMessages(channelId, String(args.message_id), Math.min(Number(args.limit) || 10, 25));
  const result = ok(messages.length ? 'surrounding_messages' : 'empty_results', `Retrieved ${messages.length} surrounding message${messages.length === 1 ? '' : 's'}.`, { messages });
  result.citations = messages.map((message) => context.addCitation(message));
  result.scope = { channelIds: [channelId], guildId: context.scope.guildId };
  result.truncation = { truncated: false, returned: messages.length };
  return result;
});

const recentMessages = registered('fetch_recent_messages', 'discord', async (args, context) => {
  const channelId = String(args.channel_id || context.scope.channelId);
  if (!isChannelAllowedInScope(channelId, context.scope)) {
    return { ok: false, code: 'scope_denied', summary: 'The requested channel is outside the permitted scope.' };
  }
  const messages = await fetchRecentMessages(channelId, Math.min(Number(args.limit) || 25, 100));
  const result = ok(messages.length ? 'recent_messages' : 'empty_results', `Retrieved ${messages.length} recent message${messages.length === 1 ? '' : 's'}.`, { messages });
  result.citations = messages.map((message) => context.addCitation(message));
  result.scope = { channelIds: [channelId], guildId: context.scope.guildId };
  result.pagination = { nextBeforeMessageId: messages.length === Math.min(Number(args.limit) || 25, 100) ? messages[0]?.id : undefined };
  result.truncation = { truncated: Boolean(result.pagination.nextBeforeMessageId), returned: messages.length };
  return result;
});

const inspectImage = registered('inspect_image', 'discord', async (args, context) => {
  if (!context.settings.enableVision) return { ok: false, code: 'vision_disabled', summary: 'Vision is disabled in plugin settings.' };
  const url = String(args.image_url);
  if (!/^https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\//i.test(url)) {
    return { ok: false, code: 'untrusted_image_url', summary: 'Only Discord CDN attachment URLs can be inspected.' };
  }
  const analysis = await context.analyzeImage(url, String(args.question || 'Describe this image'), context.signal);
  const result = ok('image_analysis', 'Inspected one Discord attachment. Image text remained untrusted data.', { analysis });
  result.scope = { channelIds: [context.scope.channelId], guildId: context.scope.guildId };
  result.truncation = { truncated: false, returned: 1 };
  return result;
}, (_, settings) => settings.enableVision, 30_000);

const messageDetails = registered('get_message_details', 'discord', async (args, context) => {
  const result = await getMessageDetails(context.scope, String(args.channel_id), String(args.message_id), Math.min(Math.max(Number(args.reply_depth) || 3, 0), 5));
  if (result.data) result.citations = [result.data.message, ...result.data.replyChain].map((message) => context.addCitation(message));
  return result;
});

const channelPins = registered('list_channel_pins', 'discord', async (args, context) => {
  const result = await listChannelPins(context.scope, String(args.channel_id || context.scope.channelId), Math.min(Math.max(Number(args.limit) || 25, 1), 50), args.before as string | undefined);
  if (result.data) result.citations = result.data.messages.map((message) => context.addCitation(message));
  return result;
});

const threads = registered('list_threads', 'discord', async (args, context) => {
  const result = await listThreads(
    context.scope,
    args.channel_id as string | undefined,
    Math.min(Math.max(Number(args.limit) || 25, 1), 50),
    Boolean(args.include_archived),
  );
  result.citations = result.data?.threads.flatMap((item) =>
    item.starterMessage ? [context.addCitation(item.starterMessage)] : [],
  );
  return result;
}, (scope) => scope.isGuild);

export const TOOL_REGISTRY = new Map<string, AnyTool>([
  getCurrentContext,
  listAvailableChannels,
  searchMessages,
  surroundingMessages,
  recentMessages,
  inspectImage,
  messageDetails,
  channelPins,
  threads,
].map((tool) => [tool.definition.function.name, tool]));

export function availableToolDefinitions(context: ToolExecutionContext): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values())
    .filter((tool) => tool.isAvailable(context.scope, context.settings))
    .map((tool) => tool.definition);
}
