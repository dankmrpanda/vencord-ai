/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as RealReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as webpackCommon from '@webpack/common';
import { clearAssistantLaunchRequest, getAssistantLaunchRequest, setAssistantLaunchRequest } from '../assistantLaunch';
import { clickableProps, shortcutLabel } from '../components/a11y';
import { classifyChatError, classifyErrorMessage } from '../components/chatErrors';
import { classifyLink } from '../components/chatLinks';
import { ChatMessage, isEmptyFinishedReply } from '../components/ChatMessage';
import { displayBaseUrl } from '../components/DebugDrawer';
import { deleteClickAction, DELETE_CONFIRM_MS, HistoryDrawer } from '../components/HistoryDrawer';
import { attachmentDisplay, MessagePreview } from '../components/MessagePreview';
import { ToolCallBadge } from '../components/ToolCallBadge';
import { AIAssistantAgent } from '../llm/agent';
import { modelLifecycle } from '../llm/modelLifecycle';
import { ChatService } from '../services/chatService';
import {
  deleteHistorySession,
  escapeLayer,
  inputAfterLaunchCleared,
  isEscapeForPanel,
  isNearBottom,
  isImeComposing,
  isUnhandledEscape,
  keepScopeForChannel,
  launchRequestForSend,
  retryLaunchRequest,
  retryPromptAt,
  selectHistorySession,
  sessionChannelTarget,
  shouldRefocusInput,
  streamScrollKey,
  syncSessionToChannel,
} from '../components/sidebarActions';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_DISCORD_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '../components/sidebarLayout';
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

/** REV-UI-01: a blocked link (http:, scheme-less) dropped its URL, so the user could not see or copy the destination. */
async function revUi01BlockedLinkKeepsUrlText(): Promise<void> {
  const problems: string[] = [];
  for (const [content, url] of [['[the article](http://news.example/x)', 'http://news.example/x'], ['[site](www.example.com)', 'www.example.com']]) {
    const markup = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: assistantMessage(content) }));
    if (!markup.includes(url) || /<a [^>]*href=/i.test(markup)) problems.push(`${content} -> ${markup.slice(0, 200)}`);
  }
  assert(problems.length === 0, `REV-UI-01 blocked link lost its URL text or became clickable: ${problems.join(' | ')}`);
}

/** HARD-03 (UI side): attachment chip names kept bidi controls, so `invoice<U+202E>fdp.exe` displayed as `invoiceexe.pdf`. */
async function hard03ChipNameBidiStripped(): Promise<void> {
  const names = ['invoice%E2%80%AEfdp.exe', 'a%E2%81%A6b.txt', 'x%F3%A0%80%81y.png'].map((segment) => attachmentDisplay(`https://cdn.discordapp.com/attachments/1/2/${segment}`).name);
  const bad = names.filter((name) => /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]|[\u{E0000}-\u{E007F}]/u.test(name));
  assert(bad.length === 0, `HARD-03 attachment chip names kept bidi/tag characters: ${JSON.stringify(bad)}`);
  assert(names[0] === 'invoicefdp.exe', `HARD-03 chip name: ${JSON.stringify(names[0])}`);
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

/** UI-11: the debug drawer never shows userinfo, query or fragment of the base URL (screen-share exposure). */
async function ui11BaseUrlRedacted(): Promise<void> {
  const cases: Array<[string | undefined, string]> = [
    ['https://user:secret@proxy.example/v1', 'https://proxy.example/v1'],
    ['https://gw.example/v1?key=abc#frag', 'https://gw.example/v1'],
    ['http://localhost:8000/v1/', 'http://localhost:8000/v1/'],
    ['', '(not set)'],
    [undefined, '(not set)'],
    ['api.openai.com/v1?key=abc', '(invalid URL)'],
    ['javascript:alert(1)', '(invalid URL)'],
  ];
  const wrong = cases.filter(([raw, expected]) => displayBaseUrl(raw) !== expected)
    .map(([raw, expected]) => `${raw} -> ${displayBaseUrl(raw)} (expected ${expected})`);
  assert(wrong.length === 0, `UI-11 displayBaseUrl: ${wrong.join('; ')}`);
}

