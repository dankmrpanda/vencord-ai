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
import { RestAPI as vcRestAPI } from '@webpack/common';
import { DiscordChannel, DiscordGuild, DiscordMessage, DiscordUser } from '../types';

export function find(filter: (mod: any) => boolean): any {
  if (typeof wpFind === 'function') {
    try {
      const res = wpFind(filter);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.find?.(filter)) ?? null;
}

export function findByCode(...code: string[]): any {
  if (typeof wpFindByCode === 'function') {
    try {
      const res = wpFindByCode(...code);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.findByCode?.(...code)) ?? null;
}

export function findByProps(...props: string[]): any {
  if (typeof wpFindByProps === 'function') {
    try {
      const res = wpFindByProps(...props);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.findByProps?.(...props)) ?? null;
}

export function findStore(name: string): any {
  if (typeof wpFindStore === 'function') {
    try {
      const res = wpFindStore(name);
      if (res) return res;
    } catch {}
  }
  return (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.findStore?.(name)) ?? findByProps(name);
}

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
export const getNavigationUtils = () => findByProps('transitionToGuild', 'transitionTo') ?? findByProps('transitionTo');

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
    if (typeof raw.values === 'function') {
      return Array.from(raw.values());
    }
    return [];
  } catch (err) {
    console.warn(`[VencordAI] Error reading MessageStore for channel ${channelId}:`, err);
    return [];
  }
}

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
 * Navigates Discord client to a specific guild / channel / message
 */
export function jumpToMessage(channelId: string, messageId: string, guildId?: string): void {
  try {
    const nav = getNavigationUtils();
    if (nav?.transitionToGuild && guildId) {
      nav.transitionToGuild(guildId, channelId, messageId);
      return;
    }
    if (nav?.transitionTo) {
      const path = guildId 
        ? `/channels/${guildId}/${channelId}/${messageId}`
        : `/channels/@me/${channelId}/${messageId}`;
      nav.transitionTo(path);
      return;
    }
    const url = guildId 
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : `https://discord.com/channels/@me/${channelId}/${messageId}`;
    window.open(url, '_blank');
  } catch (err) {
    console.error('[VencordAI] Error jumping to message:', err);
  }
}
