import { DiscordMessage } from '../types';
import { getAuthToken, getHTTP } from './stores';

/**
 * Fetches messages around a specific message ID to provide conversational context
 */
export async function fetchSurroundingMessages(
  channelId: string,
  messageId: string,
  limit: number = 10
): Promise<DiscordMessage[]> {
  const token = getAuthToken();
  const http = getHTTP();
  const url = `/api/v9/channels/${channelId}/messages?around=${messageId}&limit=${Math.min(limit, 50)}`;

  try {
    let messages: DiscordMessage[] = [];
    if (http && typeof http.get === 'function') {
      const res = await http.get({ url });
      messages = res.body ?? res;
    } else {
      const response = await fetch(`https://discord.com${url}`, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch surrounding messages: ${response.statusText}`);
      }
      messages = await response.json();
    }

    // Sort chronologically (oldest first)
    if (Array.isArray(messages)) {
      return messages.sort(
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
 * Fetches the latest N messages from a channel
 */
export async function fetchRecentMessages(
  channelId: string,
  limit: number = 25
): Promise<DiscordMessage[]> {
  const token = getAuthToken();
  const http = getHTTP();
  const url = `/api/v9/channels/${channelId}/messages?limit=${Math.min(limit, 50)}`;

  try {
    let messages: DiscordMessage[] = [];
    if (http && typeof http.get === 'function') {
      const res = await http.get({ url });
      messages = res.body ?? res;
    } else {
      const response = await fetch(`https://discord.com${url}`, {
        headers: {
          Authorization: token || '',
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch recent messages: ${response.statusText}`);
      }
      messages = await response.json();
    }

    if (Array.isArray(messages)) {
      return [...messages].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }
    return [];
  } catch (err) {
    console.error(`[VencordAI] Error fetching recent messages for channel ${channelId}:`, err);
    return [];
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
      .filter((e) => e.title || e.description)
      .map((e) => `[Embed: "${e.title || ''}" - ${e.description || ''}]`);
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
