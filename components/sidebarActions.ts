/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ChatService } from '../services/chatService';
import { createNewSession, getSessionsForChannel } from '../storage/chatHistory';
import { ChatSession } from '../types';

/**
 * Switching or deleting sessions during a run detaches the streaming reply from what the panel shows
 * and lets a stale stored copy overwrite the finished answer, so history actions wait for the run to end.
 */
export function canChangeSessions(service: Pick<ChatService, 'isGenerating'>): boolean {
  return !service.isGenerating();
}

/** Returns true when the active session changed. Re-selecting the active session keeps the newer in-memory copy. */
export function selectHistorySession(service: ChatService, selected: ChatSession): boolean {
  if (!canChangeSessions(service)) return false;
  if (service.getActiveSession()?.id === selected.id) return false;
  service.switchSession(selected);
  return true;
}

/** Returns true when the session was deleted. */
export async function deleteHistorySession(service: ChatService, sessionId: string): Promise<boolean> {
  if (!canChangeSessions(service)) return false;
  await service.deleteSession(sessionId);
  return true;
}

/**
 * SEC-09: sessions are per channel. Returns the channel whose session the panel must switch to, or null to keep
 * the active one: same channel, no viewed channel (home, friends list), session not loaded yet, or a run in progress.
 */
export function sessionChannelTarget(viewedChannelId: string | null, active: ChatSession | null, generating: boolean): string | null {
  if (!viewedChannelId || !active || generating || active.channelId === viewedChannelId) return null;
  return viewedChannelId;
}

/**
 * Makes the active session belong to the viewed channel: its latest saved session, or a new one that is saved on
 * the first send (browsing does not litter history). Returns true when the active session changed. Gives up if
 * the channel, the active session or the generating state changed while the list loaded; callers re-run it.
 */
export async function syncSessionToChannel(service: ChatService, getViewedChannelId: () => string | null): Promise<boolean> {
  const before = service.getActiveSession();
  const target = sessionChannelTarget(getViewedChannelId(), before, service.isGenerating());
  if (!target) return false;
  const latest = (await getSessionsForChannel(target).catch(() => [] as ChatSession[]))[0];
  if (getViewedChannelId() !== target || service.getActiveSession() !== before || service.isGenerating()) return false;
  service.switchSession(latest?.channelId === target ? latest : createNewSession(target, 'New Conversation'));
  return true;
}
