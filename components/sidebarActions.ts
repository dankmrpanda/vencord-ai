/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ChatService } from '../services/chatService';
import { createNewSession, getSessionsForChannel } from '../storage/chatHistory';
import { AssistantLaunchRequest, ChatSession, CurrentScopeContext } from '../types';

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

/**
 * UI-01: a scope chosen in ScopeIndicator stays until the viewed channel changes. Returns the scope to keep, or
 * null when it must be rebuilt for `channelId`. A null channel keeps it, like the session (see sessionChannelTarget).
 */
export function keepScopeForChannel(scope: CurrentScopeContext | null, channelId: string | null): CurrentScopeContext | null {
  if (!scope) return null;
  return !channelId || scope.channelId === channelId ? scope : null;
}

/** UI-Q01: the user counts as following the conversation while within `threshold` px of the bottom. */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * UI-03: chatService appends tokens and steps to the last message in place, so the messages array identity never
 * changes during a run. This key changes whenever visible content grows, and drives the auto-scroll effect.
 */
export function streamScrollKey(session: Pick<ChatSession, 'id' | 'messages'> | null | undefined): string {
  if (!session) return '';
  const last = session.messages[session.messages.length - 1];
  return `${session.id}:${session.messages.length}:${last?.content?.length ?? 0}:${last?.steps?.length ?? 0}`;
}

export interface EscapeKeyLike {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** UI-04: an Escape that a popup, Discord, or an IME composition already used must not close anything else. */
export function isUnhandledEscape(e: EscapeKeyLike): boolean {
  return e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229;
}

/** UI-04: Escape closes the sidebar only when focus is in it, or nowhere in particular (the page body). */
export function isEscapeForPanel(target: unknown, panel: { contains(node: any): boolean } | null, body: unknown): boolean {
  if (!target || target === body) return true;
  return Boolean(panel?.contains(target));
}

/** UI-Q09: Escape closes the innermost open layer first. */
export function escapeLayer(popupOpen: boolean, drawerOpen: boolean): 'popup' | 'drawer' | 'panel' {
  if (popupOpen) return 'popup';
  return drawerOpen ? 'drawer' : 'panel';
}

/** UI-13: a launch target rides only on a send from the input box it prefilled, never on a quick prompt. */
export function launchRequestForSend(
  request: AssistantLaunchRequest | null | undefined,
  customPrompt?: string,
): AssistantLaunchRequest | null {
  return request && !customPrompt ? request : null;
}

/** UI-Q05: return focus to the input when a run ends, unless the user has since moved focus elsewhere in Discord. */
export function shouldRefocusInput(wasGenerating: boolean, generating: boolean, focusInPanel: boolean): boolean {
  return wasGenerating && !generating && focusInPanel;
}