/** UI-03: chatService mutates the streaming reply in place, so the auto-scroll trigger must change as it grows. */
async function ui03ScrollFollowsStream(): Promise<void> {
  const reply = assistantMessage('');
  const session = { id: 's1', channelId: 'c1', title: 't', createdAt: 0, updatedAt: 0, messages: [reply] };
  const keys = [streamScrollKey(session)];
  reply.content += 'first tokens';
  keys.push(streamScrollKey(session));
  reply.steps!.push({ type: 'tool_call' } as any);
  keys.push(streamScrollKey(session));
  session.messages.push(assistantMessage('next'));
  keys.push(streamScrollKey(session));
  assert(new Set(keys).size === keys.length, `UI-03 scroll key did not change while the reply grew in place: ${JSON.stringify(keys)}`);
  assert(streamScrollKey(null) === '', 'UI-03 no session -> empty key');
  assert(isNearBottom(1000, 900, 100) && isNearBottom(1000, 821, 100) && !isNearBottom(1000, 700, 100),
    'UI-Q01 near-bottom threshold (80 px)');
}

/** UI-04 / UI-Q09: Escape is ignored once handled, during IME composition, or outside the panel; inner layers go first. */
/** UI-06: the Enter that commits an IME conversion must not send the prompt or pick a mention (MDN: isComposing or keyCode 229). */
async function ui06ImeEnter(): Promise<void> {
  assert(typeof isImeComposing === 'function', 'UI-06 composition check exists');
  assert(isImeComposing({ isComposing: true, keyCode: 13 }), 'UI-06 Enter with isComposing is part of the composition');
  assert(isImeComposing({ isComposing: false, keyCode: 229 }), 'UI-06 keyCode 229 (Safari order) is part of the composition');
  assert(!isImeComposing({ isComposing: false, keyCode: 13 }), 'UI-06 a plain Enter is not');
  const panel = readFileSync(new URL('../components/SidebarPanel.tsx', import.meta.url), 'utf8');
  const handler = panel.slice(panel.indexOf('const handleKeyDown'), panel.indexOf('mentionSuggestions.length > 0', panel.indexOf('const handleKeyDown')));
  assert(/isImeComposing\(e\.nativeEvent\)\) return;/.test(handler), 'UI-06 handleKeyDown returns first during composition');
}

/**
 * LIVE-03 (found in Discord): inside Vencord, `React` from @webpack/common is undefined while plugin modules load, so a
 * module-level `React.memo(...)` threw during Vencord's start-up and no plugin (nor Vencord itself) loaded. The test
 * mock defines React at import time and cannot show this, so check the source: React may only be called inside
 * functions, never at the top level of a module.
 */
