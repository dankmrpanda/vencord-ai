/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordMessage } from '../types';
import { isChannelAllowedInScope } from './scope';
import { getChannel, getUser } from './stores';

export type SlimMessageDetail = 'context' | 'hit' | 'detail';

/** A message reduced to what a reader needs; raw Discord objects are ~1.5 KB each, mostly profile metadata. */
export interface SlimMessage {
  id: string;
  channel_id: string;
  channel_name?: string;
  author: string;
  author_id?: string;
  bot?: true;
  content: string;
  timestamp: any;
  edited?: true;
  edited_timestamp?: any;
  pinned?: true;
  /** File names; for search hits/details also the URL, type, and alt-text description. */
  attachments?: Array<string | { filename: string; url: string; content_type?: string; description?: string }>;
  embeds?: Array<{
    author?: string;
    title?: string;
    description?: string;
    url?: string;
    fields?: Array<{ name: string; value: string }>;
    footer?: string;
    image_url?: string;
  }>;
  reply_to?: string;
  reply_preview?: { id: string; author: string; snippet: string };
  reactions?: string[];
  poll?: { question: string; answers: string[] };
  forwarded?: Array<{
    content: string;
    attachments?: string[];
    embeds?: Array<{ title?: string; description?: string; url?: string }>;
  }>;
  thread?: { id: string; name?: string; message_count?: number };
  voice_message?: true;
  is_target?: true;
}

/**
 * Concatenates searchable text from a Discord message: content, attachment filenames/descriptions,
 * embed author/title/description/fields/footer, and forwarded message snapshots.
 */
export function extractMessageSearchText(msg: DiscordMessage): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (a?.filename) parts.push(a.filename);
      if (a?.description) parts.push(a.description);
    }
  }
  if (Array.isArray(msg.embeds)) {
    for (const e of msg.embeds) {
      if (!e) continue;
      if (e.author?.name) parts.push(e.author.name);
      if (e.title) parts.push(e.title);
      if (e.description) parts.push(e.description);
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f?.name) parts.push(f.name);
          if (f?.value) parts.push(f.value);
        }
      }
      if (e.footer?.text) parts.push(e.footer.text);
    }
  }
  if (Array.isArray(msg.message_snapshots)) {
    for (const snap of msg.message_snapshots) {
      const inner = snap?.message;
      if (!inner) continue;
      if (inner.content) parts.push(inner.content);
      if (Array.isArray(inner.attachments)) {
        for (const a of inner.attachments) {
          if (a?.filename) parts.push(a.filename);
        }
      }
      if (Array.isArray(inner.embeds)) {
        for (const e of inner.embeds) {
          if (e?.title) parts.push(e.title);
          if (e?.description) parts.push(e.description);
        }
      }
    }
  }
  return parts.join(' ');
}

function authorDisplayName(author: any): string {
  return String(author?.global_name || author?.globalName || author?.username || 'unknown');
}

/**
 * Replaces raw Discord user mentions (<@123>) with @DisplayName and in-scope channel mentions (<#123>)
 * with #channelName. Out-of-scope channel IDs are left untouched (fail-closed).
 */
export function resolveReadableContent(
  content: string,
  message?: Partial<DiscordMessage>,
  scope?: CurrentScopeContext,
): string {
  if (!content) return '';
  const messageMentions = Array.isArray(message?.mentions) ? message!.mentions : [];
  let resolved = content.replace(/<@!?(\d{1,22})>/g, (raw, id: string) => {
    const mentioned = messageMentions.find((u: any) => u && typeof u === 'object' && u.id === id);
    const user = mentioned || getUser(id);
    if (!user) return raw;
    const name = (user as any).global_name || user.globalName || user.username;
    return name ? `@${name}` : raw;
  });
  if (scope) {
    resolved = resolved.replace(/<#(\d{1,22})>/g, (raw, id: string) => {
      if (!isChannelAllowedInScope(id, scope)) return raw;
      const fromScope =
        scope.accessibleGuildChannels?.find((c) => c.id === id)?.name ||
        scope.mutualGroupDMs?.find((g) => g.id === id)?.name ||
        (id === scope.channelId ? scope.channelName : undefined);
      const name = fromScope || getChannel(id)?.name;
      return name ? `#${String(name).replace(/^#/, '')}` : raw;
    });
  }
  return resolved;
}

function resolveChannelNameForMessage(channelId: string, scope?: CurrentScopeContext): string | undefined {
  if (!scope || !channelId) return undefined;
  const multiChannel =
    scope.scopeMode === 'server' ||
    scope.scopeMode === 'custom' ||
    Boolean(scope.includeMutualGroupDMs) ||
    (scope.explicitMutualGroupDMIds?.length ?? 0) > 0;
  if (!multiChannel && channelId === scope.channelId) return undefined;
  if (!isChannelAllowedInScope(channelId, scope)) return undefined;
  if (channelId === scope.channelId) return scope.channelName;
  return (
    scope.accessibleGuildChannels?.find((c) => c.id === channelId)?.name ||
    scope.mutualGroupDMs?.find((g) => g.id === channelId)?.name ||
    getChannel(channelId)?.name ||
    undefined
  );
}

