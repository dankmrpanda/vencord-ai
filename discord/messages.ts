/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { getAuthToken, getHTTP, getLoadedMessages } from './stores';

export interface LocalMessageFilter {
  query?: string;
  has?: 'image' | 'sound' | 'video' | 'file' | 'link' | 'embed' | 'sticker';
  authorId?: string;
  beforeDate?: string | Date;
  afterDate?: string | Date;
  duringDate?: string | Date;
}

/**
 * Filters a list of Discord messages locally according to search criteria
 */
export function filterMessagesLocally(
  messages: DiscordMessage[],
  filter: LocalMessageFilter
): DiscordMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const queryLower = filter.query?.trim().toLowerCase();

  return messages.filter((msg) => {
    if (!msg) return false;

    // Filter by author ID
    if (filter.authorId && msg.author?.id !== filter.authorId) {
      return false;
    }

    // Filter by date range
    if (filter.duringDate) {
      const targetDate = new Date(filter.duringDate).toISOString().slice(0, 10);
      const msgDate = new Date(msg.timestamp).toISOString().slice(0, 10);
      if (targetDate !== msgDate) return false;
    }
    if (filter.afterDate) {
      const afterTime = new Date(filter.afterDate).getTime();
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime < afterTime) return false;
    }
    if (filter.beforeDate) {
      const beforeTime = new Date(filter.beforeDate).getTime();
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime > beforeTime) return false;
    }

    // Filter by 'has' media type
    if (filter.has) {
      switch (filter.has) {
        case 'link': {
          const hasUrlInContent = /https?:\/\/[^\s]+/i.test(msg.content || '');
          const hasUrlInEmbeds = Boolean(msg.embeds?.some((e) => e.url || e.title || e.description));
          if (!hasUrlInContent && !hasUrlInEmbeds) return false;
          break;
        }
        case 'file': {
          if (!msg.attachments || msg.attachments.length === 0) return false;
          break;
        }
        case 'image': {
          const hasImgAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('image/') ||
              /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(a.filename || a.url || '')
          );
          const hasImgEmbed = msg.embeds?.some((e) => Boolean(e.image || e.thumbnail));
          if (!hasImgAttachment && !hasImgEmbed) return false;
          break;
        }
        case 'video': {
          const hasVideoAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('video/') ||
              /\.(mp4|webm|mov|mkv|avi)$/i.test(a.filename || a.url || '')
          );
          const hasVideoEmbed = msg.embeds?.some((e) => e.type === 'video');
          if (!hasVideoAttachment && !hasVideoEmbed) return false;
          break;
        }
        case 'sound': {
          const hasSoundAttachment = msg.attachments?.some(
            (a) =>
              a.content_type?.startsWith('audio/') ||
              /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(a.filename || a.url || '')
          );
          if (!hasSoundAttachment) return false;
          break;
        }
        case 'embed': {
          if (!msg.embeds || msg.embeds.length === 0) return false;
          break;
        }
      }
    }

    // Filter by query keyword
    if (queryLower) {
      const contentMatch = msg.content?.toLowerCase().includes(queryLower);
      const attachmentMatch = msg.attachments?.some((a) =>
        a.filename?.toLowerCase().includes(queryLower)
      );
      const embedMatch = msg.embeds?.some(
        (e) =>
          e.title?.toLowerCase().includes(queryLower) ||
          e.description?.toLowerCase().includes(queryLower)
      );
      const authorMatch =
        msg.author?.username?.toLowerCase().includes(queryLower) ||
        msg.author?.globalName?.toLowerCase().includes(queryLower);

      if (!contentMatch && !attachmentMatch && !embedMatch && !authorMatch) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Fetches messages around a specific message ID to provide conversational context
 */
export async function fetchSurroundingMessages(
  channelId: string,
  messageId: string,
  limit: number = 10
): Promise<DiscordMessage[]> {
  const http = getHTTP();
  const relativeEndpoint = `/channels/${channelId}/messages`;
  const queryObj = { around: messageId, limit: String(Math.min(limit, 50)) };

  try {
    let messages: DiscordMessage[] = [];
    if (http && typeof http.get === 'function') {
      try {
        const res = await http.get({ url: relativeEndpoint, query: queryObj });
        messages = res?.body ?? res;
      } catch (httpErr) {
        console.warn('[VencordAI] RestAPI.get failed for surrounding messages, falling back to fetch:', httpErr);
      }
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      const token = getAuthToken();
      const qs = new URLSearchParams(queryObj).toString();
      const fullUrl = `https://discord.com/api/v9${relativeEndpoint}?${qs}`;
      const response = await fetch(fullUrl, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) {
        messages = await response.json();
      }
    }

    // Sort chronologically (oldest first)
    if (Array.isArray(messages)) {
      return [...messages].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }
    return [];
  } catch (err) {
    console.error(`[VencordAI] Error fetching surrounding messages for channel ${channelId}:`, err);
    return [];
  }
}

/**
 * Fetches the latest N messages from a channel, integrating local MessageStore cache and REST API
 */
export async function fetchRecentMessages(
  channelId: string,
  limit: number = 25
): Promise<DiscordMessage[]> {
  const loadedFromCache = getLoadedMessages(channelId);
  const http = getHTTP();
  const relativeEndpoint = `/channels/${channelId}/messages`;
  const queryObj = { limit: String(Math.min(limit, 50)) };

  try {
    let fetchedMessages: DiscordMessage[] = [];
    if (http && typeof http.get === 'function') {
      try {
        const res = await http.get({ url: relativeEndpoint, query: queryObj });
        fetchedMessages = res?.body ?? res;
      } catch (httpErr) {
        console.warn('[VencordAI] RestAPI.get failed for recent messages, trying fetch:', httpErr);
      }
    }

    if (!Array.isArray(fetchedMessages) || fetchedMessages.length === 0) {
      const token = getAuthToken();
      const qs = new URLSearchParams(queryObj).toString();
      const fullUrl = `https://discord.com/api/v9${relativeEndpoint}?${qs}`;
      const response = await fetch(fullUrl, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) {
        fetchedMessages = await response.json();
      }
    }

    const combinedMap = new Map<string, DiscordMessage>();
    if (Array.isArray(loadedFromCache)) {
      loadedFromCache.forEach((m) => m && m.id && combinedMap.set(m.id, m));
    }
    if (Array.isArray(fetchedMessages)) {
      fetchedMessages.forEach((m) => m && m.id && combinedMap.set(m.id, m));
    }

    const allMessages = Array.from(combinedMap.values());
    if (allMessages.length > 0) {
      return allMessages
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-limit);
    }

    return [];
  } catch (err) {
    console.error(`[VencordAI] Error fetching recent messages for channel ${channelId}:`, err);
    return Array.isArray(loadedFromCache) ? loadedFromCache.slice(-limit) : [];
  }
}