async function live03NoReactCallsAtImport(): Promise<void> {
  const files = ['index.tsx', 'settings.tsx', ...readdirSync(new URL('../components/', import.meta.url)).filter((f) => /\.tsx?$/.test(f)).map((f) => `components/${f}`)];
  const offenders: string[] = [];
  for (const file of files) {
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
      // Top-level statements start at column 0; a React call there (or in its initializer) runs at import.
      if (/^(export\s+)?(const|let|var)\s+[^=]+=\s*(typeof\s+)?React\??\.(?!FC\b|CSSProperties\b)\w+/.test(line) || /^React\.\w+\(/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert(offenders.length === 0, `LIVE-03 React used at module load: ${offenders.join(' | ')}`);
}

async function ui04EscapeLayering(): Promise<void> {
  const esc = (over: Record<string, unknown> = {}) => ({ key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 27, ...over });
  assert(isUnhandledEscape(esc()), 'UI-04 plain Escape counts');
  assert(!isUnhandledEscape(esc({ defaultPrevented: true })), 'UI-04 Escape already handled (popup, Discord) must be ignored');
  assert(!isUnhandledEscape(esc({ isComposing: true })), 'UI-04 Escape during IME composition must be ignored');
  assert(!isUnhandledEscape(esc({ keyCode: 229 })), 'UI-04 IME keyCode 229 must be ignored');
  assert(!isUnhandledEscape(esc({ key: 'Enter' })), 'UI-04 other keys ignored');
  const inside = { id: 'inside' };
  const outside = { id: 'discord-composer' };
  const body = { id: 'body' };
  const panel = { contains: (node: any) => node === inside };
  assert(isEscapeForPanel(inside, panel, body), 'UI-04 focus inside panel');
  assert(isEscapeForPanel(body, panel, body), 'UI-04 nothing focused (body)');
  assert(!isEscapeForPanel(outside, panel, body), 'UI-04 focus in Discord must not close the panel');
  assert(!isEscapeForPanel(outside, null, body), 'UI-04 no panel mounted');
  assert(escapeLayer(true, true) === 'popup' && escapeLayer(false, true) === 'drawer' && escapeLayer(false, false) === 'panel',
    'UI-Q09 innermost layer first: popup, drawer, panel');
}

/** Runs `fn` with a minimal fake window/document so index.tsx can start and stop, restoring both afterwards. */
async function withFakeDom<T>(fn: (fakeWindow: Record<string, any>) => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const savedWindow = g.window;
  const savedDocument = g.document;
  const fakeWindow: Record<string, any> = { addEventListener() {}, removeEventListener() {} };
  g.window = fakeWindow;
  if (!hadDocument) g.document = { getElementById: () => null, querySelectorAll: () => [] };
  try {
    return await withMemoryLocalStorage(() => fn(fakeWindow));
  } finally {
    if (hadWindow) g.window = savedWindow; else delete g.window;
    if (hadDocument) g.document = savedDocument; else delete g.document;
  }
}

/** UI-14: the global toggle exists only between startPlugin and stopPlugin. */
async function ui14GlobalToggleLifecycle(): Promise<void> {
  await withFakeDom(async (fakeWindow) => {
    const plugin = await import('../index');
    assert(fakeWindow.toggleVencordAIAssistant === undefined, 'UI-14 toggle must not be assigned at module load');
    plugin.startPlugin();
    const assigned = typeof fakeWindow.toggleVencordAIAssistant === 'function';
    plugin.stopPlugin();
    assert(assigned, 'UI-14 startPlugin assigns the toggle');
    assert(!('toggleVencordAIAssistant' in fakeWindow), 'UI-14 stopPlugin removes the toggle');
  });
}

/** UI-13: closing the panel drops an unsent launch request; quick prompts never carry it. */
async function ui13LaunchRequestScoped(): Promise<void> {
  const request = { targetChannelId: 'c1', targetMessageId: 'm1', mode: 'message', initialPrompt: 'Explain this message.' } as any;
  const scope = { channelId: 'c1', isGuild: false } as unknown as CurrentScopeContext;
  await withFakeDom(async () => {
    const plugin = await import('../index');
    const originalError = console.error;
    console.error = () => undefined; // the fake document cannot mount the panel; renderSidebar logs that and returns.
    let left;
    try {
      plugin.toggleAIAssistant(); // open
      assert(setAssistantLaunchRequest(request, scope), 'UI-13 setup: launch request accepted');
      plugin.toggleAIAssistant(); // close without sending
      left = getAssistantLaunchRequest();
    } finally {
      console.error = originalError;
      clearAssistantLaunchRequest();
    }
    assert(left === null, 'UI-13 closing the panel must drop the pending launch request');
  });
  assert(launchRequestForSend(request, undefined) === request, 'UI-13 input-box send carries the launch target');
  assert(launchRequestForSend(request, 'Summarize recent topics') === null, 'UI-13 quick prompt must not carry it');
  assert(launchRequestForSend(null) === null, 'UI-13 no request');
  assert(inputAfterLaunchCleared('Explain this message.', request) === '', 'UI-13 untouched prefill cleared with its request');
  assert(inputAfterLaunchCleared('Explain this message, briefly', request) === 'Explain this message, briefly', 'UI-13 edited text kept');
  assert(inputAfterLaunchCleared('Explain this message.', null) === 'Explain this message.', 'UI-13 nothing cleared');
}

/** UI-Q02: common provider failures get a fixed one-line hint and an Open settings action. */
async function uiQ02ActionableErrors(): Promise<void> {
  const err = (text: string) => `⚠️ **Error**: ${text}`;
  const cases: Array<[string, string | null]> = [
    [err('Failed to fetch'), 'unreachable'],
    [err('fetch failed (ECONNREFUSED 127.0.0.1:8000)'), 'unreachable'],
    [err('LLM completion failed (401).'), 'auth'],
    [err('Could not resolve the omlx model identifier (HTTP 403). Set Model Identifier...'), 'auth'],
    [err('The omlx model identifier "qwen" was not found. Set Model Identifier...'), 'model'],
    [err('LLM completion failed (404).'), 'model'],
    [err('The Base URL must be an absolute http:// or https:// URL, for example http://localhost:8000/v1.'), 'baseUrl'],
    [err('The Base URL must not contain a username or password. Use the API Key setting instead.'), 'baseUrl'],
    [err('LLM completion failed (500).'), null],
    ['Failed to fetch is a phrase in a normal answer', null],
    ['', null],
  ];
  const wrong = cases.filter(([text, kind]) => (classifyChatError(text)?.kind ?? null) !== kind)
    .map(([text, kind]) => `${text} -> ${classifyChatError(text)?.kind ?? null} (expected ${kind})`);
  assert(wrong.length === 0, `UI-Q02 classifyChatError: ${wrong.join('; ')}`);

  const leaky = err('fetch failed for https://user:hunter2@gw.example/v1?key=sk-secret');
  const hint = classifyChatError(leaky)?.hint ?? '';
  assert(hint && !/hunter2|sk-secret|gw\.example/.test(hint), `UI-Q02 hint must not echo credentials: ${hint}`);

  const message = { ...assistantMessage(err('LLM completion failed (401).')), isError: true };
  const withSettings = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message, onOpenSettings: () => undefined }));
  assert(withSettings.includes('data-error-kind="auth"') && withSettings.includes('Open settings'), 'UI-Q02 hint card with Open settings');
  const noSettings = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message }));
  assert(noSettings.includes('data-error-kind="auth"') && !noSettings.includes('Open settings'), 'UI-Q02 no button without onOpenSettings');
  const user = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: { ...message, role: 'user' } }));
  assert(!user.includes('data-error-kind'), 'UI-Q02 user messages never get a hint');
  // HARD-05: model output can imitate the error prefix; only a reply chatService marked as an error gets a hint.
  const imitated = renderWithRealReact(() => RealReact.createElement(ChatMessage, {
    message: assistantMessage(err('LLM completion failed (401).')),
    onOpenSettings: () => undefined,
  }));
  assert(!imitated.includes('data-error-kind') && !imitated.includes('Open settings'), 'HARD-05 imitated error prefix gets no hint card');
}

