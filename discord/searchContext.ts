/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext, DiscordMessage } from '../types';
import { SlimMessage, slimMessage } from './messageFormat';
import { fetchSurroundingMessages } from './messages';
import { filterMessagesToScope } from './scope';

/** Search hits whose neighbours are fetched; later hits keep only their own text. */
export const CONTEXT_HITS = 5;
/** Default messages kept on each side of a hit, and the most the model may ask for. */
export const DEFAULT_CONTEXT_MESSAGES = 3;
export const MAX_CONTEXT_MESSAGES = 5;
/** Context is a bonus: stop fetching it after this long so the search itself never times out. */
const CONTEXT_DEADLINE_MS = 12_000;

export interface SearchHitContext {
  hit_id: string;
  channel_id: string;
  /** The hit and its neighbours in time order; the hit is marked. */
  messages: Array<SlimMessage & { is_hit?: true }>;
}

type Fetcher = (channelId: string, messageId: string, limit: number, signal?: AbortSignal) => Promise<DiscordMessage[]>;

function hasSufficientEmbeddedNeighbours(
  group: DiscordMessage[] | undefined,
  hit: DiscordMessage,
  perSide: number,
  scope: CurrentScopeContext,
): boolean {
  if (!group || group.length <= 1) return false;
  const scoped = filterMessagesToScope(group, scope).filter((m) => m.channel_id === hit.channel_id);
  const ordered = [...scoped].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const idx = ordered.findIndex((m) => m.id === hit.id);
  if (idx === -1) return false;
  const neededSide = Math.min(perSide, 1);
  return (idx >= neededSide && ordered.length - 1 - idx >= neededSide) || ordered.length >= perSide * 2 + 1;
}

/**
 * Fetches the conversation around the top search hits so the model can tell what each hit was replying to. Windows
 * are read one at a time (Discord rate-limits reads), filtered to the scope, and deduplicated: a message already shown
 * in an earlier window is not repeated, and a hit already inside an earlier window gets no window of its own.
 */
export async function fetchSearchContext(
  hits: DiscordMessage[],
  scope: CurrentScopeContext,
  options: {
    perSide?: number;
    signal?: AbortSignal;
    fetcher?: Fetcher;
    now?: () => number;
    embeddedContext?: Map<string, DiscordMessage[]>;
  } = {},
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
    const embedded = options.embeddedContext?.get(hit.id);
    if (hasSufficientEmbeddedNeighbours(embedded, hit, perSide, scope)) {
      window = embedded!;
    } else {
      try {
        window = await fetcher(hit.channel_id, hit.id, perSide * 2 + 1, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        skipped++;
        continue;
      }
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
      messages: fresh.map((m) => (m.id === hit.id
        ? { ...slimMessage(m, 'context', scope), content: '(this hit)', is_hit: true as const }
        : slimMessage(m, 'context', scope))),
    });
  }
  return { context, skipped };
}
