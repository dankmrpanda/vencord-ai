/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isChannelAllowedInScope } from './discord/scope';
import { AssistantLaunchRequest, CurrentScopeContext } from './types';

let pending: AssistantLaunchRequest | null = null;

export function setAssistantLaunchRequest(request: AssistantLaunchRequest, scope: CurrentScopeContext): boolean {
  if (!isChannelAllowedInScope(request.targetChannelId, scope)) return false;
  pending = request;
  return true;
}

export const getAssistantLaunchRequest = (): AssistantLaunchRequest | null => pending;
export const clearAssistantLaunchRequest = (): void => { pending = null; };
