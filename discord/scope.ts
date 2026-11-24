/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  ChannelType,
  CurrentScopeContext,
  DiscordChannel,
  DiscordUser,
} from '../types';
import {
  getChannel,
  getChannelStore,
  getCurrentChannelId,
  getCurrentUser,
  getGuild,
  getPermissionStore,
  getUserStore,
} from './stores';

/**
 * Discord Permissions Bitfield: VIEW_CHANNEL (1 << 10 = 1024n)
 */
export const VIEW_CHANNEL_PERMISSION = 1024n;
const VIEW_CHANNEL_PERMISSION_NUM = 1024;

/**
 * Set of channel types that are valid readable text channels.
 */
export const PERMITTED_TEXT_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GUILD_TEXT,
  ChannelType.GUILD_ANNOUNCEMENT,
  ChannelType.ANNOUNCEMENT_THREAD,
  ChannelType.PUBLIC_THREAD,
  ChannelType.PRIVATE_THREAD,
  ChannelType.GUILD_FORUM,
  ChannelType.GUILD_MEDIA,
  ChannelType.DM,
  ChannelType.GROUP_DM,
]);

export function isThreadChannel(
  channelOrType: Pick<DiscordChannel, 'type' | 'isThread'> | ChannelType | null | undefined,
): boolean {
  if (channelOrType === null || channelOrType === undefined) return false;
  if (typeof channelOrType === 'number') {
    return (
      channelOrType === ChannelType.PUBLIC_THREAD ||
      channelOrType === ChannelType.PRIVATE_THREAD ||
      channelOrType === ChannelType.ANNOUNCEMENT_THREAD
    );
  }
  return (
    Boolean(channelOrType.isThread?.()) ||
    channelOrType.type === ChannelType.PUBLIC_THREAD ||
    channelOrType.type === ChannelType.PRIVATE_THREAD ||
    channelOrType.type === ChannelType.ANNOUNCEMENT_THREAD
  );
}

/**
 * Result of a scope boundary validation check.
 */
export interface ScopeValidationResult {
  allowed: boolean;
  reason?:
    | 'active_channel'
    | 'accessible_guild_channel'
    | 'explicit_mutual_group_dm'
    | 'active_group_dm'
    | 'unpermitted_channel'
    | 'external_guild'
    | 'dm_boundary_isolation'
    | 'invalid_channel_type'
    | 'missing_context';
}

/**
 * Validates channel view permission fail-closed.
 * Returns true ONLY if permissionStore explicitly confirms 1024n VIEW_CHANNEL permission: `can()` must
 * return literal `true`; any other value (a Promise, object, string or number) is treated as denied.
 */
export function validateChannelPermission(
  channel: DiscordChannel,
  permissionStore: any = getPermissionStore(),
): boolean {
  if (!channel || !channel.id) return false;

  // DMs and Group DMs don't use Guild PermissionStore
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM) {
    return true;
  }

  // Must be a permitted text channel type (rejects voice, stage, category, directory, and unknown types fail-closed)
  if (!PERMITTED_TEXT_CHANNEL_TYPES.has(channel.type)) {
    return false;
  }

  // Permission store discovery must fail closed
  if (!permissionStore || typeof permissionStore.can !== 'function') {
    return false;
  }

  try {
    const bigintResult = permissionStore.can(VIEW_CHANNEL_PERMISSION, channel);
    if (bigintResult !== undefined && bigintResult !== null) {
      return bigintResult === true;
    }
  } catch {}

  try {
    const numResult = permissionStore.can(VIEW_CHANNEL_PERMISSION_NUM, channel);
    return numResult === true;
  } catch {
    return false;
  }
}

/**
 * Validates whether a target channel ID is allowed in the current scope context.
 */
