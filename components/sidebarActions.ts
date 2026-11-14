/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ChatService } from '../services/chatService';
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
