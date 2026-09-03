/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  find as wpFind,
  findByCode as wpFindByCode,
  findByProps as wpFindByProps,
  findStore as wpFindStore,
} from '@webpack';
import {
  FluxDispatcher as vcFluxDispatcher,
  NavigationRouter as vcNavRouter,
  RestAPI as vcRestAPI,
} from '@webpack/common';
import {
  CurrentScopeContext,
  DiscordChannel,
  DiscordGuild,
  DiscordMessage,
  DiscordUser,
} from '../types';
import { getCurrentScopeContext, getPermittedChannelIdsForScope } from './scope';

function safeWpCall<T>(primaryFn: any, windowFnName: string, ...args: any[]): T | null {
  if (typeof primaryFn === 'function') {
    try {
      const res = primaryFn(...args);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.[windowFnName]?.(...args)) ?? null;
}

export const find = (filter: (mod: any) => boolean): any => safeWpCall(wpFind, 'find', filter);
export const findByCode = (...code: string[]): any => safeWpCall(wpFindByCode, 'findByCode', ...code);
export const findByProps = (...props: string[]): any => safeWpCall(wpFindByProps, 'findByProps', ...props);
export const findStore = (name: string): any => safeWpCall(wpFindStore, 'findStore', name) ?? findByProps(name);

// Lazy Store Getters
export const getSelectedChannelStore = () => findStore('SelectedChannelStore') ?? findByProps('getChannelId', 'getVoiceChannelId');
export const getSelectedGuildStore = () => findStore('SelectedGuildStore') ?? findByProps('getGuildId', 'getLastSelectedGuildId');
export const getChannelStore = () => findStore('ChannelStore') ?? findByProps('getChannel', 'getDMFromUserId');
export const getGuildStore = () => findStore('GuildStore') ?? findByProps('getGuild', 'getGuilds');
export const getUserStore = () => findStore('UserStore') ?? findByProps('getCurrentUser', 'getUser');
export const getMessageStore = () => findStore('MessageStore') ?? findByProps('getMessages', 'getMessage');
export const getRelationshipStore = () => findStore('RelationshipStore') ?? findByProps('getRelationships');
export const getPermissionStore = () => findStore('PermissionStore') ?? findByProps('can');
export const getAuthStore = () => findStore('AuthenticationStore') ?? findByProps('getToken', 'getId');

export const getNavigationRouter = () => {
  if (typeof vcNavRouter !== 'undefined' && (vcNavRouter?.transitionTo || vcNavRouter?.transitionToGuild)) {
    return vcNavRouter;
  }
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.NavigationRouter) {
    return (window as any).Vencord?.Webpack?.Common?.NavigationRouter;
  }
  return findByProps('transitionTo', 'replaceWith') ?? findByProps('transitionToGuild') ?? findByProps('transitionTo');
};

export const getMessageJumpModule = () => {
  return findByProps('jumpToMessage', 'focusMessage') ?? findByProps('jumpToMessage') ?? findByProps('trackJump');
};

export const getChannelSelectModule = () => {
  return findByProps('selectChannel', 'selectPrivateChannel') ?? findByProps('selectChannel');
};

export const getFluxDispatcher = () => {
  if (typeof vcFluxDispatcher !== 'undefined' && vcFluxDispatcher?.dispatch) return vcFluxDispatcher;
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.FluxDispatcher) {
    return (window as any).Vencord?.Webpack?.Common?.FluxDispatcher;
  }
  return findByProps('dispatch', 'subscribe') ?? findStore('FluxDispatcher');
};

export const getHTTP = () => {
  if (typeof vcRestAPI !== 'undefined' && vcRestAPI?.get) return vcRestAPI;
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.RestAPI) {
    return (window as any).Vencord?.Webpack?.Common?.RestAPI;
  }
  return findByProps('get', 'post', 'put', 'del') ?? findByProps('get', 'post', 'del') ?? findByProps('get', 'post');
};

/**
 * Retrieves loaded messages for a channel from Discord's client-side cache
 */