export function validateScopeBoundary(
  targetChannelId: string,
  context?: CurrentScopeContext | null,
): ScopeValidationResult {
  if (!context || !targetChannelId) {
    return { allowed: false, reason: 'missing_context' };
  }

  // 1. Active channel is always permitted
  if (targetChannelId === context.channelId) {
    return { allowed: true, reason: 'active_channel' };
  }

  // 2. Guild scope: channel must belong to current guild and be in accessibleGuildChannels
  if (context.isGuild && context.guildId) {
    if (context.scopeMode === 'channel') {
      return { allowed: false, reason: 'unpermitted_channel' };
    }
    if (context.scopeMode === 'custom') {
      const isSelected = context.selectedChannelIds?.includes(targetChannelId);
      const isAccessible = context.accessibleGuildChannels?.some((c) => c.id === targetChannelId);
      if (isSelected && isAccessible) {
        return { allowed: true, reason: 'accessible_guild_channel' };
      }
      return { allowed: false, reason: 'unpermitted_channel' };
    }
    const isAccessible = context.accessibleGuildChannels?.some((c) => c.id === targetChannelId);
    if (isAccessible) {
      return { allowed: true, reason: 'accessible_guild_channel' };
    }
    return { allowed: false, reason: 'unpermitted_channel' };
  }

  // 3. 1-on-1 DM scope: only explicitly requested mutual group DMs or enabled mutual group DMs are allowed
  if (context.isDM) {
    const isAllowedMutual = Boolean(
      (context.includeMutualGroupDMs || context.explicitMutualGroupDMIds?.includes(targetChannelId)) &&
      context.mutualGroupDMs?.some((g) => g.id === targetChannelId)
    );
    if (isAllowedMutual) {
      return { allowed: true, reason: 'explicit_mutual_group_dm' };
    }
    return { allowed: false, reason: 'dm_boundary_isolation' };
  }

  // 4. Group DM scope: only the active group DM is allowed
  if (context.isGroupDM) {
    return { allowed: false, reason: 'dm_boundary_isolation' };
  }

  return { allowed: false, reason: 'unpermitted_channel' };
}

/**
 * Finds all mutual Group DMs shared between current user and target user
 */
function getMutualGroupDMs(otherUserId: string): DiscordChannel[] {
  const current = getCurrentUser();
  if (!current || !otherUserId) return [];

  try {
    const channelStore = getChannelStore();
    if (!channelStore) return [];

    const raw =
      channelStore.getMutablePrivateChannels?.() ||
      channelStore.getPrivateChannels?.() ||
      channelStore.getChannels?.() ||
      [];
    const privateChannels: DiscordChannel[] = Array.isArray(raw) ? raw : Object.values(raw);

    return privateChannels.filter((ch) => {
      return ch.type === ChannelType.GROUP_DM && (ch.recipients ?? []).includes(otherUserId);
    });
  } catch (err) {
    console.error('[VencordAI] Error finding mutual group DMs:', err);
    return [];
  }
}

/**
 * Gets accessible text channels for a guild
 */
export function getAccessibleGuildChannels(guildId: string): DiscordChannel[] {
  if (!guildId) return [];

  try {
    const channelStore = getChannelStore();
    const permStore = getPermissionStore();
    if (!channelStore || typeof permStore?.can !== 'function') return [];

    const rawChannels = channelStore.getChannels(guildId);
    if (!rawChannels) return [];

    const rawList = Array.isArray(rawChannels) ? rawChannels : Object.values(rawChannels);
    const flattened: any[] = rawList.flat(2);

    return flattened
      .map((entry) => entry?.channel ?? entry)
      .filter((ch: DiscordChannel): ch is DiscordChannel => {
        if (!ch?.id || !PERMITTED_TEXT_CHANNEL_TYPES.has(ch.type)) return false;
        return validateChannelPermission(ch, permStore);
      });
  } catch (err) {
    console.error(`[VencordAI] Error getting channels for guild ${guildId}:`, err);
    return [];
  }
}

/**
 * Post-filters any collection of items with a `channel_id` property against the active scope.
 */
