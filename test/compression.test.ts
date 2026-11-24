/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AIAssistantAgent } from '../llm/agent';
import {
  AgentBudgetTracker,
  buildConversationContext,
  compactToolResult,
  DEFAULT_AGENT_RUN_BUDGET,
  estimateTokens,
  summarizeHistory,
} from '../llm/compression';
import { AssistantChatMessage, ChannelType, PluginSettings } from '../types';
import { assert } from './assert';

function runTokenEstimationAndCompressionTests(): void {
  const now = 1776000000000;

  assert(estimateTokens('') === 0, 'Empty string must return 0 tokens');
  assert(estimateTokens('   ') === 1, 'Short whitespace token count must be 1');

  const englishSentence = 'The quick brown fox jumps over the lazy dog. A secondary test sentence for verification.';
  const engTokens = estimateTokens(englishSentence);
  const ratio = englishSentence.length / engTokens;
  assert(ratio >= 3.0 && ratio <= 3.6, `English char/token ratio should be ~3.4 (actual: ${ratio.toFixed(2)})`);

  const chineseText = '这是一个用于测试中文分词与标记数量估计的完整段落。包含多个汉字。';
  const cjkTokens = estimateTokens(chineseText);
  assert(cjkTokens >= chineseText.length * 0.8 && cjkTokens <= chineseText.length * 1.2, 'CJK tokens should scale at ~0.9 tokens/char');

  const japaneseText = 'こんにちは世界！ひらがなとカタカナと漢字が混ざったテスト文章です。';
  const jpTokens = estimateTokens(japaneseText);
  assert(jpTokens >= japaneseText.length * 0.8 && jpTokens <= japaneseText.length * 1.2, 'Japanese text should scale densely');

  const koreanText = '안녕하세요 이것은 한국어 토큰 추정 테스트입니다.';
  const krTokens = estimateTokens(koreanText);
  assert(krTokens >= koreanText.length * 0.7 && krTokens <= koreanText.length * 1.2, 'Korean Hangul should scale densely');

  const mixedEstimate = estimateTokens('Hello 123! こんにちは (Konnichiwa) 안녕하세요 (Annyeonghaseyo) 你好 (Nǐ hǎo)');
  assert(mixedEstimate > 15 && mixedEstimate < 45, 'Mixed script estimate must be balanced');

  const emojiEstimate = estimateTokens('🚀🔥🎉✨👨‍👩‍👧‍👧👍❤️');
  assert(emojiEstimate >= 2 && emojiEstimate <= 15, 'Emoji string should estimate reasonably without crashing');

  const hugeText = 'A'.repeat(100_000);
  const hugeTokens = estimateTokens(hugeText);
  assert(hugeTokens === Math.ceil(100_000 / 3.4), 'Exact formula calculation for 100k chars');

  assert(summarizeHistory([]) === '', 'Empty history summary must be empty string');
  const historySummary = summarizeHistory([
    { id: '1', role: 'user', content: 'Where is the report for Q3?', timestamp: 1 },
    { id: '2', role: 'assistant', content: 'The Q3 financial report is in #general-finance.', timestamp: 2 },
  ]);
  assert(historySummary.includes('user: Where is the report for Q3?'), 'History summary must preserve user turn');
  assert(historySummary.includes('assistant: The Q3 financial report'), 'History summary must preserve assistant turn');

  // Compact tool output: deep nesting, wide objects, primitives, invalid JSON, unbreakable blobs, progressive popping
  const smallRaw = 'Small raw tool output text';
  assert(compactToolResult(smallRaw, 100) === smallRaw, 'Small raw tool output within maxChars must be preserved');

  let deepNested: any = { leaf: 'deep payload '.repeat(200) };
  for (let d = 0; d < 80; d++) deepNested = { level: d, inner: deepNested };
  const compactedDeep = compactToolResult(JSON.stringify({ ok: true, code: 'deep_test', data: deepNested }), 5000);
  assert(compactedDeep.length <= 5000 && typeof JSON.parse(compactedDeep) === 'object', 'Compacted deep JSON must fit within 5,000 chars');

  const wideObj: Record<string, string> = {};
  for (let k = 0; k < 3000; k++) wideObj[`key_${k}`] = `value payload content for key ${k} `.repeat(10);
  const compactedWide = compactToolResult(JSON.stringify({ ok: true, data: wideObj }), 4000);
  assert(compactedWide.length <= 4000 && typeof JSON.parse(compactedWide) === 'object', 'Compacted wide JSON must fit within 4,000 chars');

  assert(compactToolResult(JSON.stringify('simple string payload'), 100).length <= 100, 'Primitive string JSON must compact safely');
  assert(compactToolResult(JSON.stringify(123456789), 100).length <= 100, 'Primitive number JSON must compact safely');
  assert(compactToolResult(JSON.stringify(null), 100).length <= 100, 'Primitive null JSON must compact safely');

  const invalidCompacted = JSON.parse(compactToolResult('{ invalid json text: 1234 }'.repeat(500), 1000));
  assert(invalidCompacted.ok === false && invalidCompacted.code === 'invalid_tool_output', 'Invalid JSON > maxChars must fail closed safely');

  const unbreakablePayload = {
    ok: true,
    code: 'huge_blob',
    summary: 'Huge binary string',
    untrustedData: true,
    data: { blob: 'X'.repeat(50_000) },
  };
  const compactedFallback = compactToolResult(JSON.stringify(unbreakablePayload), 1000);
  const parsedFallback = JSON.parse(compactedFallback);
  assert(compactedFallback.length <= 1000 && parsedFallback.ok === true && parsedFallback.truncation?.returned === 0, 'Unbreakable blob fallback must stay bounded');

  const massiveData = {
    ok: true,
    code: 'search_results',
    summary: 'Found 80 messages.',
    untrustedData: true,
    data: {
      messages: Array.from({ length: 80 }, (_, i) => ({
        id: `msg_${i}`,
        content: `Long message text payload repeat ${i} `.repeat(15),
        author: { username: `user_${i}`, id: `id_${i}` },
      })),
    },
  };
  const compacted = compactToolResult(JSON.stringify(massiveData), 12_000);
  const parsedCompacted = JSON.parse(compacted);
  assert(compacted.length <= 12_000, 'Compacted output must strictly fit within 12,000 character limit');
  assert(parsedCompacted.ok === true && parsedCompacted.untrustedData === true, 'Compacted JSON must keep ok and untrustedData');
  assert(parsedCompacted.truncation?.truncated === true, 'Compacted JSON must flag truncation.truncated = true');

  // Conversation context eviction under tight input budget
  const settings: PluginSettings = {
    providerPreset: 'custom',
    baseUrl: 'http://localhost/v1',
    apiKey: '',
    model: 'test',
    temperature: 0.5,
    maxTokens: 500,
    systemPrompt: 'System',
    enableVision: false,
    maxContextMessages: 50,
    searchLimitPerQuery: 25,
    maxSearchIterations: 6,
  };
  const hugeHistory: AssistantChatMessage[] = Array.from({ length: 150 }, (_, i) => ({
    id: `hist_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i}: Conversation turn details about item #${i}. `.repeat(5),
    timestamp: now - (150 - i) * 60_000,
  }));
  const builtContext = buildConversationContext('Developer instructions', hugeHistory, 'Latest question?', settings, 2000);
  assert(builtContext[0].role === 'developer', 'First message must be developer prompt');
  assert(builtContext[builtContext.length - 1].role === 'user', 'Last message must be latest user prompt');
  const estimatedContextTokens = estimateTokens(builtContext.map((m) => String(m.content || '')).join('\n'));
  assert(estimatedContextTokens <= 2000, `Assembled context tokens (${estimatedContextTokens}) must fit input budget (2000)`);

  // Budget tracker limits & deep key-order deduplication
  const budget = new AgentBudgetTracker({
    ...DEFAULT_AGENT_RUN_BUDGET,
    maxModelTurns: 6,
    maxToolCalls: 12,
    maxReturnedRecords: 200,
    maxEstimatedInputTokens: 32_000,
    finalizationCalls: 1,
  });
  assert(budget.canModelTurn() && budget.canToolCall(), 'Fresh budget tracker must allow model turn and tool call');
  assert(
    budget.markCall('search_messages', {
      query: 'database',
      filters: { channelId: '123', tags: ['a', 'b'], meta: { priority: 1, active: true } },
    }) === true,
    'First normalized tool call must be allowed',
  );
  assert(
    budget.markCall('search_messages', {
      filters: { meta: { active: true, priority: 1 }, tags: ['a', 'b'], channelId: '123' },
      query: 'database',
    }) === false,
    'Duplicate tool call with nested permuted key order must be rejected',
  );
  assert(budget.toolCalls === 1, 'Tool call count must not increment on rejected duplicate');

  for (let i = budget.toolCalls; i < 12; i++) budget.markCall('search_messages', { query: `term_${i}` });
  assert(!budget.canToolCall(), 'Tool call budget must be exhausted at 12 calls');
  budget.modelTurns = 6;
  assert(!budget.canModelTurn(), 'Model turn budget must be exhausted at 6 turns');
  budget.modelTurns = 1;
  budget.estimatedInputTokens = 35_000;
  assert(!budget.canModelTurn(), 'Input token limit exceeding 32,000 must stop model turns');
}

