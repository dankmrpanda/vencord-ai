/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
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
  DiscordChannel,
  DiscordGuild,
  DiscordMessage,
  DiscordUser,
} from '../types';

function safeWpCall<T>(primaryFn: any, windowFnName: string, ...args: any[]): T | null {
  if (typeof primaryFn === 'function') {
    try {
      const res = primaryFn(...args);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.[windowFnName]?.(...args)) ?? null;
}

export const findByCode = (...code: string[]): any => safeWpCall(wpFindByCode, 'findByCode', ...code);
export const findByProps = (...props: string[]): any => safeWpCall(wpFindByProps, 'findByProps', ...props);
const findStore = (name: string): any => safeWpCall(wpFindStore, 'findStore', name) ?? findByProps(name);

// Lazy Store Getters
export const getSelectedChannelStore = () => findStore('SelectedChannelStore') ?? findByProps('getChannelId', 'getVoiceChannelId');
export const getChannelStore = () => findStore('ChannelStore') ?? findByProps('getChannel', 'getDMFromUserId');
export const getUserStore = () => findStore('UserStore') ?? findByProps('getCurrentUser', 'getUser');
export const getPermissionStore = () => findStore('PermissionStore') ?? findByProps('can');
const getGuildStore = () => findStore('GuildStore') ?? findByProps('getGuild', 'getGuilds');
const getMessageStore = () => findStore('MessageStore') ?? findByProps('getMessages', 'getMessage');
const getAuthStore = () => findStore('AuthenticationStore') ?? findByProps('getToken', 'getId');

const getNavigationRouter = () => {
  if (typeof vcNavRouter !== 'undefined' && (vcNavRouter?.transitionTo || vcNavRouter?.transitionToGuild)) {
    return vcNavRouter;
  }
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.NavigationRouter) {
    return (window as any).Vencord?.Webpack?.Common?.NavigationRouter;
  }
  return findByProps('transitionTo', 'replaceWith') ?? findByProps('transitionToGuild') ?? findByProps('transitionTo');
};

const getMessageJumpModule = () => {
  return findByProps('jumpToMessage', 'focusMessage') ?? findByProps('jumpToMessage') ?? findByProps('trackJump');
};

const getChannelSelectModule = () => {
  return findByProps('selectChannel', 'selectPrivateChannel') ?? findByProps('selectChannel');
};

const getFluxDispatcher = () => {
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
 * Retrieves loaded messages for a channel from Discord's client-side cache.
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

export const getGuildRoleStore = () => {
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.GuildRoleStore) {
    return (window as any).Vencord?.Webpack?.Common?.GuildRoleStore;
  }
  return findStore('GuildRoleStore') ?? findByProps('getRoles', 'getRole');
};

/**
 * Retrieves the current logged-in Discord user.
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
 * Retrieves a user object by ID.
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
 * Retrieves the active channel ID.
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
 * Retrieves a channel object by ID.
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
 * Retrieves a guild object by ID.
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
 * Retrieves the user's Discord auth token.
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
 * Navigates Discord client directly to a specific guild / channel / message in-app.
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