/**
 * Formats a Discord message into a structured, readable string for the LLM
 */
export function formatMessageForLLM(msg: DiscordMessage, channelName?: string): string {
  const author = msg.author?.globalName || msg.author?.username || 'Unknown';
  const authorId = msg.author?.id || '';
  const date = new Date(msg.timestamp).toISOString().replace('T', ' ').slice(0, 19);
  const chInfo = channelName ? ` [#${channelName}]` : '';

  let text = `[${date}]${chInfo} ${author} (${authorId}) [ID:${msg.id}]: ${msg.content || ''}`;

  if (msg.attachments && msg.attachments.length > 0) {
    const attachmentSummaries = msg.attachments.map(
      (a) => `[Attachment: ${a.filename} (${a.content_type || 'file'}) - ${a.url}]`
    );
    text += `\n  ${attachmentSummaries.join('\n  ')}`;
  }

  if (msg.embeds && msg.embeds.length > 0) {
    const embedSummaries = msg.embeds
      .filter((e) => e.title || e.description || e.url)
      .map((e) => `[Embed: "${e.title || ''}" - ${e.description || e.url || ''}]`);
    if (embedSummaries.length > 0) {
      text += `\n  ${embedSummaries.join('\n  ')}`;
    }
  }

  return text;
}

/**
 * Encodes an image attachment URL to base64 for vision models
 */
export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.error('[VencordAI] Failed to fetch image as base64:', err);
    throw err;
  }
}
