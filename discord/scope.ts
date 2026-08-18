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

    // Check all private channels in ChannelStore
    const privateChannels: DiscordChannel[] = [];

    // Various Discord internal methods for private channels
    if (typeof channelStore.getMutablePrivateChannels === 'function') {
      const map = channelStore.getMutablePrivateChannels();
      for (const key in map) {
        privateChannels.push(map[key]);
      }
    } else if (typeof channelStore.getPrivateChannels === 'function') {
      const map = channelStore.getPrivateChannels();
      for (const key in map) {
        privateChannels.push(map[key]);
      }
    } else if (typeof channelStore.getChannels === 'function') {
      const all = channelStore.getChannels();
      if (Array.isArray(all)) {
        for (const ch of all) {
          if (ch.type === ChannelType.GROUP_DM) privateChannels.push(ch);
        }
      }
    }

    const mutualGDMs = privateChannels.filter((ch) => {
      if (ch.type !== ChannelType.GROUP_DM) return false;
      const recipients: string[] = ch.recipients ?? [];
      // Group DMs store recipient user IDs (excluding current user or sometimes including)
      return recipients.includes(otherUserId);
    });

    return mutualGDMs;
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
    if (!channelStore) return [];

    const guildChannels: DiscordChannel[] = [];
    const rawChannels = channelStore.getChannels(guildId);

    if (rawChannels && typeof rawChannels === 'object') {
      // Flatten potential category bucket maps or nested arrays
      const rawList = Array.isArray(rawChannels) ? rawChannels : Object.values(rawChannels);
      const flattenedList: any[] = [];

      for (const entry of rawList) {
        if (Array.isArray(entry)) {
          flattenedList.push(...entry);
        } else {
          flattenedList.push(entry);
        }
      }

      for (const item of flattenedList) {
        const ch: DiscordChannel = item?.channel ?? item;
        if (!ch || !ch.id) continue;

        // Only include text-capable channels
        const isTextCapable =
          ch.type === ChannelType.GUILD_TEXT ||
          ch.type === ChannelType.GUILD_ANNOUNCEMENT ||
          ch.type === ChannelType.PUBLIC_THREAD ||
          ch.type === ChannelType.PRIVATE_THREAD ||
          ch.type === ChannelType.GUILD_FORUM;

        if (isTextCapable) {
          // Check permission if permStore is available
          let canView = true;
          if (permStore?.can) {
            // VIEW_CHANNEL is 0x400n (1024)
            try {
              canView = Boolean(permStore.can(1024n, ch));
            } catch {
              try {
                canView = Boolean(permStore.can(1024, ch));
              } catch {
                canView = true;
              }
            }
          }

          if (canView) {
            guildChannels.push(ch);
          }
        }
      }
    }

    return guildChannels;
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

  return {
    channelId,
    channelName,
    channelType: channel.type,
    isDM,
    isGroupDM,
    isGuild,
    guildId: channel.guild_id,
    guildName,
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
