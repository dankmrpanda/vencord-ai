/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchOneMessage, getMessageDetails, listChannelPins, listThreads } from '../discord/contextTools';
import { extractMessageSearchText, fetchRecentMessages, fetchSurroundingMessages } from '../discord/messages';
import { DEFAULT_CONTEXT_MESSAGES, fetchSearchContext, MAX_CONTEXT_MESSAGES, slimMessage } from '../discord/searchContext';
import { runMessageSearch } from '../discord/searchPipeline';
import { isChannelAllowedInScope } from '../discord/scope';
import { getVoiceTranscriber, transcribeVoiceMessage } from '../discord/voiceMessages';
import { getCurrentUser, searchMentionableUsers } from '../discord/stores';
import { compileSafeRegex } from '../storage/regex';
import {
  CurrentScopeContext,
  DiscordMessage,
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

/** A whole number in [min, max]; missing, zero or non-numeric values use the fallback. */
function intArg(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number(value)) || fallback, min), max);
}

function ok<T>(code: string, summary: string, data: T): ToolExecutionResult<T> {
  return { ok: true, code, summary, data };
}

const SNOWFLAKE_RE = /^\d{1,22}$/;
const DISCORD_IMAGE_CDN_RE = /^https:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\//i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/i;

function resolveChannelArg(raw: unknown, scope: CurrentScopeContext): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (SNOWFLAKE_RE.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/^#/, '').toLowerCase();
  if (!normalized) return trimmed;

  const candidates: Array<{ id: string; name: string }> = [];
  if (scope.channelName.replace(/^[@#]/, '').toLowerCase() === normalized) {
    candidates.push({ id: scope.channelId, name: scope.channelName });
  }
  if (scope.isGuild) {
    for (const ch of scope.accessibleGuildChannels || []) {
      if (ch.name.replace(/^#/, '').toLowerCase() === normalized && isChannelAllowedInScope(ch.id, scope)) {
        candidates.push({ id: ch.id, name: ch.name });
      }
    }
  } else if (scope.isDM) {
    for (const gd of scope.mutualGroupDMs || []) {
      if (gd.name.toLowerCase() === normalized && isChannelAllowedInScope(gd.id, scope)) {
        candidates.push({ id: gd.id, name: gd.name });
      }
    }
  }
  const uniqueIds = new Set(candidates.map((c) => c.id));
  if (uniqueIds.size === 1) return candidates[0].id;
  return trimmed;
}

function resolveUserArg(raw: unknown, scope: CurrentScopeContext): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (SNOWFLAKE_RE.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/^@/, '').toLowerCase();
  if (!normalized) return trimmed;

  const pool = new Map<string, { id: string; username: string; globalName?: string | null }>();
  const current = scope.currentUser || getCurrentUser();
  if (current?.id) pool.set(current.id, current);
  if (scope.otherUser?.id) pool.set(scope.otherUser.id, scope.otherUser);
  for (const r of scope.groupDMRecipients || []) {
    if (r?.id) pool.set(r.id, r);
  }
  for (const u of searchMentionableUsers(normalized, scope, scope.guildId)) {
    if (u?.id) pool.set(u.id, u);
  }

  const exactMatches = Array.from(pool.values()).filter(
    (u) => u.username.toLowerCase() === normalized || u.globalName?.toLowerCase() === normalized,
  );
  if (exactMatches.length === 1) return exactMatches[0].id;
  if (exactMatches.length === 0) {
    const prefixMatches = Array.from(pool.values()).filter(
      (u) => u.username.toLowerCase().startsWith(normalized) || u.globalName?.toLowerCase().startsWith(normalized),
    );
    if (prefixMatches.length === 1) return prefixMatches[0].id;
  }
  return trimmed;
}

function scopeDeniedSummary(scope: CurrentScopeContext): string {
  if (scope.isGuild && scope.scopeMode === 'channel') {
    return 'The requested channel is outside the permitted scope (currently limited to this channel only). Search this channel or tell the user they can switch the scope selector to "Entire server" or "Choose channels".';
  }
  return 'The requested channel is outside the permitted scope.';
}

function extractMessageImageUrls(message: DiscordMessage): string[] {
  const urls: string[] = [];
  for (const a of message.attachments || []) {
    if (!a?.url || !DISCORD_IMAGE_CDN_RE.test(a.url)) continue;
    const isImage = Boolean(a.content_type?.startsWith('image/')) || IMAGE_EXT_RE.test(a.filename || a.url);
    if (isImage) urls.push(a.url);
  }
  for (const e of message.embeds || []) {
    const candidate = e?.image?.proxy_url || e?.image?.url || e?.thumbnail?.proxy_url || e?.thumbnail?.url;
    if (candidate && DISCORD_IMAGE_CDN_RE.test(candidate)) urls.push(candidate);
  }
  return Array.from(new Set(urls));
}

const getCurrentContext = registered('get_current_context', 'local', async (_, context) => {
  const scope = context.scope;
  const currentUser = scope.currentUser || getCurrentUser();
  const result = ok('current_context', 'Retrieved the active read-only Discord scope.', {
    channelId: scope.channelId,
    channelName: scope.channelName,
    channelType: scope.channelType,
    ...(scope.channelTopic ? { channelTopic: scope.channelTopic } : {}),
    ...(scope.parentChannelId ? { parentChannelId: scope.parentChannelId, parentChannelName: scope.parentChannelName } : {}),
    ...(scope.threadMetadata ? { threadMetadata: scope.threadMetadata } : {}),
    ...(scope.forumAvailableTags?.length ? { forumAvailableTags: scope.forumAvailableTags } : {}),
    ...(scope.groupDMRecipients?.length ? { groupDMRecipients: scope.groupDMRecipients } : {}),
    guildId: scope.guildId,
    guildName: scope.guildName,
    isDM: scope.isDM,
    isGroupDM: scope.isGroupDM,
    scopeMode: scope.scopeMode || 'channel',
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
  const limit = intArg(args.limit, context.settings.searchLimitPerQuery || 25, 1, 50);
  const resolvedChannelId = resolveChannelArg(args.channel_id, context.scope);
  const resolvedAuthorId = resolveUserArg(args.author_id, context.scope);
  const resolvedMentions = resolveUserArg(args.mentions, context.scope);

  const result = await runMessageSearch({
    query: args.query as string | undefined,
    pattern: args.pattern as string | undefined,
    channelId: resolvedChannelId,
    guildWide: args.guild_wide as boolean | undefined,
    authorId: resolvedAuthorId,
    has: args.has as any,
    date: args.date as string | undefined,
    afterDate: args.after_date as string | undefined,
    beforeDate: args.before_date as string | undefined,
    sortBy: args.sort_by as any,
    sortOrder: args.sort_order as any,
    offset: args.offset === undefined ? undefined : Math.max(0, Math.floor(Number(args.offset) || 0)),
    pinned: args.pinned as boolean | undefined,
    mentions: resolvedMentions,
    limit,
    scanLimit: intArg(args.scan_limit, 100, limit, 500),
    beforeMessageId: args.before_message_id as string | undefined,
  }, context.scope, context.signal);
  if (!result.ok && result.code === 'scope_denied') {
    result.summary = scopeDeniedSummary(context.scope);
  }
  result.citations = (result.data?.messages || []).map((message) => context.addCitation(message));

  const embeddedMap = result.data?.embeddedContext
    ? new Map(Object.entries(result.data.embeddedContext))
    : undefined;
  if (result.data && 'embeddedContext' in result.data) {
    delete result.data.embeddedContext;
  }

  // The conversation around the top hits, so a hit like "same" or "trust" can be read as a reply to something.
  const perSide = args.context_messages === undefined
    ? DEFAULT_CONTEXT_MESSAGES
    : Math.min(Math.max(Math.floor(Number(args.context_messages) || 0), 0), MAX_CONTEXT_MESSAGES);
  if (result.ok && result.data?.messages.length && perSide > 0) {
    const { context: windows, skipped } = await fetchSearchContext(result.data.messages, context.scope, {
      perSide,
      signal: context.signal,
      embeddedContext: embeddedMap,
    });
    if (windows.length) {
      (result.data as any).context = windows;
      result.summary = `${result.summary} Included the surrounding conversation for ${windows.length} hit${windows.length === 1 ? '' : 's'} in data.context.`;
    }
    if (skipped) result.summary = `${result.summary} Context for ${skipped} hit${skipped === 1 ? '' : 's'} could not be fetched.`;
  }
  // The model sees compact hits (citations above were built from the full messages): raw Discord objects are mostly
  // profile metadata, and at ~1.5 KB each they crowded the hits themselves out of the input budget.
  if (result.data) (result.data as any).messages = result.data.messages.map((message) => slimMessage(message, 'hit', context.scope));
  return result;
}, () => true, 30_000);

const surroundingMessages = registered('fetch_surrounding_messages', 'discord', async (args, context) => {
  const channelId = resolveChannelArg(args.channel_id, context.scope) || context.scope.channelId;
  if (!context.scope.channelId || !channelId) return { ok: false, code: 'invalid_scope', summary: 'No active channel is available.' };
  if (!isChannelAllowedInScope(channelId, context.scope)) {
    return { ok: false, code: 'scope_denied', summary: scopeDeniedSummary(context.scope) };
  }
  const targetId = String(args.message_id);
  const messages = await fetchSurroundingMessages(channelId, targetId, intArg(args.limit, 10, 1, 25), context.signal);
  const citations = messages.map((message) => context.addCitation(message));
  const slimmed = messages.map((message) => {
    const slim = slimMessage(message, 'hit', context.scope);
    if (message.id === targetId) slim.is_target = true;
    return slim;
  });
  const result = ok(
    slimmed.length ? 'surrounding_messages' : 'empty_results',
    `Retrieved ${slimmed.length} surrounding message${slimmed.length === 1 ? '' : 's'}.`,
    { messages: slimmed },
  );
  result.citations = citations;
  result.scope = { channelIds: [channelId], guildId: context.scope.guildId };
  result.truncation = { truncated: false, returned: slimmed.length };
  return result;
});

const recentMessages = registered('fetch_recent_messages', 'discord', async (args, context) => {
  const channelId = resolveChannelArg(args.channel_id, context.scope) || context.scope.channelId;
  if (!isChannelAllowedInScope(channelId, context.scope)) {
    return { ok: false, code: 'scope_denied', summary: scopeDeniedSummary(context.scope) };
  }
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : undefined;
  const compiled = pattern ? compileSafeRegex(pattern) : undefined;
  if (compiled && !compiled.regex) {
    return { ok: false, code: 'invalid_pattern', summary: `The pattern was rejected: ${compiled.error || 'invalid regular expression'}.` };
  }
  const limit = intArg(args.limit, 25, 1, 100);
  const beforeMessageId = args.before_message_id as string | undefined;
  const afterMessageId = args.after_message_id as string | undefined;
  const fetched = await fetchRecentMessages(channelId, limit, beforeMessageId, context.signal, afterMessageId);
  const regex = compiled?.regex;
  const matched = regex
    ? fetched.filter((message) => {
      const text = extractMessageSearchText(message);
      regex.lastIndex = 0;
      return regex.test(text);
    })
    : fetched;
  const citations = matched.map((message) => context.addCitation(message));
  const slimmed = matched.map((message) => slimMessage(message, 'hit', context.scope));
  const label = regex ? ` matching the pattern (of ${fetched.length} scanned)` : '';
  const result = ok(
    slimmed.length ? 'recent_messages' : 'empty_results',
    `Retrieved ${slimmed.length} recent message${slimmed.length === 1 ? '' : 's'}${label}.`,
    { messages: slimmed },
  );
  result.citations = citations;
  result.scope = { channelIds: [channelId], guildId: context.scope.guildId };
  const hasMore = fetched.length === limit;
  result.pagination = {
    nextBeforeMessageId: hasMore ? fetched[0]?.id : undefined,
    nextAfterMessageId: hasMore ? fetched[fetched.length - 1]?.id : undefined,
  };
  result.truncation = { truncated: hasMore, returned: slimmed.length };
  return result;
});

const inspectImage = registered('inspect_image', 'discord', async (args, context) => {
  if (!context.settings.enableVision) return { ok: false, code: 'vision_disabled', summary: 'Vision is disabled in plugin settings.' };

  let url = typeof args.image_url === 'string' ? args.image_url.trim() : '';
  let sourceMessage: DiscordMessage | undefined;

  if (typeof args.message_id === 'string' && args.message_id.trim()) {
    const channelId = resolveChannelArg(args.channel_id, context.scope) || context.scope.channelId;
    if (!isChannelAllowedInScope(channelId, context.scope)) {
      return { ok: false, code: 'scope_denied', summary: scopeDeniedSummary(context.scope) };
    }
    sourceMessage = await fetchOneMessage(channelId, args.message_id.trim(), context.signal);
    if (!sourceMessage) {
      return { ok: false, code: 'not_found', summary: 'The target message was not found, or this account cannot read it.' };
    }
    if (sourceMessage.channel_id !== channelId) {
      return { ok: false, code: 'scope_denied', summary: 'The returned message does not belong to the requested channel.' };
    }
    const imageUrls = extractMessageImageUrls(sourceMessage);
    if (!imageUrls.length) {
      return { ok: false, code: 'no_image', summary: 'That message does not contain an inspectable Discord image attachment or embed.' };
    }
    const idx = Math.min(Math.max(Math.floor(Number(args.attachment_index) || 0), 0), imageUrls.length - 1);
    url = imageUrls[idx];
  } else if (!url) {
    return {
      ok: false,
      code: 'invalid_arguments',
      summary: 'Provide either channel_id + message_id of an image message, or a Discord CDN image_url.',
    };
  }

  if (!DISCORD_IMAGE_CDN_RE.test(url)) {
    return { ok: false, code: 'untrusted_image_url', summary: 'Only Discord CDN attachment URLs can be inspected.' };
  }
  const analysis = await context.analyzeImage(url, String(args.question || 'Describe this image and transcribe any visible text.'), context.signal);
  const result = ok('image_analysis', 'Inspected one Discord image. Image text remained untrusted data.', {
    analysis,
    ...(sourceMessage ? { message_id: sourceMessage.id, channel_id: sourceMessage.channel_id } : {}),
  });
  if (sourceMessage) result.citations = [context.addCitation(sourceMessage)];
  result.scope = { channelIds: [sourceMessage?.channel_id || context.scope.channelId], guildId: context.scope.guildId };
  result.truncation = { truncated: false, returned: 1 };
  return result;
  // LLM-13 (b): image support depends on the model, not the preset, so the Vision setting decides for every preset.
}, (_, settings) => Boolean(settings.enableVision), 30_000);

const messageDetails = registered('get_message_details', 'discord', async (args, context) => {
  const channelId = resolveChannelArg(args.channel_id, context.scope) || String(args.channel_id);
  const result = await getMessageDetails(context.scope, channelId, String(args.message_id), intArg(args.reply_depth ?? 3, 0, 0, 5), context.signal);
  if (!result.ok && result.code === 'scope_denied') {
    result.summary = scopeDeniedSummary(context.scope);
  }
  if (result.data) {
    result.citations = [result.data.message, ...result.data.replyChain].map((message) => context.addCitation(message));
    (result as any).data = {
      message: slimMessage(result.data.message, 'detail', context.scope),
      replyChain: result.data.replyChain.map((message) => slimMessage(message, 'detail', context.scope)),
    };
  }
  return result;
});

const channelPins = registered('list_channel_pins', 'discord', async (args, context) => {
  const channelId = resolveChannelArg(args.channel_id, context.scope) || context.scope.channelId;
  const result = await listChannelPins(context.scope, channelId, intArg(args.limit, 25, 1, 50), args.before as string | undefined, context.signal);
  if (!result.ok && result.code === 'scope_denied') {
    result.summary = scopeDeniedSummary(context.scope);
  }
  if (result.data) {
    result.citations = result.data.messages.map((message) => context.addCitation(message));
    (result as any).data = {
      messages: result.data.messages.map((message) => slimMessage(message, 'hit', context.scope)),
    };
  }
  return result;
});

const threads = registered('list_threads', 'discord', async (args, context) => {
  const channelId = args.channel_id !== undefined ? resolveChannelArg(args.channel_id, context.scope) : undefined;
  const result = await listThreads(
    context.scope,
    channelId,
    intArg(args.limit, 25, 1, 50),
    Boolean(args.include_archived),
    context.signal,
  );
  if (!result.ok && result.code === 'scope_denied') {
    result.summary = scopeDeniedSummary(context.scope);
  }
  result.citations = result.data?.threads.flatMap((item) =>
    item.starterMessage ? [context.addCitation(item.starterMessage)] : [],
  );
  if (result.data?.threads) {
    (result as any).data = {
      threads: result.data.threads.map((item) => {
        const tagMap = new Map<string, string>();
        for (const tag of item.parent?.available_tags || []) {
          if (tag?.id && tag?.name) tagMap.set(tag.id, tag.name);
        }
        const appliedTags = (item.thread.applied_tags || [])
          .map((id) => tagMap.get(id))
          .filter((name): name is string => Boolean(name));
        return {
          id: item.thread.id,
          name: item.thread.name || 'thread',
          parent_id: item.thread.parent_id || item.parent?.id,
          ...(item.parent?.name ? { parent_name: item.parent.name } : {}),
          archived: Boolean(item.thread.thread_metadata?.archived),
          locked: Boolean(item.thread.thread_metadata?.locked),
          ...(item.thread.message_count !== undefined ? { message_count: item.thread.message_count } : {}),
          ...(item.thread.last_message_id ? { last_message_id: item.thread.last_message_id } : {}),
          ...(appliedTags.length ? { applied_tags: appliedTags } : {}),
          ...(item.starterMessage ? { starter: slimMessage(item.starterMessage, 'hit', context.scope) } : {}),
        };
      }),
    };
  }
  return result;
}, (scope) => scope.isGuild);

// Offered only when the user's VoiceTranscribe plugin is enabled; the first note can take a while as its models load.
const voiceTranscript = registered('transcribe_voice_message', 'discord', async (args, context) => {
  const channelId = resolveChannelArg(args.channel_id, context.scope) || String(args.channel_id);
  const result = await transcribeVoiceMessage(context.scope, channelId, String(args.message_id), {
    translate: Boolean(args.translate),
    language: typeof args.language === 'string' ? args.language : '',
    signal: context.signal,
  });
  if (result.data) {
    result.citations = [context.addCitation(result.data.message)];
    (result as any).data = {
      ...result.data,
      message: slimMessage(result.data.message, 'hit', context.scope),
    };
  }
  return result;
}, () => getVoiceTranscriber() !== null, 150_000);

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
  voiceTranscript,
].map((tool) => [tool.definition.function.name, tool]));

export function availableToolDefinitions(context: ToolExecutionContext): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values())
    .filter((tool) => tool.isAvailable(context.scope, context.settings))
    .map((tool) => tool.definition);
}