export function filterMessagesToScope<T extends { channel_id: string }>(
  messages: T[],
  context: CurrentScopeContext,
): T[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => isChannelAllowedInScope(message.channel_id, context));
}

/**
 * Returns an array of permitted channel IDs for the active scope context.
 */
export function getPermittedChannelIdsForScope(context: CurrentScopeContext): string[] {
  if (!context) return [];
  if (context.isGuild) {
    if (context.scopeMode === 'channel') {
      return [context.channelId];
    }
    if (context.scopeMode === 'custom' && context.selectedChannelIds) {
      const accessibleSet = new Set((context.accessibleGuildChannels || []).map((c) => c.id));
      const valid = context.selectedChannelIds.filter((id) => accessibleSet.has(id));
      return Array.from(new Set([context.channelId, ...valid]));
    }
    if (context.accessibleGuildChannels) {
      // The active channel is always allowed by validateScopeBoundary, so it belongs in the allowlist too.
      return Array.from(new Set([context.channelId, ...context.accessibleGuildChannels.map((c) => c.id)].filter(Boolean)));
    }
    return [context.channelId];
  }
  if (context.isDM) {
    const mutualIds = new Set((context.mutualGroupDMs || []).map((g) => g.id));
    if (context.includeMutualGroupDMs) {
      return [context.channelId, ...Array.from(mutualIds)];
    }
    const explicitGroupDMs = (context.explicitMutualGroupDMIds || []).filter((id) => mutualIds.has(id));
    return [context.channelId, ...explicitGroupDMs];
  }
  return [context.channelId];
}

/**
 * Resolves the full current context and allowed scope boundaries
 */
