/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType, CurrentScopeContext, DiscordChannel, DiscordMessage } from '../types';
import { getPermissionStore } from './stores';

/**
 * Discord Permissions Bitfield: VIEW_CHANNEL (1 << 10 = 1024n)
 */
export const VIEW_CHANNEL_PERMISSION = 1024n;
export const VIEW_CHANNEL_PERMISSION_NUM = 1024;

/**
 * Set of channel types that are valid readable text channels.
 */
export const PERMITTED_TEXT_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GUILD_TEXT,
  ChannelType.GUILD_ANNOUNCEMENT,
  ChannelType.ANNOUNCEMENT_THREAD,
  ChannelType.PUBLIC_THREAD,
  ChannelType.PRIVATE_THREAD,
  ChannelType.GUILD_FORUM,
  ChannelType.GUILD_MEDIA,
  ChannelType.DM,
  ChannelType.GROUP_DM,
]);

/**
 * Disallowed channel types (voice, stage, directory, category).
 */
export const BLOCKED_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GUILD_VOICE,
  ChannelType.GUILD_STAGE_VOICE,
  ChannelType.GUILD_CATEGORY,
  ChannelType.GUILD_DIRECTORY,
]);

/**
 * Result of a scope boundary validation check.
 */
export interface ScopeValidationResult {
  allowed: boolean;
  reason?:
    | 'active_channel'
    | 'accessible_guild_channel'
    | 'explicit_mutual_group_dm'
    | 'active_group_dm'
    | 'unpermitted_channel'
    | 'external_guild'
    | 'dm_boundary_isolation'
    | 'invalid_channel_type'
    | 'missing_context';
}

/**
 * Validates channel view permission fail-closed.
 * Returns true ONLY if permissionStore explicitly confirms 1024n VIEW_CHANNEL permission.
 */
export function validateChannelPermission(
  channel: DiscordChannel,
  permissionStore: any = getPermissionStore(),
): boolean {
  if (!channel || !channel.id) return false;

  // DMs and Group DMs don't use Guild PermissionStore
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM) {
    return true;
  }

  // Non-text / blocked channel types fail immediately
  if (BLOCKED_CHANNEL_TYPES.has(channel.type)) {
    return false;
  }

  // Must be a permitted text channel type
  if (!PERMITTED_TEXT_CHANNEL_TYPES.has(channel.type)) {
    return false;
  }

  // Permission store discovery must fail closed
  if (!permissionStore || typeof permissionStore.can !== 'function') {
    return false;
  }

  try {
    const bigintResult = permissionStore.can(VIEW_CHANNEL_PERMISSION, channel);
    if (bigintResult !== undefined && bigintResult !== null) {
      return Boolean(bigintResult);
    }
  } catch {}

  try {
    const numResult = permissionStore.can(VIEW_CHANNEL_PERMISSION_NUM, channel);
    return Boolean(numResult);
  } catch {
    return false;
  }
}

/**
 * Validates whether a target channel ID is allowed in the current scope context.
 */
export function validateScopeBoundary(
  targetChannelId: string,
  context?: CurrentScopeContext | null,
): ScopeValidationResult {
  if (!context || !targetChannelId) {
    return { allowed: false, reason: 'missing_context' };
  }

  // 1. Active channel is always permitted
  if (targetChannelId === context.channelId) {
    return { allowed: true, reason: 'active_channel' };
  }

  // 2. Guild scope: channel must belong to current guild and be in accessibleGuildChannels
  if (context.isGuild && context.guildId) {
    if (context.scopeMode === 'channel') {
      return { allowed: false, reason: 'unpermitted_channel' };
    }
    if (context.scopeMode === 'custom') {
      const isSelected = context.selectedChannelIds?.includes(targetChannelId);
      const isAccessible = context.accessibleGuildChannels?.some((c) => c.id === targetChannelId);
      if (isSelected && isAccessible) {
        return { allowed: true, reason: 'accessible_guild_channel' };
      }
      return { allowed: false, reason: 'unpermitted_channel' };
    }
    const isAccessible = context.accessibleGuildChannels?.some((c) => c.id === targetChannelId);
    if (isAccessible) {
      return { allowed: true, reason: 'accessible_guild_channel' };
    }
    return { allowed: false, reason: 'unpermitted_channel' };
  }

  // 3. 1-on-1 DM scope: only explicitly requested mutual group DMs or enabled mutual group DMs are allowed
  if (context.isDM) {
    const isAllowedMutual = Boolean(
      (context.includeMutualGroupDMs || context.explicitMutualGroupDMIds?.includes(targetChannelId)) &&
      context.mutualGroupDMs?.some((g) => g.id === targetChannelId)
    );
    if (isAllowedMutual) {
      return { allowed: true, reason: 'explicit_mutual_group_dm' };
    }
    return { allowed: false, reason: 'dm_boundary_isolation' };
  }

  // 4. Group DM scope: only the active group DM is allowed
  if (context.isGroupDM) {
    return { allowed: false, reason: 'dm_boundary_isolation' };
  }

  return { allowed: false, reason: 'unpermitted_channel' };
}