/** UI-Q05: an empty finished reply says it stopped; focus returns to the input when a run ends. */
async function uiQ05StopAndFocus(): Promise<void> {
  const empty = { ...assistantMessage(''), isStreaming: false };
  assert(isEmptyFinishedReply(empty), 'UI-Q05 empty finished reply detected');
  assert(!isEmptyFinishedReply({ ...empty, isStreaming: true }), 'UI-Q05 still streaming');
  assert(!isEmptyFinishedReply({ ...empty, content: 'answer' }), 'UI-Q05 has content');
  assert(!isEmptyFinishedReply({ ...empty, role: 'user' }), 'UI-Q05 user message');
  const html = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: empty }));
  assert(html.includes('Stopped before any answer.'), 'UI-Q05 note rendered for an empty stopped reply');
  assert(shouldRefocusInput(true, false, true), 'UI-Q05 refocus when the run ends');
  assert(!shouldRefocusInput(true, false, false), 'UI-Q05 do not steal focus from Discord');
  assert(!shouldRefocusInput(false, false, true) && !shouldRefocusInput(false, true, true), 'UI-Q05 only on the generating -> idle edge');
}

/** UI-Q04: Retry appears only on the last finished assistant reply and re-sends the prompt before it. */
async function uiQ04Retry(): Promise<void> {
  const user = (content: string) => ({ ...assistantMessage(content), role: 'user' as const });
  const reply = { ...assistantMessage('⚠️ **Error**: Failed to fetch'), isStreaming: false };
  const messages = [user('first'), { ...assistantMessage('a1'), isStreaming: false }, user('  second question  '), reply];
  assert(retryPromptAt(messages, 3) === 'second question', 'UI-Q04 last reply retries the preceding prompt');
  assert(retryPromptAt(messages, 1) === null, 'UI-Q04 earlier replies have no Retry');
  assert(retryPromptAt(messages, 2) === null, 'UI-Q04 user messages have no Retry');
  assert(retryPromptAt([...messages.slice(0, 3), { ...reply, isStreaming: true }], 3) === null, 'UI-Q04 no Retry while streaming');
  assert(retryPromptAt([reply], 0) === null, 'UI-Q04 no preceding prompt');
  const launch = { targetChannelId: 'c1', targetMessageId: 'm1', mode: 'message', initialPrompt: 'second question' } as any;
  const last = { sessionId: 's1', prompt: 'second question', request: launch };
  assert(retryLaunchRequest(last, 's1', 'second question') === launch, 'UI-Q04 Retry keeps the launch target of the repeated send');
  assert(retryLaunchRequest(last, 's2', 'second question') === null, 'UI-Q04 another session (channel) never reuses it');
  assert(retryLaunchRequest(last, 's1', 'other') === null && retryLaunchRequest(null, 's1', 'x') === null, 'UI-Q04 other prompt or none');
  const withRetry = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: reply, onRetry: () => undefined }));
  const without = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: reply }));
  assert(withRetry.includes('aria-label="Retry"') && !without.includes('aria-label="Retry"'), 'UI-Q04 Retry button follows onRetry');
}