export function getCurrentScopeContext(): CurrentScopeContext | null {
  const channelId = getCurrentChannelId();
  if (!channelId) return null;

  const channel = getChannel(channelId);
  if (!channel) return null;

  const isDM = channel.type === ChannelType.DM;
  const isGroupDM = channel.type === ChannelType.GROUP_DM;
  const isGuild = Boolean(channel.guild_id);

  let otherUser: DiscordUser | undefined;
  let mutualGroupDMs: { id: string; name: string; recipientNames: string[] }[] = [];
  let accessibleGuildChannels: { id: string; name: string; topic?: string }[] = [];

  const userStore = getUserStore();

  if (isDM && channel.recipients && channel.recipients.length > 0) {
    const otherId = channel.recipients[0];
    otherUser = userStore?.getUser?.(otherId) ?? { id: otherId, username: 'User' };

    const gdms = getMutualGroupDMs(otherId);
    mutualGroupDMs = gdms.map((gdm) => {
      const recipientNames = (gdm.recipients ?? []).map((rId) => {
        const u = userStore?.getUser?.(rId);
        return u?.globalName || u?.username || rId;
      });
      return {
        id: gdm.id,
        name: gdm.name || `Group (${recipientNames.join(', ')})`,
        recipientNames,
      };
    });
  }

  let guildName: string | undefined;
  if (isGuild && channel.guild_id) {
    const guild = getGuild(channel.guild_id);
    guildName = guild?.name;
    const channels = getAccessibleGuildChannels(channel.guild_id);
    accessibleGuildChannels = channels.map((c) => ({
      id: c.id,
      name: c.name || `channel-${c.id}`,
      topic: c.topic,
    }));
  }

  let channelName = channel.name || 'channel';
  if (isDM && otherUser) {
    channelName = `@${otherUser.globalName || otherUser.username}`;
  } else if (isGroupDM) {
    channelName = channel.name || 'Group DM';
  }

  let groupDMRecipients: Array<{ id: string; username: string; globalName?: string | null }> | undefined;
  if (isGroupDM) {
    const recipientMap = new Map<string, { id: string; username: string; globalName?: string | null }>();
    if (Array.isArray(channel.rawRecipients)) {
      for (const r of channel.rawRecipients) {
        if (r?.id) {
          recipientMap.set(r.id, {
            id: r.id,
            username: r.username || `user_${String(r.id).slice(-4)}`,
            globalName: r.globalName ?? r.global_name ?? null,
          });
        }
      }
    }
    if (Array.isArray(channel.recipients)) {
      for (const rId of channel.recipients) {
        if (recipientMap.has(rId)) continue;
        const u = userStore?.getUser?.(rId);
        recipientMap.set(rId, {
          id: rId,
          username: u?.username || `user_${String(rId).slice(-4)}`,
          globalName: u?.globalName ?? (u as any)?.global_name ?? null,
        });
      }
    }
    if (recipientMap.size > 0) {
      groupDMRecipients = Array.from(recipientMap.values()).slice(0, 20);
    }
  }

  const parentChannelId = channel.parent_id || undefined;
  const parentChannel = parentChannelId ? getChannel(parentChannelId) : null;
  const parentChannelName = parentChannel?.name || undefined;
  const isThread = isThreadChannel(channel);

  let threadMetadata: CurrentScopeContext['threadMetadata'];
  if (isThread) {
    const tagById = new Map<string, string>();
    for (const tag of parentChannel?.available_tags || []) {
      if (tag?.id && tag?.name) tagById.set(tag.id, tag.name);
    }
    const appliedTagNames = (channel.applied_tags || [])
      .map((tagId) => tagById.get(tagId))
      .filter((name): name is string => Boolean(name));
    threadMetadata = {
      archived: channel.thread_metadata?.archived,
      locked: channel.thread_metadata?.locked,
      messageCount: channel.message_count ?? channel.total_message_sent,
      ...(appliedTagNames.length ? { appliedTagNames } : {}),
    };
  }

  const forumAvailableTags = Array.isArray(channel.available_tags) && channel.available_tags.length > 0
    ? channel.available_tags.map((t) => t?.name).filter((name): name is string => Boolean(name))
    : undefined;

  const currentUser = getCurrentUser() ?? undefined;

  return {
    channelId,
    channelName,
    channelType: channel.type,
    ...(channel.topic ? { channelTopic: channel.topic } : {}),
    ...(parentChannelId ? { parentChannelId } : {}),
    ...(parentChannelName ? { parentChannelName } : {}),
    ...(threadMetadata ? { threadMetadata } : {}),
    ...(forumAvailableTags?.length ? { forumAvailableTags } : {}),
    ...(groupDMRecipients ? { groupDMRecipients } : {}),
    isDM,
    isGroupDM,
    isGuild,
    guildId: channel.guild_id,
    guildName,
    currentUser,
    otherUser,
    mutualGroupDMs,
    explicitMutualGroupDMIds: [],
    accessibleGuildChannels,
    scopeMode: 'channel',
    selectedChannelIds: [channelId],
    includeMutualGroupDMs: false,
  };
}

function normalizedLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** True when `token` occurs in `text` without a letter, digit or underscore directly on either side. */
function containsWholeToken(text: string, token: string): boolean {
  if (!token) return false;
  for (let index = text.indexOf(token); index !== -1; index = text.indexOf(token, index + 1)) {
    const before = text[index - 1];
    const after = text[index + token.length];
    if ((!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after))) return true;
  }
  return false;
}

const CJK_CHARACTER = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

/** Letters, digits and underscore of scripts that separate words with spaces (everything except Han/kana). */
function isSpacedWordCharacter(char: string | undefined): boolean {
  return !!char && WORD_CHARACTER.test(char) && !CJK_CHARACTER.test(char);
}

const charBefore = (text: string, index: number) => Array.from(text.slice(Math.max(0, index - 2), index)).pop();
const charAt = (text: string, index: number) => Array.from(text.slice(index, index + 2))[0];

// [opener, closer, guarded]; a guarded quote doubles as an apostrophe, so it must not touch a spaced word character.
const QUOTE_PAIRS: Array<[string, string, boolean]> = [
  ['"', '"', false],
  ['\'', '\'', true],
  ['“', '”', false],
  ['‘', '’', true],
  ['«', '»', false],
  ['「', '」', false],
  ['『', '』', false],
];

