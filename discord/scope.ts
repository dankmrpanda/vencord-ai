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

const TEXT_CHANNEL_TYPES = new Set([
  ChannelType.GUILD_TEXT,
  ChannelType.GUILD_ANNOUNCEMENT,
  ChannelType.PUBLIC_THREAD,
  ChannelType.PRIVATE_THREAD,
  ChannelType.GUILD_FORUM,
]);

/**
 * Gets accessible text channels for a guild
 */
export function getAccessibleGuildChannels(guildId: string): DiscordChannel[] {
  if (!guildId) return [];

  try {
    const channelStore = getChannelStore();
    const permStore = getPermissionStore();
    if (!channelStore) return [];

    const rawChannels = channelStore.getChannels(guildId);
    if (!rawChannels) return [];

    const rawList = Array.isArray(rawChannels) ? rawChannels : Object.values(rawChannels);
    const flattened: any[] = rawList.flat(2);

    return flattened
      .map((entry) => entry?.channel ?? entry)
      .filter((ch: DiscordChannel): ch is DiscordChannel => {
        if (!ch?.id || !TEXT_CHANNEL_TYPES.has(ch.type)) return false;
        if (!permStore?.can) return true;
        try {
          return Boolean(permStore.can(1024n, ch));
        } catch {
          try {
            return Boolean(permStore.can(1024, ch));
          } catch {
            return true;
          }
        }
      });
  } catch (err) {
    console.error(`[VencordAI] Error getting channels for guild ${guildId}:`, err);
    return [];
  }
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
    accessibleGuildChannels,
  };
}

/**
 * Enforces security & privacy boundaries: returns true only if the channel is allowed to be queried
 */
export function isChannelAllowedInScope(
  targetChannelId: string,
  context: CurrentScopeContext
): boolean {
  if (targetChannelId === context.channelId) {
    return true;
  }

  if (context.isGuild && context.guildId) {
    // Must belong to the same guild and be in the accessible list
    return context.accessibleGuildChannels?.some((c) => c.id === targetChannelId) ?? false;
  }

  if (context.isDM) {
    // Must be a mutual group DM
    return context.mutualGroupDMs?.some((g) => g.id === targetChannelId) ?? false;
  }

  return false;
}