export function slimMessage(
  message: DiscordMessage,
  detail: SlimMessageDetail = 'context',
  scope?: CurrentScopeContext,
): SlimMessage {
  const author = message.author as any;
  const raw = message as any;
  const full = detail === 'hit' || detail === 'detail';
  const maxContent = detail === 'detail' ? 3000 : detail === 'hit' ? 2000 : 500;
  const slim: SlimMessage = {
    id: message.id,
    channel_id: message.channel_id,
    author: authorDisplayName(author),
    content: resolveReadableContent(String(message.content || ''), message, scope).slice(0, maxContent),
    // Keep timestamp verbatim so Date / moment objects preserve JSON.stringify toJSON semantics.
    timestamp: message.timestamp,
  };
  const channelName = resolveChannelNameForMessage(message.channel_id, scope);
  if (channelName) slim.channel_name = channelName;
  if (full && author?.id) slim.author_id = String(author.id);
  if (author?.bot) slim.bot = true;
  if (raw.edited_timestamp) {
    slim.edited = true;
    slim.edited_timestamp = raw.edited_timestamp;
  }
  if (raw.pinned) slim.pinned = true;
  if ((message.flags ?? 0) & (1 << 13)) slim.voice_message = true;

  const attachments = (message.attachments || []).filter((a) => a?.filename);
  if (attachments.length) {
    slim.attachments = full
      ? attachments.map((a) => ({
          filename: a.filename,
          url: a.url,
          ...(a.content_type ? { content_type: a.content_type } : {}),
          ...(a.description ? { description: String(a.description).slice(0, 200) } : {}),
        }))
      : attachments.map((a) => a.filename);
  }

  const embeds = (raw.embeds || []).filter((e: any) => e && (e.title || e.description || e.url || e.fields?.length || e.author?.name));
  if (embeds.length) {
    if (full) {
      slim.embeds = embeds.slice(0, 3).map((e: any) => {
        const entry: NonNullable<SlimMessage['embeds']>[number] = {};
        if (e.author?.name) entry.author = String(e.author.name).slice(0, 100);
        if (e.title) entry.title = String(e.title).slice(0, 200);
        if (e.description) entry.description = String(e.description).slice(0, detail === 'detail' ? 600 : 350);
        if (e.url) entry.url = String(e.url);
        if (Array.isArray(e.fields) && e.fields.length) {
          const fields = e.fields
            .slice(0, 6)
            .filter((f: any) => f && (f.name || f.value))
            .map((f: any) => ({
              name: String(f.name || '').slice(0, 100),
              value: String(f.value || '').slice(0, 200),
            }));
          if (fields.length) entry.fields = fields;
        }
        if (e.footer?.text) entry.footer = String(e.footer.text).slice(0, 120);
        if (e.image?.url) entry.image_url = String(e.image.url);
        return entry;
      });
    } else {
      slim.embeds = embeds.slice(0, 2).map((e: any) => ({
        ...(e.title ? { title: String(e.title).slice(0, 120) } : {}),
        ...(e.url ? { url: String(e.url) } : {}),
      }));
    }
  }

  const replyTo = raw.message_reference?.message_id;
  if (typeof replyTo === 'string') slim.reply_to = replyTo;

  const ref = raw.referenced_message as DiscordMessage | null | undefined;
  if (ref && ref.id) {
    const refChannel = ref.channel_id || message.channel_id;
    if (!scope || isChannelAllowedInScope(refChannel, scope)) {
      slim.reply_preview = {
        id: ref.id,
        author: authorDisplayName(ref.author),
        snippet: resolveReadableContent(String(ref.content || ''), ref, scope).slice(0, 140),
      };
    }
  }

  if (Array.isArray(raw.reactions) && raw.reactions.length) {
    const reactions = raw.reactions
      .slice(0, 8)
      .map((r: any) => {
        const label = r?.emoji?.id ? `:${r.emoji.name || 'emoji'}:` : r?.emoji?.name;
        const count = Number(r?.count);
        return label && Number.isFinite(count) && count > 0 ? `${label} x${count}` : '';
      })
      .filter(Boolean);
    if (reactions.length) slim.reactions = reactions;
  }

  if (raw.poll?.question?.text) {
    slim.poll = {
      question: String(raw.poll.question.text).slice(0, 200),
      answers: Array.isArray(raw.poll.answers)
        ? raw.poll.answers.slice(0, 10).map((a: any) => String(a?.poll_media?.text || '').slice(0, 100)).filter(Boolean)
        : [],
    };
  }

  if (Array.isArray(raw.message_snapshots) && raw.message_snapshots.length) {
    const forwarded = raw.message_snapshots
      .slice(0, 2)
      .map((snap: any) => snap?.message)
      .filter(Boolean)
      .map((inner: any) => {
        const snapEmbeds = Array.isArray(inner.embeds)
          ? inner.embeds.slice(0, 2).map((e: any) => ({
              ...(e?.title ? { title: String(e.title).slice(0, 150) } : {}),
              ...(e?.description ? { description: String(e.description).slice(0, 250) } : {}),
              ...(e?.url ? { url: String(e.url) } : {}),
            }))
          : [];
        const snapAttachments = Array.isArray(inner.attachments)
          ? inner.attachments.map((a: any) => a?.filename).filter(Boolean)
          : [];
        return {
          content: resolveReadableContent(String(inner.content || ''), inner, scope).slice(0, 500),
          ...(snapAttachments.length ? { attachments: snapAttachments } : {}),
          ...(snapEmbeds.length ? { embeds: snapEmbeds } : {}),
        };
      });
    if (forwarded.length) slim.forwarded = forwarded;
  }

  if (raw.thread?.id) {
    slim.thread = {
      id: String(raw.thread.id),
      ...(raw.thread.name ? { name: String(raw.thread.name).slice(0, 100) } : {}),
      ...(raw.thread.message_count !== undefined ? { message_count: Number(raw.thread.message_count) } : {}),
    };
  }

  return slim;
}
