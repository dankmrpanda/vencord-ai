/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordMessage } from '../types';
import { fetchSurroundingMessages } from './messages';
import { filterMessagesToScope } from './scope';

/** Search hits whose neighbours are fetched; later hits keep only their own text. */
export const CONTEXT_HITS = 5;
/** Default messages kept on each side of a hit, and the most the model may ask for. */
export const DEFAULT_CONTEXT_MESSAGES = 3;
export const MAX_CONTEXT_MESSAGES = 5;
/** Context is a bonus: stop fetching it after this long so the search itself never times out. */
const CONTEXT_DEADLINE_MS = 12_000;

/** A message reduced to what a reader needs; raw Discord objects are ~1.5 KB each, mostly profile metadata. */
export interface SlimMessage {
  id: string;
  channel_id: string;
  author: string;
  author_id?: string;
  content: string;
  timestamp: string;
  edited?: true;
  pinned?: true;
  /** File names; for search hits also the URL and type, so inspect_image and voice transcription can use them. */
  attachments?: Array<string | { filename: string; url: string; content_type?: string }>;
  embeds?: Array<{ title?: string; description?: string; url?: string }>;
  reply_to?: string;
  voice_message?: true;
}

export interface SearchHitContext {
  hit_id: string;
  channel_id: string;
  /** The hit and its neighbours in time order; the hit is marked. */
  messages: Array<SlimMessage & { is_hit?: true }>;
}

export function slimMessage(message: DiscordMessage, detail: 'hit' | 'context' = 'context'): SlimMessage {
  const author = message.author as any;
  const raw = message as any;
  const hit = detail === 'hit';
  const slim: SlimMessage = {
    id: message.id,
    channel_id: message.channel_id,
    author: String(author?.global_name || author?.globalName || author?.username || 'unknown'),
    content: String(message.content || '').slice(0, hit ? 2000 : 500),
    timestamp: message.timestamp,
  };
  if (hit && author?.id) slim.author_id = String(author.id);
  if (raw.edited_timestamp) slim.edited = true;
  if (raw.pinned) slim.pinned = true;
  if ((message.flags ?? 0) & (1 << 13)) slim.voice_message = true;
  const attachments = (message.attachments || []).filter((a) => a?.filename);
  if (attachments.length) {
    slim.attachments = hit
      ? attachments.map((a) => ({ filename: a.filename, url: a.url, ...(a.content_type ? { content_type: a.content_type } : {}) }))
      : attachments.map((a) => a.filename);
  }
  const embeds = (raw.embeds || []).filter((e: any) => e && (e.title || e.description || e.url));
  if (hit && embeds.length) {
    slim.embeds = embeds.slice(0, 3).map((e: any) => ({
      ...(e.title ? { title: String(e.title).slice(0, 200) } : {}),
      ...(e.description ? { description: String(e.description).slice(0, 300) } : {}),
      ...(e.url ? { url: String(e.url) } : {}),
    }));
  }
  const replyTo = raw.message_reference?.message_id;
  if (typeof replyTo === 'string') slim.reply_to = replyTo;
  return slim;
}

type Fetcher = (channelId: string, messageId: string, limit: number, signal?: AbortSignal) => Promise<DiscordMessage[]>;

/**
 * Fetches the conversation around the top search hits so the model can tell what each hit was replying to. Windows
 * are read one at a time (Discord rate-limits reads), filtered to the scope, and deduplicated: a message already shown
 * in an earlier window is not repeated, and a hit already inside an earlier window gets no window of its own.
 */
export async function fetchSearchContext(
  hits: DiscordMessage[],
  scope: CurrentScopeContext,
  options: { perSide?: number; signal?: AbortSignal; fetcher?: Fetcher; now?: () => number } = {},
): Promise<{ context: SearchHitContext[]; skipped: number }> {
  const perSide = Math.min(Math.max(Math.floor(options.perSide ?? DEFAULT_CONTEXT_MESSAGES), 0), MAX_CONTEXT_MESSAGES);
  if (!perSide || !hits.length) return { context: [], skipped: 0 };
  const fetcher = options.fetcher || fetchSurroundingMessages;
  const now = options.now || Date.now;
  const started = now();
  const shown = new Set<string>();
  const context: SearchHitContext[] = [];
  let skipped = 0;

  for (const hit of hits.slice(0, CONTEXT_HITS)) {
    if (shown.has(hit.id)) continue;
    if (now() - started > CONTEXT_DEADLINE_MS) { skipped++; continue; }
    options.signal?.throwIfAborted();
    let window: DiscordMessage[];
    try {
      window = await fetcher(hit.channel_id, hit.id, perSide * 2 + 1, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      skipped++;
      continue;
    }
    const scoped = filterMessagesToScope(window, scope).filter((m) => m.channel_id === hit.channel_id);
    const ordered = [...scoped].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const index = ordered.findIndex((m) => m.id === hit.id);
    const around = index === -1 ? ordered : ordered.slice(Math.max(0, index - perSide), index + perSide + 1);
    const fresh = around.filter((m) => m.id === hit.id || !shown.has(m.id));
    if (fresh.length <= 1) continue;
    fresh.forEach((m) => shown.add(m.id));
    context.push({
      hit_id: hit.id,
      channel_id: hit.channel_id,
      // The hit's full text is already in data.messages; here it is only a position marker.
      messages: fresh.map((m) => (m.id === hit.id ? { ...slimMessage(m), content: '(this hit)', is_hit: true as const } : slimMessage(m))),
    });
  }
  return { context, skipped };
}