/** UI-Q08: deleting a chat needs a second click on the same chat within a few seconds. */
async function uiQ08DeleteConfirm(): Promise<void> {
  assert(deleteClickAction(null, 's1', 1000) === 'arm', 'UI-Q08 first click arms');
  assert(deleteClickAction({ id: 's1', at: 1000 }, 's1', 1000 + DELETE_CONFIRM_MS) === 'delete', 'UI-Q08 second click within window deletes');
  assert(deleteClickAction({ id: 's1', at: 1000 }, 's1', 1001 + DELETE_CONFIRM_MS) === 'arm', 'UI-Q08 expired confirmation re-arms');
  assert(deleteClickAction({ id: 's1', at: 1000 }, 's2', 1500) === 'arm', 'UI-Q08 another chat re-arms');
  const html = renderWithRealReact(() => RealReact.createElement(HistoryDrawer, {
    isOpen: true,
    sessionsList: [{ id: 's1', channelId: 'c1', title: 't', createdAt: 0, updatedAt: 0, messages: [] }],
    onSelectSession: () => undefined,
    onDeleteSession: () => undefined,
    onClose: () => undefined,
  }));
  assert(html.includes('aria-label="Delete t"') && !html.includes('Delete?'), 'UI-Q08 unarmed drawer renders the trash button');
}

