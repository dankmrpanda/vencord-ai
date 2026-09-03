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
  PERMITTED_TEXT_CHANNEL_TYPES,
  validateChannelPermission,
  validateScopeBoundary,
} from './guardrails';
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
 * Finds all mutual Group DMs shared between current user and target user
 */
export function getMutualGroupDMs(otherUserId: string): DiscordChannel[] {
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
 * Re-exported fail-closed permission check delegating to guardrails.
 */
export const canReadChannel = (permissionStore: any, channel: DiscordChannel): boolean =>
  validateChannelPermission(channel, permissionStore);

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
        return canReadChannel(permStore, ch);
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
      return context.accessibleGuildChannels.map((c) => c.id);
    }
    return [context.channelId];
  }
  if (context.isDM) {
    if (context.includeMutualGroupDMs && context.mutualGroupDMs) {
      return [context.channelId, ...context.mutualGroupDMs.map((g) => g.id)];
    }
    const explicitGroupDMs = context.explicitMutualGroupDMIds || [];
    return [context.channelId, ...explicitGroupDMs];
  }
  return [context.channelId];
}

/**
 * Pre-filters an IndexSearchQuery so unpermitted channels are never searched.
 */
export function filterIndexQueryToScope<T extends { channelIds?: string[]; guildId?: string; [key: string]: any }>(
  query: T,
  context: CurrentScopeContext,
): T {
  const permittedChannelIds = getPermittedChannelIdsForScope(context);
  const permittedSet = new Set(permittedChannelIds);

  let scopedChannelIds: string[];
  if (query.channelIds && query.channelIds.length > 0) {
    scopedChannelIds = query.channelIds.filter((id) => permittedSet.has(id));
    if (scopedChannelIds.length === 0) {
      // Requested channel was explicitly unpermitted -> fail-closed with empty sentinel
      scopedChannelIds = ['__FORBIDDEN_SCOPE_BLOCKED__'];
    }
  } else {
    scopedChannelIds = permittedChannelIds;
  }

  return {
    ...query,
    channelIds: scopedChannelIds,
    guildId: context.isGuild ? context.guildId : undefined,
  };
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

  const currentUser = getCurrentUser() ?? undefined;

  return {
    channelId,
    channelName,
    channelType: channel.type,
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
  const normalizedPrompt = normalizedLabel(userPrompt);
  const explicitlyRequested = context.mutualGroupDMs.filter((group) => {
    if (launchTargetChannelId === group.id || userPrompt.includes(group.id)) return true;
    const groupName = normalizedLabel(group.name);
    return groupName.length >= 3 && normalizedPrompt.includes(groupName);
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
