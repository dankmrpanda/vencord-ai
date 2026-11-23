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
  ChannelType,
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

export const getGuildRoleStore = () => {
  if (typeof window !== 'undefined' && (window as any).Vencord?.Webpack?.Common?.GuildRoleStore) {
    return (window as any).Vencord?.Webpack?.Common?.GuildRoleStore;
  }
  return findStore('GuildRoleStore') ?? findByProps('getRoles', 'getRole');
};

const PERM_ADMINISTRATOR = 8n;
const PERM_VIEW_CHANNEL = 1024n;
const PERM_MANAGE_THREADS = 1n << 34n;

function toPermBits(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function getGuildRolesMap(guildId: string): Map<string, bigint> {
  const rolesMap = new Map<string, bigint>();
  if (!guildId) return rolesMap;

  try {
    const roleStore = getGuildRoleStore();
    if (!roleStore) return rolesMap;

    const raw =
      (typeof roleStore.getSortedRoles === 'function' ? roleStore.getSortedRoles(guildId) : null) ??
      (typeof roleStore.getRolesSnapshot === 'function' ? roleStore.getRolesSnapshot(guildId) : null) ??
      (typeof roleStore.getRoles === 'function' ? roleStore.getRoles(guildId) : null);

    if (!raw) return rolesMap;

    if (raw instanceof Map) {
      for (const [roleId, roleObj] of raw.entries()) {
        const id = String((roleObj as any)?.id || roleId);
        rolesMap.set(id, toPermBits((roleObj as any)?.permissions ?? roleObj));
      }
    } else if (Array.isArray(raw)) {
      for (const roleObj of raw) {
        if (roleObj?.id) {
          rolesMap.set(String(roleObj.id), toPermBits(roleObj.permissions));
        }
      }
    } else if (typeof raw === 'object') {
      for (const [roleId, roleObj] of Object.entries(raw)) {
        const id = String((roleObj as any)?.id || roleId);
        rolesMap.set(id, toPermBits((roleObj as any)?.permissions ?? roleObj));
      }
    }
  } catch {}

  return rolesMap;
}

function getOverwritesMap(channel: any): Map<string, { allow: bigint; deny: bigint }> {
  const map = new Map<string, { allow: bigint; deny: bigint }>();
  const raw = channel?.permissionOverwrites;
  if (!raw) return map;

  if (raw instanceof Map) {
    for (const [id, ow] of raw.entries()) {
      map.set(String((ow as any)?.id || id), {
        allow: toPermBits((ow as any)?.allow),
        deny: toPermBits((ow as any)?.deny),
      });
    }
  } else if (Array.isArray(raw)) {
    for (const ow of raw) {
      if (ow?.id) {
        map.set(String(ow.id), {
          allow: toPermBits(ow.allow),
          deny: toPermBits(ow.deny),
        });
      }
    }
  } else if (typeof raw === 'object') {
    for (const [id, ow] of Object.entries(raw)) {
      map.set(String((ow as any)?.id || id), {
        allow: toPermBits((ow as any)?.allow),
        deny: toPermBits((ow as any)?.deny),
      });
    }
  }

  return map;
}

/**
 * Evaluates whether a guild member has VIEW_CHANNEL permission on a channel,
 * accounting for guild owner, ADMINISTRATOR, thread parent inheritance, and
 * Discord role/member permissionOverwrite precedence.
 */
export function canGuildMemberAccessChannel(
  userId: string,
  memberRoles: string[] = [],
  channel: DiscordChannel | null | undefined,
  guild: DiscordGuild | null | undefined,
  rolesMap: Map<string, bigint>,
): boolean {
  if (!channel) return true;
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM) return false;
  if (guild?.ownerId && guild.ownerId === userId) return true;

  const isThread =
    channel.type === ChannelType.PUBLIC_THREAD ||
    channel.type === ChannelType.PRIVATE_THREAD ||
    channel.type === ChannelType.ANNOUNCEMENT_THREAD ||
    Boolean((channel as any).isThread?.());

  const targetChannel = isThread && channel.parent_id ? (getChannel(channel.parent_id) || channel) : channel;
  const guildId = targetChannel?.guild_id || channel.guild_id || guild?.id || '';
  const overwrites = getOverwritesMap(targetChannel);

  let perms: bigint;
  if (rolesMap.size > 0) {
    perms = guildId && rolesMap.has(guildId) ? rolesMap.get(guildId)! : 0n;
    for (const roleId of memberRoles) {
      const rolePerms = rolesMap.get(roleId);
      if (rolePerms !== undefined) perms |= rolePerms;
    }
  } else {
    if (overwrites.size === 0) {
      return channel.type !== ChannelType.PRIVATE_THREAD;
    }
    // Partial/mock store without GuildRoleStore: assume base @everyone VIEW_CHANNEL
    // so channel permissionOverwrites still govern access accurately.
    perms = PERM_VIEW_CHANNEL;
  }

  if ((perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR) return true;

  if (guildId) {
    const everyoneOverwrite = overwrites.get(guildId);
    if (everyoneOverwrite) {
      perms &= ~everyoneOverwrite.deny;
      perms |= everyoneOverwrite.allow;
    }
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const roleId of memberRoles) {
    const ow = overwrites.get(roleId);
    if (ow) {
      roleAllow |= ow.allow;
      roleDeny |= ow.deny;
    }
  }
  perms &= ~roleDeny;
  perms |= roleAllow;

  const memberOverwrite = overwrites.get(userId);
  if (memberOverwrite) {
    perms &= ~memberOverwrite.deny;
    perms |= memberOverwrite.allow;
  }

  if (channel.type === ChannelType.PRIVATE_THREAD) {
    return (perms & (PERM_VIEW_CHANNEL | PERM_MANAGE_THREADS)) === (PERM_VIEW_CHANNEL | PERM_MANAGE_THREADS);
  }

  return (perms & PERM_VIEW_CHANNEL) === PERM_VIEW_CHANNEL;
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
  aliases: Map<string, Set<string>>;
  participantIds: Set<string>;
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
 * Gathers all in-scope mentionable users without any 8-user truncation:
 * active conversation participants (ordered by recency) plus guild members who have
 * VIEW_CHANNEL permission on at least one permitted channel in the active scope.
 * Never enumerates unauthorized private-channel members or RelationshipStore friends.
 */
function gatherScopeParticipants(
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): GatheredParticipants {
  const userMap = new Map<string, DiscordUser>();
  const latestTime = new Map<string, number>();
  const nicks = new Map<string, string>();
  const aliases = new Map<string, Set<string>>();
  const participantIds = new Set<string>();
  let effectiveGuildId = guildId;

  const recordAlias = (id: string, value: string | null | undefined) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed === 'Member' || trimmed === 'User') return;
    if (!aliases.has(id)) aliases.set(id, new Set());
    aliases.get(id)!.add(trimmed);
  };

  const addUser = (u: any, nick?: string | null, messageTimestamp?: number, markParticipant = true) => {
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

    recordAlias(id, rawUser.username);
    recordAlias(id, rawUser.globalName);
    recordAlias(id, rawUser.global_name);
    recordAlias(id, nick);
    if (markParticipant) {
      participantIds.add(id);
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

    const permittedGuildChannels: Array<DiscordChannel | null> = [];

    for (const chId of permittedChannelIds) {
      if (!chId || chId === '__FORBIDDEN_SCOPE_BLOCKED__') continue;

      const ch = getChannel(chId);
      if (!effectiveGuildId && ch?.guild_id) effectiveGuildId = ch.guild_id;

      if (!ch || (ch.type !== ChannelType.DM && ch.type !== ChannelType.GROUP_DM)) {
        permittedGuildChannels.push(ch);
      }

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

    // Add channel-accessible guild members (silent / non-recent talkers included when permitted)
    if (effectiveGuildId && !scopeContext?.isDM) {
      const memberStore = getGuildMemberStore();
      if (memberStore && permittedGuildChannels.length > 0) {
        try {
          const guild = getGuild(effectiveGuildId);
          const rolesMap = getGuildRolesMap(effectiveGuildId);

          let rawMembers: any[] = [];
          const fetched = typeof memberStore.getMembers === 'function' ? memberStore.getMembers(effectiveGuildId) : null;
          if (Array.isArray(fetched)) {
            rawMembers = fetched;
          } else if (fetched instanceof Map) {
            rawMembers = Array.from(fetched.values());
          } else if (fetched && typeof fetched === 'object') {
            rawMembers = Object.values(fetched);
          } else if (typeof memberStore.getMemberIds === 'function' && typeof memberStore.getMember === 'function') {
            const ids = memberStore.getMemberIds(effectiveGuildId);
            if (Array.isArray(ids)) {
              rawMembers = ids.map((id: string) => memberStore.getMember(effectiveGuildId, id)).filter(Boolean);
            }
          }

          for (const member of rawMembers) {
            const memberId = member?.userId || member?.id || member?.user?.id;
            if (!memberId) continue;
            if (member?.guildId && member.guildId !== effectiveGuildId) continue;

            const memberRoles = Array.isArray(member?.roles) ? member.roles : [];
            const hasChannelAccess = permittedGuildChannels.some((ch) =>
              canGuildMemberAccessChannel(memberId, memberRoles, ch, guild, rolesMap),
            );
            if (!hasChannelAccess) continue;

            const storeUser = getUser(memberId) || (member?.user?.username ? member.user : null);
            const memberNick =
              typeof member?.nick === 'string' && member.nick.trim() && member.nick.trim() !== 'Member'
                ? member.nick.trim()
                : null;
            const hasRealUsername = Boolean(
              storeUser?.username && storeUser.username !== 'Member' && storeUser.username !== 'User',
            );

            if (!hasRealUsername && !memberNick && !userMap.has(memberId)) continue;
            addUser(storeUser || { id: memberId }, memberNick, undefined, false);
          }
        } catch {}
      }

      // Per-user guild nickname enrichment for all in-scope users (covers mocked stores with only getMember)
      if (typeof memberStore?.getMember === 'function') {
        for (const user of userMap.values()) {
          try {
            const member = memberStore.getMember(effectiveGuildId, user.id);
            const nick = member?.nick;
            if (typeof nick === 'string' && nick.trim() && nick !== 'Member') {
              const trimmedNick = nick.trim();
              nicks.set(user.id, trimmedNick);
              recordAlias(user.id, trimmedNick);
              if (!user.globalName) user.globalName = trimmedNick;
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn('[VencordAI] Error gathering mentionable users in scope:', err);
  }

  return { users: Array.from(userMap.values()), latestTime, nicks, aliases, participantIds };
}

function sortGatheredUsers(
  users: DiscordUser[],
  latestTime: Map<string, number>,
  nicks: Map<string, string>,
  queryLower: string,
  aliases?: Map<string, Set<string>>,
): DiscordUser[] {
  return [...users].sort((a, b) => {
    const timeA = latestTime.get(a.id) ?? 0;
    const timeB = latestTime.get(b.id) ?? 0;
    if (timeB !== timeA) return timeB - timeA;

    if (queryLower) {
      const aNick = nicks.get(a.id)?.toLowerCase();
      const bNick = nicks.get(b.id)?.toLowerCase();
      const aAliases = aliases?.get(a.id);
      const bAliases = aliases?.get(b.id);
      const aStarts =
        a.username.toLowerCase().startsWith(queryLower) ||
        Boolean(a.globalName?.toLowerCase().startsWith(queryLower)) ||
        Boolean(aNick?.startsWith(queryLower)) ||
        Boolean(aAliases && Array.from(aAliases).some((al) => al.toLowerCase().startsWith(queryLower)));
      const bStarts =
        b.username.toLowerCase().startsWith(queryLower) ||
        Boolean(b.globalName?.toLowerCase().startsWith(queryLower)) ||
        Boolean(bNick?.startsWith(queryLower)) ||
        Boolean(bAliases && Array.from(bAliases).some((al) => al.toLowerCase().startsWith(queryLower)));
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
    }

    return a.username.localeCompare(b.username);
  });
}

/**
 * Searches for mentionable users with access to the active conversation scope,
 * ordered by recent message recency (most recent message author first).
 */
export function searchMentionableUsers(
  query: string,
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): DiscordUser[] {
  const queryLower = query.trim().replace(/^@/, '').toLowerCase();
  const { users, latestTime, nicks, aliases } = gatherScopeParticipants(scopeOrChannelId, guildId);

  const filtered = queryLower
    ? users.filter((u) => {
        const matchUsername = u.username.toLowerCase().includes(queryLower);
        const matchGlobal = Boolean(u.globalName?.toLowerCase().includes(queryLower));
        const matchNick = Boolean(nicks.get(u.id)?.toLowerCase().includes(queryLower));
        const matchAlias = Boolean(
          aliases.get(u.id) && Array.from(aliases.get(u.id)!).some((al) => al.toLowerCase().includes(queryLower)),
        );
        const matchId = u.id === queryLower;
        return matchUsername || matchGlobal || matchNick || matchAlias || matchId;
      })
    : users;

  return sortGatheredUsers(filtered, latestTime, nicks, queryLower, aliases).slice(0, 8);
}

/**
 * Resolves a single user name, display name, nickname, or @handle strictly within the active scope,
 * searching all in-scope mentionable users without the 8-item autocomplete cap.
 */
export function resolveInScopeUserByName(
  nameQuery: string,
  scopeOrChannelId?: CurrentScopeContext | string | null,
  guildId?: string,
): DiscordUser | null {
  const normalized = nameQuery.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return null;
  const { users, latestTime, nicks, aliases } = gatherScopeParticipants(scopeOrChannelId, guildId);
  const sorted = sortGatheredUsers(users, latestTime, nicks, normalized, aliases);

  const userLabels = (u: DiscordUser): string[] => {
    const set = new Set<string>();
    if (u.username) set.add(u.username.toLowerCase());
    if (u.globalName) set.add(u.globalName.toLowerCase());
    const nick = nicks.get(u.id);
    if (nick) set.add(nick.toLowerCase());
    const userAliases = aliases.get(u.id);
    if (userAliases) {
      for (const al of userAliases) set.add(al.toLowerCase());
    }
    return Array.from(set);
  };

  const exact = sorted.filter((u) => u.id === normalized || userLabels(u).some((label) => label === normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Prefer exact username match if display names collided
    const exactUsername = exact.filter((u) => u.username.toLowerCase() === normalized);
    if (exactUsername.length === 1) return exactUsername[0];
    return exact[0];
  }

  const prefix = sorted.filter((u) => userLabels(u).some((label) => label.startsWith(normalized)));
  if (prefix.length === 1) return prefix[0];

  const partial = sorted.filter((u) => userLabels(u).some((label) => label.includes(normalized)));
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
  const { users, latestTime, nicks, aliases, participantIds } = gatherScopeParticipants(scopeOrChannelId, guildId);
  const sortedUsers = sortGatheredUsers(users, latestTime, nicks, '', aliases);

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
    .flatMap((u) => [
      u.globalName,
      nicks.get(u.id),
      u.username,
      ...Array.from(aliases.get(u.id) || []),
    ].filter((v): v is string => Boolean(v && v.trim())))
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

  // 3. Match bare (un-@-prefixed) participant names strictly within active conversation participants
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
      if (!participantIds.has(user.id)) continue;
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
