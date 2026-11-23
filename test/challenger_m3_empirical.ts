/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  buildConversationContext,
  compactToolResult,
  estimateTokens,
  summarizeHistory,
} from '../llm/compression';
import { AssistantChatMessage, PluginSettings } from '../types';
import { assert } from './assert';

export function runMilestone3ChallengerTests(): void {
  console.log('\n======================================================================');
  console.log('🔥 RUNNING MILESTONE 3 CHALLENGER 1 EMPIRICAL ADVERSARIAL SUITE 🔥');
  console.log('======================================================================\n');

  const now = 1776000000000;

  // =========================================================================
  // SUITE 2: Context Window Budget Boundaries
  // =========================================================================
  console.log('--- Suite 2: Context Window Budget Boundaries ---');

  // Case 2.5: Context builder with 200 history turns and tight input budget
  const mockSettings: PluginSettings = {
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    providerPreset: 'custom',
    baseUrl: 'https://api.openai.com/v1',
    maxTokens: 1000,
    temperature: 0.7,
    systemPrompt: 'You are an assistant.',
    maxContextMessages: 50,
    maxSearchIterations: 5,
    enableVision: false,
    searchLimitPerQuery: 25,
  };

  const hugeHistory: AssistantChatMessage[] = Array.from({ length: 150 }, (_, i) => ({
    id: `hist_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i}: Here is conversation turn details with some explanation text about item #${i}. `.repeat(5),
    timestamp: now - (150 - i) * 60000,
  }));

  const builtContext = buildConversationContext(
    'Developer instructions',
    hugeHistory,
    'What did we discuss in the recent turns?',
    mockSettings,
    4000,
  );

  assert(builtContext.length >= 3, 'Context must include developer prompt, history turns, and user prompt');
  assert(builtContext[0].role === 'developer', 'First message must be developer system prompt');
  assert(builtContext[builtContext.length - 1].role === 'user', 'Last message must be current user prompt');

  const totalContextTokens = estimateTokens(builtContext.map((m) => String(m.content || '')).join('\n'));
  const inputBudget = Math.max(1024, Math.min(Math.max(mockSettings.maxTokens * 4, 8192), 4000) - mockSettings.maxTokens);
  assert(totalContextTokens <= inputBudget + 500, 'Context builder must prune history to stay within budget limit');

  // Case 2.6: Summarize history with empty and single turns
  assert(summarizeHistory([]) === '', 'Empty history summary must be empty string');
  const singleSummary = summarizeHistory([{ id: '1', role: 'user', content: 'hello world', timestamp: 1 }]);
  assert(singleSummary === 'user: hello world', 'Single turn summary must format correctly');

  console.log('✅ Passed Suite 2: Extreme Token Packing & Context Window Budget Boundaries');

  // =========================================================================
  // SUITE 3: Recursive Deep JSON Structures in compactToolResult
  // =========================================================================
  console.log('--- Suite 3: Recursive Deep JSON Structures in compactToolResult ---');

  // Case 3.1: Deeply nested JSON object (depth = 80)
  let deepNested: any = { leaf: 'deep payload '.repeat(200) };
  for (let d = 0; d < 80; d++) {
    deepNested = { level: d, inner: deepNested };
  }
  const deepJsonStr = JSON.stringify({ ok: true, code: 'deep_test', data: deepNested });
  const compactedDeep = compactToolResult(deepJsonStr, 5000);
  assert(compactedDeep.length <= 5000, 'Compacted deep JSON must fit within 5,000 char limit');
  const parsedDeep = JSON.parse(compactedDeep);
  assert(typeof parsedDeep === 'object' && parsedDeep !== null, 'Compacted deep JSON must parse cleanly');

  // Case 3.2: Extremely wide object (3,000 keys)
  const wideObj: Record<string, string> = {};
  for (let k = 0; k < 3000; k++) {
    wideObj[`key_${k}`] = `value payload content for key ${k} `.repeat(10);
  }
  const wideJsonStr = JSON.stringify({ ok: true, data: wideObj });
  const compactedWide = compactToolResult(wideJsonStr, 4000);
  assert(compactedWide.length <= 4000, 'Compacted wide JSON must fit within 4,000 char limit');
  const parsedWide = JSON.parse(compactedWide);
  assert(parsedWide !== null && typeof parsedWide === 'object', 'Compacted wide JSON must parse into valid object');

  // Case 3.3: Primitive JSON payloads & non-object JSON values
  const primitiveString = compactToolResult(JSON.stringify('simple string payload'), 100);
  assert(primitiveString.length <= 100, 'Primitive string JSON must compact safely');

  const primitiveNumber = compactToolResult(JSON.stringify(123456789), 100);
  assert(primitiveNumber.length <= 100, 'Primitive number JSON must compact safely');

  const primitiveNull = compactToolResult(JSON.stringify(null), 100);
  assert(primitiveNull.length <= 100, 'Primitive null JSON must compact safely');

  // Case 3.4: Corrupted / invalid non-JSON strings (> maxChars)
  const invalidJsonLarge = 'This is clearly not valid JSON <<{{{}}}>> '.repeat(50);
  const compactedInvalidLarge = compactToolResult(invalidJsonLarge, 50);
  const parsedInvalidLarge = JSON.parse(compactedInvalidLarge);
  assert(parsedInvalidLarge.ok === false, 'Large invalid JSON input must return ok: false');
  assert(parsedInvalidLarge.code === 'invalid_tool_output', 'Large invalid JSON input must return invalid_tool_output error code');

  // Case 3.4b: Small raw strings (<= maxChars) are preserved as-is
  const smallRaw = 'Small raw tool output text';
  assert(compactToolResult(smallRaw, 100) === smallRaw, 'Small raw tool output within maxChars must be preserved without parsing overhead');

  // Case 3.5: Messages array with 200 large messages (progressive popping verification)
  const largeMessagesPayload = {
    ok: true,
    code: 'search_results',
    summary: 'Search matched 200 messages.',
    untrustedData: true,
    data: {
      messages: Array.from({ length: 200 }, (_, i) => ({
        id: `msg_rec_${i}`,
        content: `Detailed message content ${i} `.repeat(25),
        author: { username: `user_${i}`, id: `id_${i}` },
      })),
    },
  };
  const largeJson = JSON.stringify(largeMessagesPayload);
  const compactedLarge = compactToolResult(largeJson, 8000);
  assert(compactedLarge.length <= 8000, 'Progressive popping must reduce size to <= 8000 chars');
  const parsedLarge = JSON.parse(compactedLarge);
  assert(parsedLarge.ok === true, 'Compacted large results must remain ok: true');
  assert(parsedLarge.truncation?.truncated === true, 'Compacted large results must mark truncation.truncated = true');
  assert(parsedLarge.data?.messages?.length < 200, 'Messages count must be trimmed');

  // Case 3.6: Fallback for extreme unbreakable payload
  const unbreakablePayload = {
    ok: true,
    code: 'huge_blob',
    summary: 'Huge binary string',
    untrustedData: true,
    data: {
      blob: 'X'.repeat(50_000),
    },
  };
  const compactedFallback = compactToolResult(JSON.stringify(unbreakablePayload), 1000);
  assert(compactedFallback.length <= 1000, 'Fallback JSON must strictly fit within 1000 chars');
  const parsedFallback = JSON.parse(compactedFallback);
  assert(parsedFallback.ok === true && parsedFallback.truncation?.returned === 0, 'Fallback JSON must preserve safety flags');

  console.log('✅ Passed Suite 3: Recursive Deep JSON Structures in compactToolResult');

  // =========================================================================
  // SUITE 4: Token Estimation Accuracy & Multilingual Scaling
  // =========================================================================
  console.log('--- Suite 4: Token Estimation Accuracy & Multilingual Scaling ---');

  // Case 4.1: Empty and whitespace strings
  assert(estimateTokens('') === 0, 'Empty string token count must be 0');
  assert(estimateTokens('   ') === 1, 'Short whitespace token count must be 1');

  // Case 4.2: English ASCII text ratio verification
  const englishSentence = 'The quick brown fox jumps over the lazy dog. A secondary test sentence for verification.';
  const engTokens = estimateTokens(englishSentence);
  const engChars = englishSentence.length;
  const ratio = engChars / engTokens;
  assert(ratio >= 3.0 && ratio <= 3.6, `English char/token ratio should be ~3.4 (actual: ${ratio.toFixed(2)})`);

  // Case 4.3: Multilingual CJK token scaling
  const chineseText = '这是一个用于测试中文分词与标记数量估计的完整段落。包含多个汉字。';
  const cjkTokens = estimateTokens(chineseText);
  // CJK characters should be weighted at ~0.9 tokens per char
  assert(cjkTokens >= chineseText.length * 0.8 && cjkTokens <= chineseText.length * 1.2, 'CJK tokens should scale at ~0.9 tokens/character');

  const japaneseText = 'こんにちは世界！ひらがなとカタカナと漢字が混ざったテスト文章です。';
  const jpTokens = estimateTokens(japaneseText);
  assert(jpTokens >= japaneseText.length * 0.8 && jpTokens <= japaneseText.length * 1.2, 'Japanese Hiragana/Katakana/Kanji should scale densely');

  const koreanText = '안녕하세요 이것은 한국어 토큰 추정 테스트입니다.';
  const krTokens = estimateTokens(koreanText);
  assert(krTokens >= koreanText.length * 0.7 && krTokens <= koreanText.length * 1.2, 'Korean Hangul should scale densely');

  // Case 4.4: Complex emojis and surrogate pairs
  const emojiText = '🚀🔥🎉✨👨‍👩‍👧‍👧👍❤️';
  const emojiTokens = estimateTokens(emojiText);
  assert(emojiTokens >= 2 && emojiTokens <= 15, 'Emoji string should estimate reasonably without crashing');

  // Case 4.5: High-scale performance (1,000,000 characters benchmark)
  const hugeText = 'Sample benchmark text line with numbers 12345 and words. '.repeat(17_500); // ~1M chars
  const benchStart = performance.now();
  const hugeEstimate = estimateTokens(hugeText);
  const benchDuration = performance.now() - benchStart;
  assert(hugeEstimate > 200_000, '1M character token estimate should be > 200k tokens');
  assert(benchDuration < 50, `1M char token estimation must complete in < 50ms (actual: ${benchDuration.toFixed(2)}ms)`);
  console.log(`   ⚡ 1,000,000 chars token estimated in ${benchDuration.toFixed(2)}ms -> ${hugeEstimate} tokens`);

  console.log('✅ Passed Suite 4: Token Estimation Accuracy & Multilingual Scaling');

  console.log('\n======================================================================');
  console.log('🎯 ALL MILESTONE 3 CHALLENGER 1 ADVERSARIAL TESTS PASSED (3/3 SUITES)');
  console.log('======================================================================\n');
}

// Auto-run if executed directly
if (typeof require !== 'undefined' && require.main === module) {
  runMilestone3ChallengerTests();
}