/** Normalized contents of every quoted span in `text`, pairing each opener with the next valid closer. */
function quotedLabels(text: string): Set<string> {
  const labels = new Set<string>();
  for (const [opener, closer, guarded] of QUOTE_PAIRS) {
    let start = text.indexOf(opener);
    while (start !== -1) {
      if (guarded && isSpacedWordCharacter(charBefore(text, start))) {
        start = text.indexOf(opener, start + 1);
        continue;
      }
      let end = text.indexOf(closer, start + 1);
      while (guarded && end !== -1 && isSpacedWordCharacter(charAt(text, end + 1))) end = text.indexOf(closer, end + 1);
      if (end === -1) break;
      labels.add(normalizedLabel(text.slice(start + 1, end)));
      start = text.indexOf(opener, end + 1);
    }
  }
  return labels;
}

/** Normalized text after each "group", "group dm(s)", "group chat(s)" or "gc" keyword (longest wins) and whitespace. */
function textAfterGroupKeywords(text: string): string[] {
  const remainders: string[] = [];
  for (const match of text.matchAll(/group|gc/giu)) {
    const index = match.index ?? 0;
    if (isSpacedWordCharacter(charBefore(text, index))) continue;
    let end = index + match[0].length;
    const longer = match[0].length === 5 ? /^\s+(?:dms?|chats?)/iu.exec(text.slice(end)) : null;
    if (longer && !isSpacedWordCharacter(charAt(text, end + longer[0].length))) end += longer[0].length;
    // Only whitespace may separate keyword and name; punctuation ("group - chat", "group (the") breaks the link.
    const gap = /^\s+(?=[\p{L}\p{N}])/u.exec(text.slice(end));
    if (gap) remainders.push(normalizedLabel(text.slice(end + gap[0].length)));
  }
  return remainders;
}

/** True when `remainder` starts with `name` and the name does not run on into a word of a space-delimited script. */
function startsWithGroupName(remainder: string, name: string): boolean {
  if (!remainder.startsWith(name)) return false;
  return CJK_CHARACTER.test(Array.from(name).pop() || '') || !isSpacedWordCharacter(charAt(remainder, name.length));
}

export function restrictScopeForUserPrompt(
  context: CurrentScopeContext,
  userPrompt: string,
  launchTargetChannelId?: string,
): CurrentScopeContext {
  if (!context.isDM || !context.mutualGroupDMs?.length) return context;
  if (context.includeMutualGroupDMs) {
    return {
      ...context,
      explicitMutualGroupDMIds: context.mutualGroupDMs.map((group) => group.id),
    };
  }
  // A name counts only when quoted or directly after "group"/"gc"; after a keyword only the longest matching name counts.
  const quoted = quotedLabels(userPrompt);
  const names = context.mutualGroupDMs.map((group) => normalizedLabel(group.name)).filter((name) => name.length >= 3);
  const afterKeyword = new Set(textAfterGroupKeywords(userPrompt).map((remainder) => names
    .filter((name) => startsWithGroupName(remainder, name))
    .reduce((longest, name) => (name.length > longest.length ? name : longest), '')));
  const explicitlyRequested = context.mutualGroupDMs.filter((group) => {
    if (launchTargetChannelId === group.id || containsWholeToken(userPrompt, group.id)) return true;
    const groupName = normalizedLabel(group.name);
    return groupName.length >= 3 && (quoted.has(groupName) || afterKeyword.has(groupName));
  });
  return { ...context, mutualGroupDMs: explicitlyRequested, explicitMutualGroupDMIds: explicitlyRequested.map((group) => group.id) };
}

/**
 * Enforces security & privacy boundaries: returns true only if the channel is allowed to be queried
 */
export function isChannelAllowedInScope(
  targetChannelId: string,
  context: CurrentScopeContext,
): boolean {
  return validateScopeBoundary(targetChannelId, context).allowed;
}