export function getLoadedMessages(channelId: string): DiscordMessage[] {
  try {
    const store = getMessageStore();
    if (!store || !channelId) return [];

    const raw = store.getMessages?.(channelId);
    if (!raw) return [];

    // Discord message cache often returns a Record or collection with toArray() or _array
    if (typeof raw.toArray === 'function') {
      return raw.toArray();
    }
    if (Array.isArray(raw._array)) {
      return raw._array;
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (Array.isArray((raw as any)._ordered)) {
      return (raw as any)._ordered;
    }
    if (typeof raw.values === 'function') {
      return Array.from(raw.values());
    }
    if (typeof raw === 'object') {
      return Object.values(raw);
    }
    return [];
  } catch (err) {
    console.warn(`[VencordAI] Error reading MessageStore for channel ${channelId}:`, err);
    return [];
  }
}

export const getGuildMemberStore = () => {
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.GuildMemberStore) {
    return (window as any).Vencord?.Webpack?.Common?.GuildMemberStore;
  }
  return findStore('GuildMemberStore') ?? findByProps('getMember', 'getMembers');
};

/**
 * Retrieves the current logged-in Discord user
 */
export function getCurrentUser(): DiscordUser | null {
  try {
    return getUserStore()?.getCurrentUser?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting current user:', err);
    return null;
  }
}

/**
 * Retrieves a user object by ID
 */
export function getUser(userId: string): DiscordUser | null {
  try {
    return getUserStore()?.getUser?.(userId) ?? null;
  } catch (err) {
    console.error(`[VencordAI] Error getting user ${userId}:`, err);
    return null;
  }
}

/**
 * Searches for mentionable users participating within the active conversation scope,
 * ordered by recent message recency (most recent message author first).
 */
export function searchMentionableUsers(
  query: string,
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): DiscordUser[] {
  const queryLower = query.trim().replace(/^@/, '').toLowerCase();
  const userMap = new Map<string, DiscordUser>();
  const userLatestMessageTime = new Map<string, number>();

  const addUser = (u: any, nick?: string | null, messageTimestamp?: number) => {
    if (!u) return;
    const id = u.id || u.userId;
    if (!id) return;

    const existing = userMap.get(id);
    const resolvedUsername =
      (u.username && u.username !== 'Member' && u.username !== 'User' ? u.username : undefined) ??
      existing?.username ??
      (nick && nick !== 'Member' ? nick : undefined) ??
      `user_${id.slice(-4)}`;

    const resolvedGlobalName =
      u.globalName ??
      u.global_name ??
      (nick && nick !== resolvedUsername ? nick : null) ??
      existing?.globalName ??
      null;

    const userObj: DiscordUser = {
      id,
      username: resolvedUsername,
      globalName: resolvedGlobalName,
      avatar: u.avatar ?? existing?.avatar ?? null,
      bot: Boolean(u.bot ?? existing?.bot),
    };
    userMap.set(id, userObj);

    if (typeof messageTimestamp === 'number' && !isNaN(messageTimestamp)) {
      const prev = userLatestMessageTime.get(id) ?? 0;
      if (messageTimestamp > prev) {
        userLatestMessageTime.set(id, messageTimestamp);
      }
    } else if (!userLatestMessageTime.has(id)) {
      userLatestMessageTime.set(id, 0);
    }
  };

  try {
    // 1. Resolve scope context and permitted channels
    let scopeContext: CurrentScopeContext | null = null;
    if (scopeOrChannelId && typeof scopeOrChannelId === 'object' && 'channelId' in scopeOrChannelId) {
      scopeContext = scopeOrChannelId as CurrentScopeContext;
    } else if (typeof scopeOrChannelId === 'string' && scopeOrChannelId) {
      try {
        const current = getCurrentScopeContext();
        if (current && current.channelId === scopeOrChannelId) {
          scopeContext = current;
        }
      } catch {}
    } else {
      try {
        scopeContext = getCurrentScopeContext();
      } catch {}
    }

    let permittedChannelIds: string[];
    if (scopeContext) {
      permittedChannelIds = getPermittedChannelIdsForScope(scopeContext);
    } else if (typeof scopeOrChannelId === 'string' && scopeOrChannelId) {
      permittedChannelIds = [scopeOrChannelId];
    } else {
      const currentCh = getCurrentChannelId();
      permittedChannelIds = currentCh ? [currentCh] : [];
    }

    // 2. Extract conversation participants and messages strictly within permitted scope channels
    for (const chId of permittedChannelIds) {
      if (!chId || chId === '__FORBIDDEN_SCOPE_BLOCKED__') continue;

      const ch = getChannel(chId);

      // DM or Group DM participants are intrinsically in scope for that channel
      if (ch?.rawRecipients && Array.isArray(ch.rawRecipients)) {
        for (const r of ch.rawRecipients) {
          addUser(r);
        }
      }
      if (ch?.recipients && Array.isArray(ch.recipients)) {
        for (const rId of ch.recipients) {
          const u = getUser(rId);
          if (u) addUser(u);
          else addUser({ id: rId });
        }
      }

      // Add loaded messages from this channel
      const loaded = getLoadedMessages(chId);
      if (Array.isArray(loaded)) {
        for (let idx = 0; idx < loaded.length; idx++) {
          const msg = loaded[idx];
          if (!msg || !msg.author) continue;

          let msgTime = 0;
          if (msg.timestamp) {
            const parsed = typeof msg.timestamp === 'number' ? msg.timestamp : new Date(msg.timestamp).getTime();
            if (!isNaN(parsed) && parsed > 0) {
              msgTime = parsed;
            }
          }
          if (msgTime === 0 && msg.id) {
            try {
              const snowflakeTime = Number((BigInt(msg.id) >> 22n) + 1420070400000n);
              if (!isNaN(snowflakeTime) && snowflakeTime > 0) {
                msgTime = snowflakeTime;
              }
            } catch {}
          }
          // If no timestamp or snowflake, treat later array position as more recent
          if (msgTime === 0) {
            msgTime = idx + 1;
          }

          const nick = (msg as any).nick ?? (msg.author as any)?.nick ?? null;
          addUser(msg.author, nick, msgTime);
        }
      }
    }

    // Include explicit otherUser from scope context if in DM
    if (scopeContext?.isDM && scopeContext.otherUser) {
      addUser(scopeContext.otherUser);
    }
  } catch (err) {
    console.warn('[VencordAI] Error gathering mentionable users in scope:', err);
  }

  // Filter matching users
  const users = Array.from(userMap.values());
  const filtered = queryLower
    ? users.filter((u) => {
        const matchUsername = u.username.toLowerCase().includes(queryLower);
        const matchGlobal = Boolean(u.globalName?.toLowerCase().includes(queryLower));
        const matchId = u.id === queryLower;
        return matchUsername || matchGlobal || matchId;
      })
    : users;

  // Order in terms of recent message (newest first)
  return filtered
    .sort((a, b) => {
      const timeA = userLatestMessageTime.get(a.id) ?? 0;
      const timeB = userLatestMessageTime.get(b.id) ?? 0;

      // Primary sort: Most recent message author first
      if (timeB !== timeA) {
        return timeB - timeA;
      }

      // Tiebreakers: Prefix match on username or globalName
      if (queryLower) {
        const aStarts =
          a.username.toLowerCase().startsWith(queryLower) ||
          Boolean(a.globalName?.toLowerCase().startsWith(queryLower));
        const bStarts =
          b.username.toLowerCase().startsWith(queryLower) ||
          Boolean(b.globalName?.toLowerCase().startsWith(queryLower));
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }

      return a.username.localeCompare(b.username);
    })
    .slice(0, 8);
}