/**
 * Zero-Mutation Assurance: Enforces that HTTP methods and endpoints are strictly read-only.
 */
export class MutationSecurityError extends Error {
  constructor(message: string) {
    super(`[Security Guardrail Violation] ${message}`);
    this.name = 'MutationSecurityError';
  }
}

export function assertReadOnlyOperation(method: string, endpoint: string): void {
  const normalizedMethod = (method || 'GET').trim().toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    throw new MutationSecurityError(
      `Forbidden HTTP method '${normalizedMethod}' for endpoint '${endpoint}'. Only read-only operations are permitted.`,
    );
  }

  // Block mutation paths
  const blockedPatterns = [
    /\/messages\/?$/i,           // POST message
    /\/reactions\//i,             // PUT reaction
    /\/pins\//i,                  // PUT/DELETE pin
    /\/channels\/?$/i,            // POST channel
    /\/permissions\//i,           // PUT permission
    /\/typing\/?$/i,              // POST typing
  ];

  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && blockedPatterns.some((pattern) => pattern.test(endpoint))) {
    throw new MutationSecurityError(`Endpoint '${endpoint}' is a mutating Discord API route and is blocked.`);
  }
}

/**
 * Sanitizes untrusted message content, stripping dangerous control characters,
 * bidirectional Unicode overrides, and neutralizing LLM injection sequences.
 */
export function sanitizeUntrustedContent(text?: string | null): string {
  if (!text || typeof text !== 'string') return '';

  return text
    // 1. Remove null bytes and unprintable control characters (except newline, carriage return, tab)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 2. Remove Unicode directional formatting overrides (Trojan Source attacks: U+202A to U+202E, U+200E, U+200F, U+2066-U+2069)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    // 3. Neutralize LLM special tokens / prompt hijacking markers
    .replace(/<\|im_start\|>/gi, '[im_start]')
    .replace(/<\|im_end\|>/gi, '[im_end]')
    .replace(/<\|system\|>/gi, '[system]')
    .replace(/<\|user\|>/gi, '[user]')
    .replace(/<\|assistant\|>/gi, '[assistant]')
    .replace(/\[INST\]/gi, '[INST_TAG]')
    .replace(/\[\/INST\]/gi, '[/INST_TAG]')
    .replace(/<<SYS>>/gi, '<<SYS_TAG>>')
    .replace(/<\/SYS>>/gi, '<</SYS_TAG>>')
    .replace(/^(\s*#{1,6}\s*(?:system|instructions|override|admin))/gim, '> $1')
    .trim();
}

/**
 * Wraps untrusted Discord evidence inside structured XML boundary tags with metadata.
 */
export function formatUntrustedEvidence(
  message: DiscordMessage,
  channelName?: string,
): string {
  const cleanContent = sanitizeUntrustedContent(message.content);
  const cleanAuthor = sanitizeUntrustedContent(message.author?.globalName || message.author?.username || 'Unknown');
  const cleanChannel = sanitizeUntrustedContent(channelName || message.channel_id);
  const timestamp = message.timestamp || new Date().toISOString();

  const attachments = (message.attachments || [])
    .map((a) => sanitizeUntrustedContent(a.filename))
    .filter(Boolean)
    .join(', ');

  const embeds = (message.embeds || [])
    .map((e) => `${sanitizeUntrustedContent(e.title || '')} ${sanitizeUntrustedContent(e.description || '')}`.trim())
    .filter(Boolean)
    .join(' | ');

  const metaParts: string[] = [
    `id="${message.id}"`,
    `channel="${cleanChannel}"`,
    `channel_id="${message.channel_id}"`,
    `author="${cleanAuthor}"`,
    `timestamp="${timestamp}"`,
    `untrusted="true"`,
  ];

  let body = cleanContent;
  if (attachments) body += `\n[Attachments: ${attachments}]`;
  if (embeds) body += `\n[Embeds: ${embeds}]`;

  return `<discord_evidence ${metaParts.join(' ')}>\n${body}\n</discord_evidence>`;
}
