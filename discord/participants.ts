/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  ChannelType,
  CurrentScopeContext,
  DiscordChannel,
  DiscordGuild,
  DiscordUser,
} from '../types';
import { snowflakeToTimestampMs } from './rest';
import { escapeRegExp } from './safeRegex';
import { getCurrentScopeContext, getPermittedChannelIdsForScope, isThreadChannel, VIEW_CHANNEL_PERMISSION } from './scope';
import {
  getChannel,
  getCurrentChannelId,
  getGuild,
  getGuildMemberStore,
  getGuildRoleStore,
  getLoadedMessages,
  getUser,
} from './stores';

const PERM_ADMINISTRATOR = 8n;
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

function collectionEntries(raw: unknown): Array<[string, any]> {
  if (!raw) return [];
  if (raw instanceof Map) return Array.from(raw.entries()).map(([k, v]) => [String((v as any)?.id || k), v]);
  if (Array.isArray(raw)) return raw.flatMap((v) => (v?.id ? [[String(v.id), v] as [string, any]] : []));
  if (typeof raw === 'object') return Object.entries(raw).map(([k, v]) => [String((v as any)?.id || k), v]);
  return [];
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

    for (const [id, roleObj] of collectionEntries(raw)) {
      rolesMap.set(id, toPermBits((roleObj as any)?.permissions ?? roleObj));
    }
  } catch {}

  return rolesMap;
}

function getOverwritesMap(channel: any): Map<string, { allow: bigint; deny: bigint }> {
  const map = new Map<string, { allow: bigint; deny: bigint }>();
  for (const [id, ow] of collectionEntries(channel?.permissionOverwrites)) {
    map.set(id, {
      allow: toPermBits((ow as any)?.allow),
      deny: toPermBits((ow as any)?.deny),
    });
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

  const targetChannel = isThreadChannel(channel) && channel.parent_id ? (getChannel(channel.parent_id) || channel) : channel;
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
    perms = VIEW_CHANNEL_PERMISSION;
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
    return (perms & (VIEW_CHANNEL_PERMISSION | PERM_MANAGE_THREADS)) === (VIEW_CHANNEL_PERMISSION | PERM_MANAGE_THREADS);
  }

  return (perms & VIEW_CHANNEL_PERMISSION) === VIEW_CHANNEL_PERMISSION;
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
    const snowflakeTime = snowflakeToTimestampMs(msg.id);
    if (snowflakeTime !== null && snowflakeTime > 0) msgTime = snowflakeTime;
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
      if (!chId) continue;

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
      addAccessibleGuildMembers(effectiveGuildId, permittedGuildChannels, userMap, nicks, recordAlias, addUser);
    }
  } catch (err) {
    console.warn('[VencordAI] Error gathering mentionable users in scope:', err);
  }

  return { users: Array.from(userMap.values()), latestTime, nicks, aliases, participantIds };
}

function addAccessibleGuildMembers(
  effectiveGuildId: string,
  permittedGuildChannels: Array<DiscordChannel | null>,
  userMap: Map<string, DiscordUser>,
  nicks: Map<string, string>,
  recordAlias: (id: string, value: string | null | undefined) => void,
  addUser: (u: any, nick?: string | null, messageTimestamp?: number, markParticipant?: boolean) => void,
): void {
  const memberStore = getGuildMemberStore();
  if (memberStore && permittedGuildChannels.length > 0) {
    try {
      const guild = getGuild(effectiveGuildId);
      const rolesMap = getGuildRolesMap(effectiveGuildId);

      const fetched = typeof memberStore.getMembers === 'function' ? memberStore.getMembers(effectiveGuildId) : null;
      let rawMembers: any[] = [];
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

function getUserSearchLabels(
  user: DiscordUser,
  nicks: Map<string, string>,
  aliases?: Map<string, Set<string>>,
): string[] {
  const set = new Set<string>();
  if (user.username) set.add(user.username.toLowerCase());
  if (user.globalName) set.add(user.globalName.toLowerCase());
  const nick = nicks.get(user.id);
  if (nick) set.add(nick.toLowerCase());
  const userAliases = aliases?.get(user.id);
  if (userAliases) {
    for (const al of userAliases) set.add(al.toLowerCase());
  }
  return Array.from(set);
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
      const aStarts = getUserSearchLabels(a, nicks, aliases).some((label) => label.startsWith(queryLower));
      const bStarts = getUserSearchLabels(b, nicks, aliases).some((label) => label.startsWith(queryLower));
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
    }

    return a.username.localeCompare(b.username);
  });
}

function matchUserInGathered(nameQuery: string, gathered: GatheredParticipants): DiscordUser | null {
  const normalized = nameQuery.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return null;
  const { users, latestTime, nicks, aliases } = gathered;
  const sorted = sortGatheredUsers(users, latestTime, nicks, normalized, aliases);

  const exact = sorted.filter((u) => u.id === normalized || getUserSearchLabels(u, nicks, aliases).some((label) => label === normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Prefer exact username match if display names collided
    const exactUsername = exact.filter((u) => u.username.toLowerCase() === normalized);
    if (exactUsername.length === 1) return exactUsername[0];
    return exact[0];
  }

  const prefix = sorted.filter((u) => getUserSearchLabels(u, nicks, aliases).some((label) => label.startsWith(normalized)));
  if (prefix.length === 1) return prefix[0];

  const partial = sorted.filter((u) => getUserSearchLabels(u, nicks, aliases).some((label) => label.includes(normalized)));
  if (partial.length === 1) return partial[0];
  return null;
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
    ? users.filter((u) => u.id === queryLower || getUserSearchLabels(u, nicks, aliases).some((label) => label.includes(queryLower)))
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
  if (!nameQuery.trim().replace(/^@/, '')) return null;
  return matchUserInGathered(nameQuery, gatherScopeParticipants(scopeOrChannelId, guildId));
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

/**
 * Resolves user mentions (@username, <@id>, or unambiguous bare in-scope names) found in a prompt string.
 */
export function resolvePromptMentions(
  prompt: string,
  scopeOrChannelId?: CurrentScopeContext | string,
  guildId?: string,
): DiscordUser[] {
  if (!prompt || typeof prompt !== 'string') return [];

  const mentionedUsers: DiscordUser[] = [];
  const seenIds = new Set<string>();
  const gathered = gatherScopeParticipants(scopeOrChannelId, guildId);
  const { users, latestTime, nicks, aliases, participantIds } = gathered;
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
        resolved = matchUserInGathered(labelLower, gathered);
        if (resolved) break;
      }
    }
    if (!resolved) {
      resolved = matchUserInGathered(nameQuery, gathered);
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