/**
 * Resolves user mentions (@username or <@id>) found in a prompt string
 */
export function resolvePromptMentions(
  prompt: string,
  scopeOrChannelId?: CurrentScopeContext | string,
  guildId?: string,
): DiscordUser[] {
  if (!prompt || typeof prompt !== 'string') return [];

  const mentionedUsers: DiscordUser[] = [];
  const seenIds = new Set<string>();

  // 1. Match Discord snowflake mentions: <@1234567890> or <@!1234567890>
  const idMatches = prompt.matchAll(/<@!?(\d+)>/g);
  for (const match of idMatches) {
    const id = match[1];
    if (!seenIds.has(id)) {
      seenIds.add(id);
      const user = getUser(id) || { id, username: `user_${id}` };
      mentionedUsers.push(user);
    }
  }

  // 2. Match text mentions: @username or @display_name
  const nameMatches = prompt.matchAll(/@([a-zA-Z0-9_.-]+)/g);
  for (const match of nameMatches) {
    const nameQuery = match[1].toLowerCase();
    // Ignore special discord tags like @everyone or @here
    if (nameQuery === 'everyone' || nameQuery === 'here') continue;

    const matchedUsers = searchMentionableUsers(nameQuery, scopeOrChannelId, guildId);
    const exactMatch =
      matchedUsers.find(
        (u) =>
          u.username.toLowerCase() === nameQuery ||
          u.globalName?.toLowerCase() === nameQuery,
      ) || matchedUsers[0];

    if (exactMatch && !seenIds.has(exactMatch.id)) {
      seenIds.add(exactMatch.id);
      mentionedUsers.push(exactMatch);
    }
  }

  return mentionedUsers;
}