/** UI-Q07: keyboard-operable clickable divs, aria state on toggles, platform-aware shortcut label. */
async function uiQ07Accessibility(): Promise<void> {
  let activations = 0;
  let prevented = 0;
  const props = clickableProps(() => { activations++; }, false);
  for (const key of ['Enter', ' ', 'a', 'Tab']) props.onKeyDown({ key, preventDefault: () => { prevented++; } });
  assert(activations === 2 && prevented === 2, `UI-Q07 Enter/Space activate (${activations}, ${prevented})`);
  assert(props.role === 'button' && props.tabIndex === 0 && props['aria-expanded'] === false, 'UI-Q07 role/tabIndex/aria-expanded');
  assert(shortcutLabel('MacIntel') === 'Cmd+Shift+A' && shortcutLabel('macOS') === 'Cmd+Shift+A', 'UI-Q07 mac label');
  assert(shortcutLabel('Win32') === 'Ctrl+Shift+A' && shortcutLabel('Linux x86_64') === 'Ctrl+Shift+A' && shortcutLabel(undefined) === 'Ctrl+Shift+A',
    'UI-Q07 other platforms use Ctrl');
  const message = { ...assistantMessage('see refs'), citations: [{ messageId: 'm1', channelId: 'c1' } as any] };
  const html = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message }));
  assert(/<button class="vai-sources-toggle" aria-expanded="false"/.test(html), 'UI-Q07 sources toggle is a native button with aria-expanded');
  const badge = renderWithRealReact(() => RealReact.createElement(ToolCallBadge, { step: { id: 'st1', type: 'tool_call', toolName: 'search_messages', timestamp: 0 } as any }));
  assert(/<button class="vai-step-head" aria-expanded="false"/.test(badge), 'UI-Q07 tool step is a native button with aria-expanded');
}

/** UI-Q11: non-image attachments render as a named file chip, not a broken image; names never include the query. */
async function uiQ11AttachmentChips(): Promise<void> {
  const cdn = 'https://cdn.discordapp.com/attachments/1/2';
  const cases: Array<[string, string, string]> = [
    [`${cdn}/photo.PNG?ex=1&is=2&hm=secret`, 'image', 'photo.PNG'],
    [`${cdn}/report%20final.pdf?ex=1&hm=secret`, 'file', 'report final.pdf'],
    [`${cdn}/clip.mp4`, 'file', 'clip.mp4'],
    [`${cdn}/archive.zip#x`, 'file', 'archive.zip'],
    ['not a url/pic.jpeg?x=1', 'image', 'pic.jpeg'],
    ['https://cdn.discordapp.com/', 'file', 'attachment'],
  ];
  const wrong = cases.filter(([url, kind, name]) => {
    const got = attachmentDisplay(url);
    return got.kind !== kind || got.name !== name;
  }).map(([url]) => `${url} -> ${JSON.stringify(attachmentDisplay(url))}`);
  assert(wrong.length === 0, `UI-Q11 attachmentDisplay: ${wrong.join('; ')}`);
  const html = renderWithRealReact(() => RealReact.createElement(MessagePreview, {
    citation: { messageId: 'm1', channelId: 'c1', timestamp: 0, content: 'x', attachmentUrls: [`${cdn}/photo.png`, `${cdn}/notes.pdf?hm=secret`] } as any,
  }));
  assert(html.includes('<img') && /class="vai-file-chip"[^>]*title="notes.pdf"/.test(html) && !html.includes('src="https://cdn.discordapp.com/attachments/1/2/notes.pdf'),
    'UI-Q11 image thumbnail plus file chip');
}

