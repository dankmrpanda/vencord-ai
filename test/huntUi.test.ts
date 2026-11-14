/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as RealReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as webpackCommon from '@webpack/common';
import { classifyLink } from '../components/chatLinks';
import { ChatMessage } from '../components/ChatMessage';
import { AIAssistantAgent } from '../llm/agent';
import { modelLifecycle } from '../llm/modelLifecycle';
import { ChatService } from '../services/chatService';
import { deleteHistorySession, keepScopeForChannel, selectHistorySession, sessionChannelTarget, syncSessionToChannel } from '../components/sidebarActions';
import { DEFAULT_SETTINGS, validateBaseUrlInput } from '../settings';
import { getSessionById, getSessionsForChannel } from '../storage/chatHistory';
import { AssistantChatMessage, CurrentScopeContext } from '../types';
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

/** SEC-10: the link classifier allows only Discord jump links and https:, and anchors host checks. */
async function sec10ClassifyLink(): Promise<void> {
  const cases: Array<[string, string, Record<string, unknown>?]> = [
    ['javascript:alert(1)', 'blocked'],
    ['JaVaScRiPt:alert(1)', 'blocked'],
    ['data:text/html,<b>x</b>', 'blocked'],
    ['http://evil.example/', 'blocked'],
    ['file:///etc/passwd', 'blocked'],
    ['not a url', 'blocked'],
    ['discord://settings/account', 'blocked'],
    ['discord://message/abc/2', 'blocked'],
    ['discord://message/1/2/3', 'blocked'],
    ['discord://message/111/222', 'jump', { channelId: '111', messageId: '222', guildId: undefined }],
    ['discord://channels/@me/111/222', 'jump', { channelId: '111', messageId: '222', guildId: undefined }],
    ['discord://channels/9/111/222', 'jump', { channelId: '111', messageId: '222', guildId: '9' }],
    ['https://discord.com/channels/@me/111/222', 'jump', { channelId: '111', messageId: '222', guildId: undefined }],
    ['https://ptb.discord.com/channels/9/111', 'jump', { channelId: '111', messageId: undefined, guildId: '9' }],
    ['/channels/9/111/222', 'jump', { channelId: '111', href: 'https://discord.com/channels/9/111/222' }],
    ['https://discord.com.evil.example/channels/9/111/222', 'external', { display: 'https://discord.com.evil.example/channels/9/111/222' }],
    ['https://evil.example/channels/9/111/222', 'external'],
    ['https://discord.com@evil.example/x', 'external', { display: 'https://evil.example/x' }],
    ['https://evil.example/?d=secret dm', 'external', { display: 'https://evil.example/?d=secret%20dm' }],
    ['https://discord.com/channels/9/111/222/extra', 'external'],
    ['//evil.example/x', 'blocked'],
    ['  javascript:alert(1)', 'blocked'],
    ['HTTPS://DISCORD.COM/channels/9/111', 'jump', { channelId: '111', guildId: '9' }],
    ['DISCORD://Message/111/222', 'jump', { channelId: '111', messageId: '222' }],
    ['https://evildiscord.com/channels/9/111/222', 'external'],
    ['https://user:pw@discord.com/channels/9/111/222', 'jump', { href: 'https://discord.com/channels/9/111/222' }],
    ['https://user:pw@evil.example/x', 'external', { href: 'https://evil.example/x', display: 'https://evil.example/x' }],
  ];
  const wrong: string[] = [];
  for (const [href, kind, fields] of cases) {
    const got = classifyLink(href) as Record<string, unknown>;
    const fieldMismatch = Object.entries(fields || {}).find(([key, value]) => got[key] !== value);
    if (got.kind !== kind || fieldMismatch) wrong.push(`${href} -> ${JSON.stringify(got)} (expected ${kind}${fields ? ` ${JSON.stringify(fields)}` : ''})`);
  }
  assert(wrong.length === 0, `SEC-10 classifyLink: ${wrong.join('; ')}`);
}

/** UI-10: links nested in bold/italic/strike still render as links; balanced parentheses stay in the href. */
async function ui10NestedInlineLinks(): Promise<void> {
  const bold = renderWithRealReact(() =>
    RealReact.createElement(ChatMessage, { message: assistantMessage('**[Jump](discord://message/1/2)** and *[a](https://x.example/p_(1))*') }));
  assert(/<strong[^>]*><a [^>]*href="https:\/\/discord.com\/channels\/@me\/1\/2"/.test(bold), `UI-10 bold jump link not rendered as a link: ${bold.slice(bold.indexOf('<strong'), bold.indexOf('<strong') + 160)}`);
  assert(bold.includes('href="https://x.example/p_(1)"'), `UI-10 parenthesised href truncated: ${bold.match(/<em[\s\S]*?<\/em>/)?.[0]}`);
}

