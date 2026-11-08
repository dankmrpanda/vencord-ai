/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { modelLifecycle } from '../llm/modelLifecycle';
import { getChatService } from './chatService';

let exitTarget: EventTarget | undefined;

function handlePageExit(): void {
  getChatService()?.stopGenerating();
  void modelLifecycle.shutdown(true);
}

export function startAssistantRuntime(target: EventTarget): void {
  exitTarget?.removeEventListener('pagehide', handlePageExit);
  exitTarget = target;
  // pagehide fires on quit/reload, but not when the sidebar or window is merely hidden.
  exitTarget.addEventListener('pagehide', handlePageExit);
  modelLifecycle.start();
}

export function stopAssistantRuntime(): Promise<void> {
  exitTarget?.removeEventListener('pagehide', handlePageExit);
  exitTarget = undefined;
  getChatService()?.stopGenerating();
  return modelLifecycle.shutdown();
}