/** UI layout clamping, structured errorKind classification, and ScopeIndicator IME-safe Escape. */
async function uiLayoutAndStructuredErrors(): Promise<void> {
  assert(clampSidebarWidth(NaN, 1440) === DEFAULT_SIDEBAR_WIDTH, 'NaN width uses default');
  assert(clampSidebarWidth(120, 1440) === MIN_SIDEBAR_WIDTH, 'Clamps below min width');
  assert(clampSidebarWidth(900, 1440) === MAX_SIDEBAR_WIDTH, 'Clamps above max width');
  assert(clampSidebarWidth(700, 1000) === 1000 - MIN_DISCORD_WIDTH, 'Leaves Discord MIN_DISCORD_WIDTH room');

  assert(classifyErrorMessage('LLM completion failed (401).') === 'auth', '401 classifies as auth');
  const structuredMsg: AssistantChatMessage = {
    ...assistantMessage('Custom provider rejection'),
    isError: true,
    errorKind: 'auth',
  };
  const rendered = renderWithRealReact(() => RealReact.createElement(ChatMessage, { message: structuredMsg, onOpenSettings: () => undefined }));
  assert(rendered.includes('data-error-kind="auth"') && rendered.includes('Open settings'),
    'ChatMessage uses structured errorKind directly');

  const originalAcquire = modelLifecycle.acquire;
  const originalRun = AIAssistantAgent.prototype.run;
  await withMemoryLocalStorage(async () => {
    try {
      modelLifecycle.acquire = async () => () => undefined;
      AIAssistantAgent.prototype.run = async () => { throw new Error('LLM completion failed (401).'); };
      const service = new ChatService({ ...DEFAULT_SETTINGS });
      await service.initSession('ui_err_chan');
      await service.sendMessage('hi');
      const reply = service.getActiveSession()!.messages.at(-1)!;
      assert(reply.isError && reply.errorKind === 'auth', `ChatService did not set structured errorKind: ${JSON.stringify(reply)}`);
    } finally {
      modelLifecycle.acquire = originalAcquire;
      AIAssistantAgent.prototype.run = originalRun;
    }
  });

  const scopeSrc = readFileSync(new URL('../components/ScopeIndicator.tsx', import.meta.url), 'utf8');
  assert(scopeSrc.includes('isUnhandledEscape(e)'), 'ScopeIndicator Escape listener must ignore IME composition');
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['SEC-10 classifyLink allowlist', sec10ClassifyLink],
  ['SEC-10 javascript: href rendered', sec10ScriptSchemeHref],
  ['SEC-10 spoofed link host hidden', sec10SpoofedLinkHostHidden],
  ['REV-UI-01 blocked link keeps its URL text', revUi01BlockedLinkKeepsUrlText],
  ['HARD-03 chip name bidi stripped', hard03ChipNameBidiStripped],
  ['UI-10 nested inline links', ui10NestedInlineLinks],
  ['UI-07 base URL validation', ui07BaseUrlValidation],
  ['UI-02 stale history copy overwrites answer', ui02StaleCopyOverwritesAnswer],
  ['SEC-09 session follows channel', sec09SessionFollowsChannel],
  ['UI-01 scope kept until channel change', ui01ScopeKeptUntilChannelChange],
  ['UI-11 base URL redacted in debug drawer', ui11BaseUrlRedacted],
  ['UI-03 scroll follows stream', ui03ScrollFollowsStream],
  ['UI-04 Escape layering', ui04EscapeLayering],
  ['LIVE-03 no React calls at module load', live03NoReactCallsAtImport],
  ['UI-06 Enter during IME composition', ui06ImeEnter],
  ['UI-14 global toggle lifecycle', ui14GlobalToggleLifecycle],
  ['UI-13 launch request scoped to its prompt', ui13LaunchRequestScoped],
  ['UI-Q02 actionable errors', uiQ02ActionableErrors],
  ['UI-Q05 stop note and focus', uiQ05StopAndFocus],
  ['UI-Q04 retry last reply', uiQ04Retry],
  ['UI-Q08 delete needs confirmation', uiQ08DeleteConfirm],
  ['UI-Q07 accessibility basics', uiQ07Accessibility],
  ['UI-Q11 attachment file chips', uiQ11AttachmentChips],
  ['UI layout clamp, structured errorKind, and ScopeIndicator IME Escape', uiLayoutAndStructuredErrors],
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
