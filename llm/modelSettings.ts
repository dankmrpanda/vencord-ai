/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginSettings } from '../types';

const resolutions = new Map<string, { pending: Promise<string>; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 32;

/** Resolve repository names to server IDs without guessing a different model. */
export async function resolveModelIdentifier(settings: PluginSettings): Promise<string> {
  const model = (settings.model || '').trim() || 'default';
  if (settings.providerPreset !== 'omlx' || !model.includes('/')) return model;
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '');
  const key = JSON.stringify([baseUrl, settings.apiKey, model]);
  const now = Date.now();
  for (const [cachedKey, cached] of resolutions) {
    if (cached.expiresAt <= now) resolutions.delete(cachedKey);
  }
  const cached = resolutions.get(key);
  if (cached) return cached.pending;

  const pending = (async () => {
    const response = await fetch(`${baseUrl}/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Could not resolve the omlx model identifier (HTTP ${response.status}). Set Model Identifier to the exact ID returned by the server's /v1/models endpoint.`);
    }
    const result = await response.json();
    const ids: string[] = Array.isArray(result?.data)
      ? result.data.flatMap((item: any) => typeof item?.id === 'string' ? [item.id] : [])
      : [];
    if (ids.includes(model)) return model;
    const basename = model.split('/').pop();
    const matches = [...new Set(ids.filter((id) => id.split('/').pop() === basename))];
    if (matches.length === 1) return matches[0];
    throw new Error(`The omlx model identifier "${model}" ${matches.length ? 'matches multiple models' : 'was not found'}. Set Model Identifier to an exact ID from the server's /v1/models list.`);
  })();
  if (resolutions.size >= MAX_CACHE_ENTRIES) resolutions.delete(resolutions.keys().next().value!);
  const entry = { pending, expiresAt: now + CACHE_TTL_MS };
  resolutions.set(key, entry);
  try {
    return await pending;
  } catch (error) {
    if (resolutions.get(key) === entry) resolutions.delete(key);
    throw error;
  }
}
