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
import { DiscordChannel, DiscordGuild, DiscordMessage, DiscordUser } from '../types';

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
 * Searches for users/members across the active channel, guild, and cached stores
 */
export function searchMentionableUsers(query: string, channelId?: string, guildId?: string): DiscordUser[] {
  const queryLower = query.trim().toLowerCase();
  const userMap = new Map<string, DiscordUser>();

  const addUser = (u: any, nick?: string | null) => {
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
  };

  try {
    // 1. Channel recipients (for DMs / Group DMs)
    if (channelId) {
      const ch = getChannel(channelId);
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
    }

    // 2. Authors of currently loaded messages in this channel
    if (channelId) {
      const loaded = getLoadedMessages(channelId);
      for (const msg of loaded) {
        if (msg.author) addUser(msg.author, (msg as any).nick);
      }
    }

    // 3. Guild members (if in a server)
    const effectiveGuildId = guildId || (channelId ? getChannel(channelId)?.guild_id : undefined);
    if (effectiveGuildId) {
      const memberStore = getGuildMemberStore();
      const rawMembers = memberStore?.getMembers?.(effectiveGuildId);
      const memberList: any[] = Array.isArray(rawMembers)
        ? rawMembers
        : rawMembers && typeof rawMembers === 'object'
          ? Object.values(rawMembers)
          : [];

      if (memberList.length > 0) {
        for (const m of memberList) {
          const memberUser = m.user || getUser(m.userId || m.id);
          if (memberUser) {
            addUser(memberUser, m.nick);
          } else if (m.userId || m.id) {
            addUser({ id: m.userId || m.id, username: m.nick }, m.nick);
          }
        }
      } else if (memberStore?.getMemberIds) {
        const memberIds = memberStore.getMemberIds(effectiveGuildId);
        if (Array.isArray(memberIds)) {
          for (const id of memberIds.slice(0, 100)) {
            const u = getUser(id);
            const nick = memberStore.getNick?.(effectiveGuildId, id);
            if (u) addUser(u, nick);
            else if (nick) addUser({ id, username: nick }, nick);
          }
        }
      }
    }

    // 4. Friends from RelationshipStore
    const relStore = getRelationshipStore();
    if (relStore?.getFriendIDs) {
      const friendIds = relStore.getFriendIDs();
      if (Array.isArray(friendIds)) {
        for (const fId of friendIds.slice(0, 50)) {
          const u = getUser(fId);
          const nick = relStore.getNickname?.(fId);
          if (u) addUser(u, nick);
        }
      }
    }

    // 5. Cached users from UserStore
    const userStore = getUserStore();
    const allUsers = userStore?.getUsers?.();
    if (allUsers) {
      const values = typeof allUsers.values === 'function' ? Array.from(allUsers.values()) : Object.values(allUsers);
      for (const u of values) {
        addUser(u);
      }
    }
  } catch (err) {
    console.warn('[VencordAI] Error gathering mentionable users:', err);
  }

  // Filter and rank
  const users = Array.from(userMap.values());
  if (!queryLower) {
    return users.slice(0, 8);
  }

  return users
    .filter((u) => {
      const matchUsername = u.username.toLowerCase().includes(queryLower);
      const matchGlobal = Boolean(u.globalName?.toLowerCase().includes(queryLower));
      const matchId = u.id === queryLower;
      return matchUsername || matchGlobal || matchId;
    })
    .sort((a, b) => {
      const aStarts =
        a.username.toLowerCase().startsWith(queryLower) ||
        Boolean(a.globalName?.toLowerCase().startsWith(queryLower));
      const bStarts =
        b.username.toLowerCase().startsWith(queryLower) ||
        Boolean(b.globalName?.toLowerCase().startsWith(queryLower));
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.username.localeCompare(b.username);
    })
    .slice(0, 8);
}

/**
 * Resolves user mentions (@username or <@id>) found in a prompt string
 */
export function resolvePromptMentions(
  prompt: string,
  channelId?: string,
  guildId?: string
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

    const matchedUsers = searchMentionableUsers(nameQuery, channelId, guildId);
    const exactMatch =
      matchedUsers.find(
        (u) =>
          u.username.toLowerCase() === nameQuery ||
          u.globalName?.toLowerCase() === nameQuery
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