/**
 * Retrieves the active channel ID
 */
export function getCurrentChannelId(): string | null {
  try {
    return getSelectedChannelStore()?.getChannelId?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting current channel ID:', err);
    return null;
  }
}

/**
 * Retrieves a channel object by ID
 */
export function getChannel(channelId: string): DiscordChannel | null {
  try {
    return getChannelStore()?.getChannel?.(channelId) ?? null;
  } catch (err) {
    console.error(`[VencordAI] Error getting channel ${channelId}:`, err);
    return null;
  }
}

/**
 * Retrieves a guild object by ID
 */
export function getGuild(guildId: string): DiscordGuild | null {
  try {
    return getGuildStore()?.getGuild?.(guildId) ?? null;
  } catch (err) {
    console.error(`[VencordAI] Error getting guild ${guildId}:`, err);
    return null;
  }
}

/**
 * Retrieves the user's Discord auth token
 */
export function getAuthToken(): string | null {
  try {
    const authStore = getAuthStore();
    return authStore?.getToken?.() ?? null;
  } catch (err) {
    console.error('[VencordAI] Error getting auth token:', err);
    return null;
  }
}

/**
 * Navigates Discord client directly to a specific guild / channel / message in-app
 */
export function jumpToMessage(channelId: string, messageId?: string, guildId?: string): void {
  if (!channelId) return;

  // Auto-resolve guildId if not provided
  let effectiveGuildId = guildId;
  if (!effectiveGuildId || effectiveGuildId === '@me') {
    const ch = getChannel(channelId);
    if (ch?.guild_id) {
      effectiveGuildId = ch.guild_id;
    } else {
      effectiveGuildId = undefined;
    }
  }

  const targetPath = effectiveGuildId
    ? `/channels/${effectiveGuildId}/${channelId}${messageId ? `/${messageId}` : ''}`
    : `/channels/@me/${channelId}${messageId ? `/${messageId}` : ''}`;

  console.log(`[VencordAI] In-app navigation to: ${targetPath}`);

  // Method 1: Discord Message Jump Actions (Best: loads surrounding messages and highlights target message)
  if (messageId) {
    try {
      const jumpMod = getMessageJumpModule();
      if (typeof jumpMod?.jumpToMessage === 'function') {
        try {
          jumpMod.jumpToMessage({
            channelId,
            messageId,
            flash: true,
            isPreload: false,
          });
          return;
        } catch {
          try {
            jumpMod.jumpToMessage(channelId, messageId);
            return;
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[VencordAI] Message jump module failed, trying router:', err);
    }
  }

  // Method 2: Navigation Router (Vencord Webpack Common or Discord Routing)
  try {
    const router = getNavigationRouter();
    if (router?.transitionToGuild && effectiveGuildId) {
      router.transitionToGuild(effectiveGuildId, channelId, messageId);
      return;
    }
    if (typeof router?.transitionTo === 'function') {
      router.transitionTo(targetPath);
      return;
    }
    if (typeof router?.replaceWith === 'function') {
      router.replaceWith(targetPath);
      return;
    }
  } catch (err) {
    console.warn('[VencordAI] Navigation router transition failed:', err);
  }

  // Method 3: Channel Select Module
  try {
    const selectMod = getChannelSelectModule();
    if (typeof selectMod?.selectChannel === 'function') {
      selectMod.selectChannel({
        guildId: effectiveGuildId || null,
        channelId,
        messageId: messageId || null,
      });
      return;
    }
  } catch (err) {
    console.warn('[VencordAI] selectChannel failed:', err);
  }

  // Method 4: Flux Dispatcher (Direct Discord Redux / Flux store action)
  try {
    const dispatcher = getFluxDispatcher();
    if (dispatcher?.dispatch) {
      dispatcher.dispatch({
        type: 'CHANNEL_SELECT',
        guildId: effectiveGuildId || null,
        channelId,
        messageId: messageId || null,
      });
      if (messageId) {
        dispatcher.dispatch({
          type: 'MESSAGE_FOCUS',
          channelId,
          messageId,
        });
      }
      return;
    }
  } catch (err) {
    console.warn('[VencordAI] FluxDispatcher navigation failed:', err);
  }
}