/** UI-07: Test Connection must refuse empty, scheme-less and credential-bearing base URLs before any request. */
async function ui07BaseUrlValidation(): Promise<void> {
  const invalid = ['', '   ', 'api.openai.com/v1', '127.0.0.1:8000/v1', 'localhost:8000/v1', '/v1', 'javascript:alert(1)',
    'ftp://example.com/v1', 'https://user:pw@api.example.com/v1', 'https://user@api.example.com/v1'];
  const accepted = invalid.filter((raw) => validateBaseUrlInput(raw).ok);
  assert(accepted.length === 0, `UI-07 accepted invalid base URLs: ${JSON.stringify(accepted)}`);
  const missingMessage = invalid.filter((raw) => { const r = validateBaseUrlInput(raw); return !r.ok && !r.message; });
  assert(missingMessage.length === 0, `UI-07 no message for: ${JSON.stringify(missingMessage)}`);
  const leaked = validateBaseUrlInput('https://user:secretpw@api.example.com/v1');
  assert(!leaked.ok && !leaked.message.includes('secretpw'), 'UI-07 validation message echoes the credential');
  const ok = validateBaseUrlInput(' http://localhost:8000/v1/ ');
  assert(ok.ok && ok.url === 'http://localhost:8000/v1', `UI-07 valid URL not normalized: ${JSON.stringify(ok)}`);
  assert(validateBaseUrlInput('https://api.openai.com/v1').ok, 'UI-07 rejected https://api.openai.com/v1');
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

/** SEC-09: sessions are per channel; the panel follows the viewed channel once no run is in progress. */
async function sec09SessionFollowsChannel(): Promise<void> {
  const originalAcquire = modelLifecycle.acquire;
  const originalRun = AIAssistantAgent.prototype.run;
  await withMemoryLocalStorage(async () => {
    try {
      let releaseRun: (() => void) | null = null;
      modelLifecycle.acquire = async () => () => undefined;
      AIAssistantAgent.prototype.run = function () {
        if (!releaseRun) return Promise.resolve({ content: 'answer', steps: [], citations: [] });
        return new Promise((resolve) => {
          const release = releaseRun!;
          releaseRun = () => { release(); resolve({ content: 'late answer', steps: [], citations: [] }); };
        });
      } as any;
      const stamp = Date.now();
      const [chA, chB, chC] = [`hunt_sec09_a_${stamp}`, `hunt_sec09_b_${stamp}`, `hunt_sec09_c_${stamp}`];
      const service = new ChatService({ ...DEFAULT_SETTINGS });
      const sessionA = await service.initSession(chA);
      await service.sendMessage('secret question in A');
      let viewed: string | null = chB;
      const viewing = () => viewed;

      assert(await syncSessionToChannel(service, viewing), 'SEC-09 no switch on channel change A -> B');
      const inB = service.getActiveSession()!;
      assert(inB.channelId === chB && !inB.messages.some((m) => m.content.includes('secret question in A')),
        `SEC-09 panel still shows/sends into A's session after moving to B (channelId=${inB.channelId}, messages=${inB.messages.length})`);

      viewed = null;
      assert(!(await syncSessionToChannel(service, viewing)) && service.getActiveSession() === inB, 'SEC-09 null channel must keep the active session');
      assert(sessionChannelTarget(null, inB, false) === null && sessionChannelTarget(chB, inB, false) === null
        && sessionChannelTarget(chA, inB, true) === null && sessionChannelTarget(chA, inB, false) === chA
        && sessionChannelTarget(chA, null, false) === null, 'SEC-09 sessionChannelTarget decision table');

      viewed = chB;
      releaseRun = () => undefined;
      const sending = service.sendMessage('question in B');
      await new Promise((resolve) => setTimeout(resolve, 20));
      viewed = chA;
      assert(!(await syncSessionToChannel(service, viewing)) && service.getActiveSession()!.channelId === chB, 'SEC-09 switched sessions during a run');
      releaseRun!();
      await sending;
      releaseRun = null;
      assert(await syncSessionToChannel(service, viewing), 'SEC-09 no switch after the run ended');
      assert(service.getActiveSession()!.id === sessionA.id, `SEC-09 returning to A did not resume A's saved session (${service.getActiveSession()!.id})`);

      viewed = chC;
      assert(await syncSessionToChannel(service, viewing) && service.getActiveSession()!.channelId === chC, 'SEC-09 no switch to an empty channel');
      assert((await getSessionsForChannel(chC)).length === 0, 'SEC-09 browsing a channel persisted an empty session');
    } finally {
      modelLifecycle.acquire = originalAcquire;
      AIAssistantAgent.prototype.run = originalRun;
    }
  });
}

/** UI-01: a scope chosen in ScopeIndicator survives sends and refreshes; it is replaced only for another channel. */
async function ui01ScopeKeptUntilChannelChange(): Promise<void> {
  const serverScope = { channelId: 'c1', scopeMode: 'server', selectedChannelIds: ['c1', 'c2'] } as unknown as CurrentScopeContext;
  assert(keepScopeForChannel(serverScope, 'c1') === serverScope, 'UI-01 chosen scope dropped while still in its channel');
  assert(keepScopeForChannel(serverScope, null) === serverScope, 'UI-01 null channel must keep the scope (matches the session rule)');
  assert(keepScopeForChannel(serverScope, 'c9') === null, 'UI-01 scope from another channel kept after a channel change');
  assert(keepScopeForChannel(null, 'c1') === null, 'UI-01 missing scope must be rebuilt');
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['SEC-10 classifyLink allowlist', sec10ClassifyLink],
  ['SEC-10 javascript: href rendered', sec10ScriptSchemeHref],
  ['SEC-10 spoofed link host hidden', sec10SpoofedLinkHostHidden],
  ['UI-10 nested inline links', ui10NestedInlineLinks],
  ['UI-07 base URL validation', ui07BaseUrlValidation],
  ['UI-02 stale history copy overwrites answer', ui02StaleCopyOverwritesAnswer],
  ['SEC-09 session follows channel', sec09SessionFollowsChannel],
  ['UI-01 scope kept until channel change', ui01ScopeKeptUntilChannelChange],
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
