/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { assertReadOnlyOperation } from './guardrails';
import { getAuthToken, getHTTP } from './stores';

export const DISCORD_EPOCH = 1420070400000n;

/** Longest retry_after honoured; longer rate limits fail so callers fall back instead of stalling. */
export const MAX_RETRY_AFTER_SECONDS = 5;

/** Discord numeric snowflakes are decimal; anything else must never be interpolated into a REST path. */
export const SNOWFLAKE_PATTERN = /^\d{1,22}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Discord request aborted.'), { name: 'AbortError' });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parses a Retry-After/retry_after value in seconds; unparseable values fall back to 2 s. */
export function parseRetryAfterSeconds(value: unknown): number {
  const sec = Number(value);
  return Number.isFinite(sec) ? Math.max(sec, 1) : 2;
}

export function extractRetryAfterSeconds(target: any, includeAccepted202 = false): number | null {
  if (!target) return null;
  const status = target.status ?? target.statusCode;
  const retryVal = target.headers?.get?.('Retry-After') ?? target.body?.retry_after ?? target.retry_after;
  if (retryVal) return parseRetryAfterSeconds(retryVal);
  if (status === 429 || (includeAccepted202 && status === 202)) {
    return 2;
  }
  return null;
}

export interface DiscordGetOptions {
  signal?: AbortSignal;
  retries?: number;
  retryPadMs?: number;
  fallbackToFetchOnHttpError?: boolean;
}

/**
 * Performs one read-only Discord REST GET via `RestAPI.get` or `fetch`.
 * Enforces `assertReadOnlyOperation('GET', path)` and honours `AbortSignal` before fallback.
 */
export async function discordGetOnce<T = any>(
  path: string,
  query: Record<string, string> = {},
  options: Pick<DiscordGetOptions, 'signal' | 'fallbackToFetchOnHttpError'> = {},
): Promise<T> {
  const { signal, fallbackToFetchOnHttpError = false } = options;
  assertReadOnlyOperation('GET', path);
  throwIfAborted(signal);

  const http = getHTTP();
  if (http && typeof http.get === 'function') {
    try {
      const response = await http.get({ url: path, query });
      return (response?.body ?? response) as T;
    } catch (err: any) {
      if (signal?.aborted) throw err;
      const isRateLimit = extractRetryAfterSeconds(err) !== null;
      if (!fallbackToFetchOnHttpError || isRateLimit) {
        throw err;
      }
      console.warn('[VencordAI] RestAPI.get failed, falling back to fetch:', err);
    }
  }

  const suffix = new URLSearchParams(query).toString();
  const response = await fetch(`https://discord.com/api/v9${path}${suffix ? `?${suffix}` : ''}`, {
    headers: {
      Authorization: getAuthToken() || '',
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    let parsedBody: any;
    try { parsedBody = JSON.parse(errorText); } catch {}
    const err: any = new Error(`Discord read failed (${response.status}): ${errorText}`);
    err.status = response.status;
    err.headers = response.headers;
    if (parsedBody && typeof parsedBody === 'object') err.body = parsedBody;
    throw err;
  }

  return response.json() as Promise<T>;
}

/**
 * Read-only Discord GET with bounded 429 handling: waits end when `signal` aborts, and a
 * `retry_after` above `MAX_RETRY_AFTER_SECONDS` fails immediately instead of stalling.
 */
export async function discordGet<T = any>(
  path: string,
  query: Record<string, string> = {},
  options: DiscordGetOptions = {},
): Promise<T> {
  const { signal, retries = 3, retryPadMs = 300, fallbackToFetchOnHttpError = false } = options;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await discordGetOnce<T>(path, query, { signal, fallbackToFetchOnHttpError });
    } catch (err: any) {
      if (signal?.aborted) throw err;
      const retrySec = extractRetryAfterSeconds(err);
      if (retrySec !== null && retrySec <= MAX_RETRY_AFTER_SECONDS && attempt < retries) {
        console.warn(`[VencordAI] Discord 429 rate limit on ${path}, retrying after ${retrySec}s...`);
        await abortableSleep(retrySec * 1000 + retryPadMs, signal);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Discord read failed on ${path}.`);
}

/**
 * Reads one message the way a user account can. `GET /channels/{c}/messages/{id}` is bot-only (user accounts get
 * 403), so this asks for the single message around the ID and keeps it only when the ID matches.
 */
export async function fetchOneMessage(
  channelId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<DiscordMessage | undefined> {
  if (!channelId || /[/?#\\]|\.\./.test(channelId) || !isSnowflake(messageId)) return undefined;
  const page = await discordGet<DiscordMessage[]>(
    `/channels/${channelId}/messages`,
    { around: messageId, limit: '1' },
    { signal },
  );
  return Array.isArray(page) ? page.find((message: DiscordMessage | undefined) => message?.id === messageId) : undefined;
}