async function runAgentFinalizationLoopTests(): Promise<void> {
  const mockStores: Record<string, any> = {
    SelectedChannelStore: { getChannelId: () => 'chan_test_1' },
    ChannelStore: {
      getChannel: (id: string) => ({ id, name: 'general', type: ChannelType.GUILD_TEXT, guild_id: 'guild_test_1' }),
      getChannels: () => [{ id: 'chan_test_1', name: 'general', type: ChannelType.GUILD_TEXT }],
    },
    GuildStore: { getGuild: (id: string) => ({ id, name: 'Test Server' }) },
    UserStore: {
      getCurrentUser: () => ({ id: 'usr_me', username: 'agent_user', globalName: 'Agent Tester' }),
      getUser: (id: string) => ({ id, username: `user_${id}` }),
    },
    PermissionStore: { can: () => true },
  };

  const hadWindow = 'window' in globalThis;
  const originalWindow = (globalThis as any).window;
  const originalFetch = globalThis.fetch;
  (globalThis as any).window = {
    Vencord: {
      Webpack: {
        findStore: (name: string) => mockStores[name] ?? null,
        findByProps: () => null,
      },
    },
  };

  const baseSettings: PluginSettings = {
    providerPreset: 'custom',
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.2,
    maxTokens: 512,
    systemPrompt: 'Be concise.',
    enableVision: false,
    maxContextMessages: 10,
    searchLimitPerQuery: 25,
    maxSearchIterations: 4,
  };

  try {
    // 1. Turn 1 tool call -> Turn 2 direct answer skips redundant finalization
    let turnCount = 0;
    const requestLog: Array<{ body: any }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      turnCount++;
      const parsedBody = JSON.parse(String(init?.body));
      requestLog.push({ body: parsedBody });
      if (turnCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: 'Searching...',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_messages', arguments: JSON.stringify({ query: 'database error', limit: 5 }) } }],
              },
              finish_reason: 'tool_calls',
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Connection pool timeout.' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const runResult = await new AIAssistantAgent(baseSettings).run('Why did the database crash?', []);
    assert(runResult.content.includes('Connection pool timeout'), 'Agent must return direct answer');
    assert(requestLog.length === 2, `Expected 2 HTTP requests, got ${requestLog.length}`);

    // 2. Infinite tool loop hits maxModelTurns and enforces tools-disabled finalization
    requestLog.length = 0;
    turnCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      turnCount++;
      const parsedBody = JSON.parse(String(init?.body));
      requestLog.push({ body: parsedBody });
      if (!parsedBody.tools) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'Finalized answer after turn budget reached.' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: `call_loop_${turnCount}`, type: 'function', function: { name: 'search_messages', arguments: JSON.stringify({ query: `term_${turnCount}` }) } }],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const loopResult = await new AIAssistantAgent(baseSettings).run('Search forever', []);
    assert(loopResult.content.includes('Finalized answer after turn budget reached'), 'Agent must finalize after turn budget');
    assert(requestLog.length === 5, `Expected 5 HTTP calls (4 turns + 1 finalization), got ${requestLog.length}`);
    const lastCall = requestLog[requestLog.length - 1];
    assert(!lastCall.body.tools && lastCall.body.tool_choice === undefined, 'Finalization call must disable tools');
    assert(
      lastCall.body.messages.some((m: any) => m.role === 'system' && String(m.content).includes('Tools are now disabled')),
      'Finalization call must include tools-disabled instruction',
    );

    // 3. Finalization HTTP 500 recovers gracefully without crashing
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body));
      if (!parsedBody.tools) return new Response('Internal Server Error', { status: 500 });
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'call_ctx', type: 'function', function: { name: 'get_current_context', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const failResult = await new AIAssistantAgent({ ...baseSettings, maxSearchIterations: 1 }).run('Test failure', []);
    assert(failResult.content.includes('tools-disabled finalization call failed'), 'Agent must recover gracefully when finalization fails');

    // 4. Aborted signal cancels run immediately
    const abortController = new AbortController();
    abortController.abort();
    let abortedCaught = false;
    try {
      await new AIAssistantAgent(baseSettings).run('Test abort', [], undefined, abortController.signal);
    } catch (err: any) {
      abortedCaught = err.message.includes('Agent execution cancelled by user');
    }
    assert(abortedCaught, 'AbortSignal must trigger cancellation exception');
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) (globalThis as any).window = originalWindow;
    else delete (globalThis as any).window;
  }
}

export async function runCompressionTests(): Promise<void> {
  runTokenEstimationAndCompressionTests();
  await runAgentFinalizationLoopTests();
  console.log('✅ Compression, budget tracking, and agent finalization tests passed');
}
