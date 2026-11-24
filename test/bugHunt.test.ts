/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI } from '@webpack/common';
import { runMessageSearch } from '../discord/searchPipeline';
import { filterMessagesLocally } from '../discord/messages';
import { compileSafeRegex } from '../discord/safeRegex';
import { consumeChatCompletionStream, OpenAICompatibleClient } from '../llm/provider';
import { ChannelType, CurrentScopeContext, DiscordMessage, PluginSettings } from '../types';
import { assert } from './assert';

const scope: CurrentScopeContext = {
  channelId: 'bug-hunt-channel',
  channelName: 'bug-hunt',
  channelType: ChannelType.DM,
  isDM: true,
  isGroupDM: false,
  isGuild: false,
};
const message = (id: string, content: string, timestamp: string, pinned = false): DiscordMessage => ({
  id,
  channel_id: scope.channelId,
  author: { id: 'fixture-author', username: 'Fixture' },
  content,
  timestamp,
  pinned,
  attachments: [],
  embeds: [],
  mentions: [],
});

export async function runRegexSafetyRegressions(): Promise<void> {
  assert(compileSafeRegex('(a+)+$').regex === null, 'Recent-message regex compilation must apply the existing ReDoS safety screen');
  assert(compileSafeRegex(/(a+)+$/).regex === null, 'RegExp inputs must receive the same ReDoS screening');
  const safe = compileSafeRegex('/hello/i').regex;
  assert(Boolean(safe?.global && safe.ignoreCase && safe.test('HELLO')), 'Safe regex literals must retain their flags');
  const messages = [message('regex-fixture', 'ordinary text', new Date().toISOString())];
  assert(filterMessagesLocally(messages, { pattern: '[' }).length === 0, 'An invalid regex must fail closed rather than become an unfiltered search');
  const originalGet = RestAPI.get;
  let requested = false;
  RestAPI.get = async () => { requested = true; return { body: [] }; };
  try {
    const result = await runMessageSearch({ query: 'safetyneedle', pattern: '(a+)+$', limit: 10, scanLimit: 10 }, scope);
    assert(!result.ok && result.code === 'invalid_pattern' && !requested, 'Unsafe patterns must be rejected before search requests or local scans');
  } finally {
    RestAPI.get = originalGet;
  }
}

export async function runSearchFallbackRegressions(): Promise<void> {
  const originalGet = RestAPI.get;
  try {
    const older = message('sort-old', 'sortneedle', new Date(2026, 0, 1, 12).toISOString());
    const newer = message('sort-new', 'sortneedle sortneedle', new Date(2026, 0, 2, 12).toISOString());
    RestAPI.get = async () => ({ body: { total_results: 2, messages: [[newer], [older]] } });
    const ascending = await runMessageSearch({ query: 'sortneedle', limit: 2, scanLimit: 10, sortBy: 'timestamp', sortOrder: 'asc' }, scope);
    assert(ascending.data?.messages[0]?.id === 'sort-old', 'Explicit chronological ordering must survive combined search ranking');
    const descending = await runMessageSearch({ query: 'sortneedle', limit: 2, scanLimit: 10, sortBy: 'timestamp', sortOrder: 'desc' }, scope);
    assert(descending.data?.messages[0]?.id === 'sort-new', 'Descending chronological ordering must survive combined search ranking');
  } finally {
    RestAPI.get = originalGet;
  }
}

export async function runStreamRegressions(): Promise<void> {
  const encoder = new TextEncoder();
  const errorStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"error":{"message":"fixture stream failure"}}\n\n'));
      controller.close();
    },
  });
  let error: unknown;
  try { await consumeChatCompletionStream(errorStream); } catch (caught) { error = caught; }
  assert(error instanceof Error && error.message.includes('fixture stream failure'), 'SSE provider errors must reject instead of looking like successful empty answers');

  let cancelled = false;
  const openStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'));
      // A terminal SSE event must finish even if the connection remains open.
    },
    cancel() { cancelled = true; },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      consumeChatCompletionStream(openStream),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal SSE marker did not finish the completion')), 200); }),
    ]);
    assert(result.content === 'done' && cancelled, 'DONE must finish and cancel the remaining response body');
  } finally {
    clearTimeout(timer);
  }
}

export async function runRetryCancellationRegression(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const settings: PluginSettings = {
    providerPreset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture',
    temperature: 0.2, maxTokens: 128, systemPrompt: '', enableVision: false,
    maxContextMessages: 10, searchLimitPerQuery: 10, maxSearchIterations: 2,
  };
  const controller = new AbortController();
  let requests = 0;
  let retryBodyCancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  globalThis.fetch = (async () => {
    requests++;
    queueMicrotask(() => controller.abort());
    return new Response(new ReadableStream({ cancel() { retryBodyCancelled = true; } }), { status: 429, headers: { 'Retry-After': '0.1' } });
  }) as typeof fetch;
  try {
    const client = new OpenAICompatibleClient(settings);
    const verdict = await Promise.race([
      client.complete({ messages: [], stream: false }, {}, controller.signal).then(() => 'resolved', () => 'aborted'),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still waiting'), 50); }),
    ]);
    assert(verdict === 'aborted', 'Cancellation must interrupt rate-limit backoff immediately');
    assert(requests === 1 && retryBodyCancelled, 'Retried response bodies must be released and cancellation must prevent another request');
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
}

export async function runBugHuntTests(): Promise<void> {
  await runRegexSafetyRegressions();
  await runSearchFallbackRegressions();
  await runStreamRegressions();
  await runRetryCancellationRegression();
  console.log('✅ Regex safety, search fallback filters, ordering, SSE completion, and retry cancellation regressions passed');
}

if (typeof require !== 'undefined' && require.main === module) {
  const selected = process.argv[2];
  const run = selected === 'regex' ? runRegexSafetyRegressions
    : selected === 'stream' ? runStreamRegressions
    : selected === 'retry' ? runRetryCancellationRegression
      : selected === 'search' ? runSearchFallbackRegressions : runBugHuntTests;
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
