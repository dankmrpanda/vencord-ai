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

interface GatheredParticipants {
  users: DiscordUser[];
  latestTime: Map<string, number>;
  nicks: Map<string, string>;
}

function resolveMessageTimestampMs(msg: any, fallbackIndex: number): number {
  let msgTime = 0;
  if (msg?.timestamp) {
    const parsed = typeof msg.timestamp === 'number' ? msg.timestamp : new Date(msg.timestamp).getTime();
    if (!isNaN(parsed) && parsed > 0) msgTime = parsed;
  }
  if (msgTime === 0 && msg?.id) {
    try {
      const snowflakeTime = Number((BigInt(msg.id) >> 22n) + 1420070400000n);
      if (!isNaN(snowflakeTime) && snowflakeTime > 0) msgTime = snowflakeTime;
    } catch {}
  }
  return msgTime === 0 ? fallbackIndex + 1 : msgTime;
}

/**
 * Gathers all in-scope conversation participants without any 8-user truncation.
 * Strictly isolated to permitted channels — never enumerates non-participating GuildMemberStore
 * or RelationshipStore entries.
 */
function gatherScopeParticipants(
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): GatheredParticipants {
  const userMap = new Map<string, DiscordUser>();
  const latestTime = new Map<string, number>();
  const nicks = new Map<string, string>();
  let effectiveGuildId = guildId;

  const addUser = (u: any, nick?: string | null, messageTimestamp?: number) => {
    if (!u) return;
    const id = typeof u === 'string' ? u : (u.id || u.userId);
    if (!id) return;

    const rawUser = typeof u === 'string' ? (getUser(u) || { id }) : u;
    const existing = userMap.get(id);
    const resolvedUsername =
      (rawUser.username && rawUser.username !== 'Member' && rawUser.username !== 'User' ? rawUser.username : undefined) ??
      existing?.username ??
      (nick && nick !== 'Member' ? nick : undefined) ??
      `user_${String(id).slice(-4)}`;

    const resolvedGlobalName =
      rawUser.globalName ??
      rawUser.global_name ??
      (nick && nick !== resolvedUsername ? nick : null) ??
      existing?.globalName ??
      null;

    if (nick && nick !== 'Member' && !nicks.has(id)) {
      nicks.set(id, nick);
    }

    const userObj: DiscordUser = {
      id,
      username: resolvedUsername,
      globalName: resolvedGlobalName,
      avatar: rawUser.avatar ?? existing?.avatar ?? null,
      bot: Boolean(rawUser.bot ?? existing?.bot),
    };
    userMap.set(id, userObj);

    if (typeof messageTimestamp === 'number' && !isNaN(messageTimestamp)) {
      const prev = latestTime.get(id) ?? 0;
      if (messageTimestamp > prev) latestTime.set(id, messageTimestamp);
    } else if (!latestTime.has(id)) {
      latestTime.set(id, 0);
    }
  };

  try {
    let scopeContext: CurrentScopeContext | null = null;
    if (scopeOrChannelId && typeof scopeOrChannelId === 'object' && 'channelId' in scopeOrChannelId) {
      scopeContext = scopeOrChannelId as CurrentScopeContext;
    } else if (typeof scopeOrChannelId === 'string' && scopeOrChannelId) {
      try {
        const current = getCurrentScopeContext();
        if (current && current.channelId === scopeOrChannelId) scopeContext = current;
      } catch {}
    } else {
      try {
        scopeContext = getCurrentScopeContext();
      } catch {}
    }

    effectiveGuildId ||= scopeContext?.guildId;

    let permittedChannelIds: string[];
    if (scopeContext) {
      permittedChannelIds = getPermittedChannelIdsForScope(scopeContext);
    } else if (typeof scopeOrChannelId === 'string' && scopeOrChannelId) {
      permittedChannelIds = [scopeOrChannelId];
    } else {
      const currentCh = getCurrentChannelId();
      permittedChannelIds = currentCh ? [currentCh] : [];
    }

    for (const chId of permittedChannelIds) {
      if (!chId || chId === '__FORBIDDEN_SCOPE_BLOCKED__') continue;

      const ch = getChannel(chId);
      if (!effectiveGuildId && ch?.guild_id) effectiveGuildId = ch.guild_id;

      if (ch?.rawRecipients && Array.isArray(ch.rawRecipients)) {
        for (const r of ch.rawRecipients) addUser(r);
      }
      if (ch?.recipients && Array.isArray(ch.recipients)) {
        for (const rId of ch.recipients) {
          const u = getUser(rId);
          addUser(u || { id: rId });
        }
      }

      const loaded = getLoadedMessages(chId);
      if (Array.isArray(loaded)) {
        for (let idx = 0; idx < loaded.length; idx++) {
          const msg = loaded[idx];
          if (!msg) continue;
          const msgTime = resolveMessageTimestampMs(msg, idx);

          if (msg.author) {
            const nick = (msg as any).nick ?? (msg.author as any)?.nick ?? null;
            addUser(msg.author, nick, msgTime);
          }
          if (msg.referenced_message?.author) {
            const refNick = (msg.referenced_message as any).nick ?? (msg.referenced_message.author as any)?.nick ?? null;
            addUser(msg.referenced_message.author, refNick);
          }
          if (Array.isArray(msg.mentions)) {
            for (const m of msg.mentions) {
              if (typeof m === 'string') {
                const u = getUser(m);
                if (u) addUser(u);
              } else if (m && (m.id || (m as any).userId)) {
                addUser(m);
              }
            }
          }
        }
      }
    }

    if (scopeContext?.isDM && scopeContext.otherUser) {
      addUser(scopeContext.otherUser);
    }
    if (scopeContext?.groupDMRecipients?.length) {
      for (const r of scopeContext.groupDMRecipients) addUser(r);
    }
    if (scopeContext?.currentUser) {
      addUser(scopeContext.currentUser);
    }

    // Per-user guild nickname enrichment for already-discovered in-scope participants only.
    if (effectiveGuildId) {
      const memberStore = getGuildMemberStore();
      if (typeof memberStore?.getMember === 'function') {
        for (const user of userMap.values()) {
          try {
            const member = memberStore.getMember(effectiveGuildId, user.id);
            const nick = member?.nick;
            if (typeof nick === 'string' && nick.trim() && nick !== 'Member') {
              nicks.set(user.id, nick.trim());
              if (!user.globalName) user.globalName = nick.trim();
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn('[VencordAI] Error gathering mentionable users in scope:', err);
  }

  return { users: Array.from(userMap.values()), latestTime, nicks };
}

function sortGatheredUsers(
  users: DiscordUser[],
  latestTime: Map<string, number>,
  nicks: Map<string, string>,
  queryLower: string,
): DiscordUser[] {
  return [...users].sort((a, b) => {
    const timeA = latestTime.get(a.id) ?? 0;
    const timeB = latestTime.get(b.id) ?? 0;
    if (timeB !== timeA) return timeB - timeA;

    if (queryLower) {
      const aNick = nicks.get(a.id)?.toLowerCase();
      const bNick = nicks.get(b.id)?.toLowerCase();
      const aStarts =
        a.username.toLowerCase().startsWith(queryLower) ||
        Boolean(a.globalName?.toLowerCase().startsWith(queryLower)) ||
        Boolean(aNick?.startsWith(queryLower));
      const bStarts =
        b.username.toLowerCase().startsWith(queryLower) ||
        Boolean(b.globalName?.toLowerCase().startsWith(queryLower)) ||
        Boolean(bNick?.startsWith(queryLower));
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
    }

    return a.username.localeCompare(b.username);
  });
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
  const { users, latestTime, nicks } = gatherScopeParticipants(scopeOrChannelId, guildId);

  const filtered = queryLower
    ? users.filter((u) => {
        const matchUsername = u.username.toLowerCase().includes(queryLower);
        const matchGlobal = Boolean(u.globalName?.toLowerCase().includes(queryLower));
        const matchNick = Boolean(nicks.get(u.id)?.toLowerCase().includes(queryLower));
        const matchId = u.id === queryLower;
        return matchUsername || matchGlobal || matchNick || matchId;
      })
    : users;

  return sortGatheredUsers(filtered, latestTime, nicks, queryLower).slice(0, 8);
}

/**
 * Resolves a single user name, display name, nickname, or @handle strictly within the active scope,
 * searching all in-scope participants without the 8-item autocomplete cap.
 */
export function resolveInScopeUserByName(
  nameQuery: string,
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): DiscordUser | null {
  const normalized = nameQuery.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return null;
  const { users, latestTime, nicks } = gatherScopeParticipants(scopeOrChannelId, guildId);
  const sorted = sortGatheredUsers(users, latestTime, nicks, normalized);

  const exact = sorted.filter(
    (u) =>
      u.id === normalized ||
      u.username.toLowerCase() === normalized ||
      u.globalName?.toLowerCase() === normalized ||
      nicks.get(u.id)?.toLowerCase() === normalized,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Prefer exact username match if display names collided
    const exactUsername = exact.filter((u) => u.username.toLowerCase() === normalized);
    if (exactUsername.length === 1) return exactUsername[0];
    return exact[0];
  }

  const prefix = sorted.filter(
    (u) =>
      u.username.toLowerCase().startsWith(normalized) ||
      u.globalName?.toLowerCase().startsWith(normalized) ||
      nicks.get(u.id)?.toLowerCase().startsWith(normalized),
  );
  if (prefix.length === 1) return prefix[0];

  const partial = sorted.filter(
    (u) =>
      u.username.toLowerCase().includes(normalized) ||
      u.globalName?.toLowerCase().includes(normalized) ||
      nicks.get(u.id)?.toLowerCase().includes(normalized),
  );
  if (partial.length === 1) return partial[0];
  return null;
}

const BARE_NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'did', 'let', 'put', 'say', 'she', 'too',
  'use', 'chat', 'help', 'info', 'user', 'bot', 'mod', 'admin', 'here', 'this', 'that',
  'what', 'when', 'with', 'from', 'have', 'they', 'will', 'said', 'about', 'just',
  'last', 'next', 'find', 'show', 'list', 'link', 'file', 'note', 'post', 'poll',
  'code', 'pin', 'pins', 'today', 'week', 'month', 'year',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves user mentions (@username, <@id>, or unambiguous bare in-scope names) found in a prompt string
 */
export function resolvePromptMentions(
  prompt: string,
  scopeOrChannelId?: CurrentScopeContext | string,
  guildId?: string,
): DiscordUser[] {
  if (!prompt || typeof prompt !== 'string') return [];

  const mentionedUsers: DiscordUser[] = [];
  const seenIds = new Set<string>();
  const { users, latestTime, nicks } = gatherScopeParticipants(scopeOrChannelId, guildId);
  const sortedUsers = sortGatheredUsers(users, latestTime, nicks, '');

  // 1. Match Discord snowflake mentions: <@1234567890> or <@!1234567890>
  const idMatches = prompt.matchAll(/<@!?(\d+)>/g);
  for (const match of idMatches) {
    const id = match[1];
    if (!seenIds.has(id)) {
      seenIds.add(id);
      const user = sortedUsers.find((u) => u.id === id) || getUser(id) || { id, username: `user_${id}` };
      mentionedUsers.push(user);
    }
  }

  // 2. Match @username, @display_name, or multi-word @Display Name (ignoring emails like a@b.com)
  const sortedLabels = sortedUsers
    .flatMap((u) => [u.globalName, nicks.get(u.id), u.username].filter((v): v is string => Boolean(v && v.trim())))
    .sort((a, b) => b.length - a.length);
  const atMatches = prompt.matchAll(/(?:^|[\s([{"'.,!?;:])@([\p{L}\p{N}_.-]+)/gu);
  for (const match of atMatches) {
    const matchStart = (match.index ?? 0) + match[0].indexOf('@');
    const afterAt = prompt.slice(matchStart + 1);
    const nameQuery = match[1].toLowerCase();
    // Ignore special discord tags like @everyone or @here
    if (nameQuery === 'everyone' || nameQuery === 'here') continue;

    // Try longest multi-word display name/nick directly after @ first, then single-token resolution
    let resolved: DiscordUser | null = null;
    const afterAtLower = afterAt.toLowerCase();
    for (const label of sortedLabels) {
      const labelLower = label.trim().toLowerCase();
      if (labelLower.length < 2 || !afterAtLower.startsWith(labelLower)) continue;
      const boundaryChar = afterAt[labelLower.length];
      if (!boundaryChar || !/[\p{L}\p{N}_]/u.test(boundaryChar)) {
        resolved = resolveInScopeUserByName(labelLower, scopeOrChannelId, guildId);
        if (resolved) break;
      }
    }
    if (!resolved) {
      resolved = resolveInScopeUserByName(nameQuery, scopeOrChannelId, guildId);
    }

    if (resolved && !seenIds.has(resolved.id)) {
      seenIds.add(resolved.id);
      mentionedUsers.push(resolved);
    }
  }

  // 3. Match bare (un-@-prefixed) participant names strictly within active scope when unambiguous
  if (sortedUsers.length > 0) {
    const nameToIds = new Map<string, Set<string>>();
    const nameToUser = new Map<string, DiscordUser>();
    const registerLabel = (label: string | null | undefined, user: DiscordUser) => {
      const normalized = (label || '').trim().toLowerCase();
      if (normalized.length < 3 || BARE_NAME_STOPWORDS.has(normalized)) return;
      if (!nameToIds.has(normalized)) nameToIds.set(normalized, new Set());
      nameToIds.get(normalized)!.add(user.id);
      nameToUser.set(normalized, user);
    };

    for (const user of sortedUsers) {
      registerLabel(user.username, user);
      registerLabel(user.globalName, user);
      registerLabel(nicks.get(user.id), user);
    }

    for (const [label, ids] of nameToIds.entries()) {
      if (ids.size !== 1) continue;
      const user = nameToUser.get(label)!;
      if (seenIds.has(user.id)) continue;
      const wholeWord = new RegExp(`(?<![\\p{L}\\p{N}_@])${escapeRegExp(label)}(?![\\p{L}\\p{N}_@])`, 'iu');
      if (wholeWord.test(prompt)) {
        seenIds.add(user.id);
        mentionedUsers.push(user);
      }
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
