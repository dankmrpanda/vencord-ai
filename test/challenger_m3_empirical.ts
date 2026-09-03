/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  computeJaccardSimilarity,
  expandConversationalWindows,
  rerankCandidates,
  RerankerCandidate,
  scoreCandidate,
} from '../llm/reranker';
import {
  buildConversationContext,
  compactToolResult,
  estimateTokens,
  packEvidenceIntoBudget,
  summarizeHistory,
} from '../llm/compression';
import { AssistantChatMessage, PluginSettings } from '../types';
import { assert } from './assert';

export function runMilestone3ChallengerTests(): void {
  console.log('\n======================================================================');
  console.log('🔥 RUNNING MILESTONE 3 CHALLENGER 1 EMPIRICAL ADVERSARIAL SUITE 🔥');
  console.log('======================================================================\n');

  const now = 1776000000000;

  const mockCandidate = (
    id: string,
    content: string,
    channelId = 'chan_1',
    authorName = 'user_test',
    timestamp = now - 60000,
    extra: Partial<RerankerCandidate> = {},
  ): RerankerCandidate => ({
    id,
    channelId,
    authorId: `author_${authorName}`,
    authorName,
    timestamp,
    content,
    ...extra,
  });

  // =========================================================================
  // SUITE 1: Adversarial Reply-Chain Cycles & Window Expansion
  // =========================================================================
  console.log('--- Suite 1: Adversarial Reply-Chain Cycles & Window Expansion ---');

  // Case 1.1: Direct self-referential loop (A -> A)
  const selfLoopMsg = mockCandidate('self_1', 'Self referential message', 'chan_cycle', 'alice', now - 1000, {
    replyParentId: 'self_1',
  });
  const selfScored = scoreCandidate(selfLoopMsg, [selfLoopMsg], { now });
  const selfWindows = expandConversationalWindows([selfScored], [selfLoopMsg], 3, 5);
  assert(selfWindows.length === 1, 'Must create 1 window for self-referential message');
  assert(selfWindows[0].replyChain.length === 0, 'Self-referential reply chain must not include self as parent');

  // Case 1.2: 2-node mutual cycle (A -> B -> A)
  const nodeA = mockCandidate('cyc_A', 'Cycle Node A', 'chan_cycle', 'alice', now - 2000, { replyParentId: 'cyc_B' });
  const nodeB = mockCandidate('cyc_B', 'Cycle Node B', 'chan_cycle', 'bob', now - 1000, { replyParentId: 'cyc_A' });
  const cyclePool2 = [nodeA, nodeB];
  const hitA = scoreCandidate(nodeA, cyclePool2, { now });
  const hitB = scoreCandidate(nodeB, cyclePool2, { now });

  const winA = expandConversationalWindows([hitA], cyclePool2, 2, 10);
  assert(winA.length === 1, '2-node cycle from nodeA must resolve safely');
  assert(winA[0].replyChain.length === 1 && winA[0].replyChain[0].id === 'cyc_B', 'Reply chain from nodeA should contain only nodeB');

  const winB = expandConversationalWindows([hitB], cyclePool2, 2, 10);
  assert(winB.length === 1, '2-node cycle from nodeB must resolve safely');
  assert(winB[0].replyChain.length === 1 && winB[0].replyChain[0].id === 'cyc_A', 'Reply chain from nodeB should contain only nodeA');

  // Case 1.3: N-node deep cycle (1 -> 2 -> 3 -> 4 -> 5 -> 2)
  const nCyclePool: RerankerCandidate[] = [];
  for (let i = 1; i <= 5; i++) {
    const parentId = i === 5 ? 'n_2' : `n_${i + 1}`;
    nCyclePool.push(mockCandidate(`n_${i}`, `N-cycle step ${i}`, 'chan_n_cycle', `user_${i}`, now - (10 - i) * 1000, {
      replyParentId: parentId,
    }));
  }
  const hitN1 = scoreCandidate(nCyclePool[0], nCyclePool, { now });
  const winNCycle = expandConversationalWindows([hitN1], nCyclePool, 3, 20);
  assert(winNCycle.length === 1, 'N-node cycle must terminate safely without hanging');
  assert(winNCycle[0].replyChain.length <= 5, 'Reply chain length must not exceed unique candidate count');

  // Case 1.4: 1,000-deep chain with depth limit enforcement
  const deepPool: RerankerCandidate[] = [];
  for (let i = 0; i < 1000; i++) {
    deepPool.push(mockCandidate(`deep_${i}`, `Deep step ${i}`, 'chan_deep', 'user_deep', now - (1000 - i) * 100, {
      replyParentId: i > 0 ? `deep_${i - 1}` : undefined,
    }));
  }
  const hitDeep = scoreCandidate(deepPool[999], deepPool, { now });
  const winDeep5 = expandConversationalWindows([hitDeep], deepPool, 2, 5);
  assert(winDeep5[0].replyChain.length === 5, 'Max reply depth of 5 must be strictly respected');
  assert(winDeep5[0].replyChain[0].id === 'deep_994', 'Root of bounded depth chain must be at index -5');

  const winDeep0 = expandConversationalWindows([hitDeep], deepPool, 2, 0);
  assert(winDeep0[0].replyChain.length === 0, 'Max reply depth of 0 must produce empty reply chain');

  // Case 1.5: Dangling reply parents (parent ID points to nonexistent message)
  const danglingMsg = mockCandidate('dang_1', 'Reply to deleted ghost message', 'chan_dang', 'alice', now - 500, {
    replyParentId: 'nonexistent_message_id_99999',
  });
  const winDang = expandConversationalWindows([scoreCandidate(danglingMsg, [danglingMsg], { now })], [danglingMsg], 2, 5);
  assert(winDang.length === 1, 'Dangling reply parent must not throw or fail');
  assert(winDang[0].replyChain.length === 0, 'Dangling parent must result in empty replyChain');

  // Case 1.6: Temporal window bounding with out-of-order & wide timestamp spread
  const timeSpreadPool: RerankerCandidate[] = [
    mockCandidate('t_far_past', 'Old message 20 min ago', 'chan_time', 'alice', now - 20 * 60 * 1000),
    mockCandidate('t_mid_past', 'Message 4 min ago', 'chan_time', 'bob', now - 4 * 60 * 1000),
    mockCandidate('t_anchor', 'Anchor query match', 'chan_time', 'charlie', now),
    mockCandidate('t_mid_future', 'Message 2 min later', 'chan_time', 'dave', now + 2 * 60 * 1000),
    mockCandidate('t_far_future', 'Message 15 min later', 'chan_time', 'eve', now + 15 * 60 * 1000),
  ];
  // Scramble order in message pool
  const scrambledPool = [timeSpreadPool[4], timeSpreadPool[0], timeSpreadPool[2], timeSpreadPool[1], timeSpreadPool[3]];
  const hitAnchor = scoreCandidate(timeSpreadPool[2], scrambledPool, { now });
  const winTime = expandConversationalWindows([hitAnchor], scrambledPool, 5, 2);

  assert(winTime.length === 1, 'Temporal window must be created');
  const winMsgIds = winTime[0].messages.map((m) => m.id);
  assert(!winMsgIds.includes('t_far_past'), 'Messages > 5 min in past must be excluded by temporal window');
  assert(!winMsgIds.includes('t_far_future'), 'Messages > 5 min in future must be excluded by temporal window');
  assert(winMsgIds.includes('t_mid_past') && winMsgIds.includes('t_anchor') && winMsgIds.includes('t_mid_future'), 'Messages within 5 min must be included in temporal window');

  // Case 1.7: Multi-hit deduplication
  const multiHitA = scoreCandidate(timeSpreadPool[2], scrambledPool, { now });
  const multiHitB = scoreCandidate(timeSpreadPool[1], scrambledPool, { now }); // Adjacent in same window
  const multiWins = expandConversationalWindows([multiHitA, multiHitB], scrambledPool, 3, 2);
  assert(multiWins.length === 1, 'Adjacent hits in the same channel window must deduplicate into 1 window');

  console.log('✅ Passed Suite 1: Adversarial Reply-Chain Cycles & Window Expansion');

  // =========================================================================
  // SUITE 2: Extreme Token Packing & Context Window Budget Boundaries
  // =========================================================================
  console.log('--- Suite 2: Extreme Token Packing & Context Window Budget Boundaries ---');

  // Case 2.1: Multi-tier evidence packing across Tier 1, Tier 2, and Tier 3
  const fakeWindows = Array.from({ length: 25 }, (_, i) => ({
    anchorHit: scoreCandidate(
      mockCandidate(`win_hit_${i}`, `Anchor text for message ${i} containing discussion and details.`, `chan_${i % 3}`, `user_${i}`, now - i * 1000),
      [],
      { now },
    ),
    channelId: `chan_${i % 3}`,
    messages: [
      mockCandidate(`win_msg_${i}_1`, `Message 1 in window ${i}`, `chan_${i % 3}`, `user_${i}`, now - i * 1000),
      mockCandidate(`win_msg_${i}_2`, `Message 2 in window ${i}`, `chan_${i % 3}`, `user_${i}`, now - i * 1000 + 500),
    ],
    replyChain: i === 0 ? [mockCandidate('win_rep_0', 'Root reply discussion', 'chan_0', 'root_user', now - 2000)] : [],
    startTime: now - i * 1000,
    endTime: now - i * 1000 + 500,
    compositeScore: 100 - i * 2,
  }));

  const packedNormal = packEvidenceIntoBudget(fakeWindows, 8000);
  assert(packedNormal.includedCount === 25, '8000 token budget should accommodate all 25 test windows');
  assert(packedNormal.totalTokens <= 8000, 'Total tokens must not exceed budget');
  assert(packedNormal.packedText.includes('[Hit 1 | Score:'), 'Tier 1 window must include full header and score');
  assert(packedNormal.packedText.includes('[Replies]: @root_user:'), 'Tier 1 window must include reply chain');
  assert(packedNormal.packedText.includes('[Hit 4]'), 'Tier 2 window (idx 3) must use standard single-line format');

  // Case 2.2: Hard zero and tiny budgets
  const packedZero = packEvidenceIntoBudget(fakeWindows, 0);
  assert(packedZero.includedCount === 0 && packedZero.totalTokens === 0 && packedZero.packedText === '', '0 token budget must return empty packing');

  const packedTiny = packEvidenceIntoBudget(fakeWindows, 5);
  assert(packedTiny.includedCount === 0 && packedTiny.totalTokens === 0 && packedTiny.packedText === '', '5 token budget (smaller than any window) must return 0 included');

  // Case 2.3: Over-budget boundary check
  const packedSmall = packEvidenceIntoBudget(fakeWindows, 80);
  assert(packedSmall.totalTokens <= 80, 'Small token budget must never exceed maxTokens');
  assert(packedSmall.includedCount > 0 && packedSmall.includedCount < 5, 'Small budget must pack 1-4 windows only');

  // Case 2.4: Empty windows array
  const packedEmpty = packEvidenceIntoBudget([], 5000);
  assert(packedEmpty.includedCount === 0 && packedEmpty.totalTokens === 0 && packedEmpty.packedText === '', 'Empty windows array must return empty result');

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

  // =========================================================================
  // SUITE 5: MMR Diversity & Cross-Scoring Edge Cases
  // =========================================================================
  console.log('--- Suite 5: MMR Diversity & Cross-Scoring Edge Cases ---');

  // Case 5.1: Empty and single-candidate reranking
  assert(rerankCandidates([]).length === 0, 'Empty candidate list should rerank to empty array');

  const singleCand = mockCandidate('sc_1', 'Single hit candidate', 'chan_single', 'alice', now);
  const rerankedSingle = rerankCandidates([singleCand], { query: 'single', limit: 10 });
  assert(rerankedSingle.length === 1, 'Single candidate reranking should return 1 hit');

  // Case 5.2: Identical candidate content with different IDs
  const identicalCandidates = [
    mockCandidate('dup_1', 'Exact duplicate status report text', 'chan_dup', 'alice', now - 1000, { bm25Rank: 1 }),
    mockCandidate('dup_2', 'Exact duplicate status report text', 'chan_dup', 'bob', now - 2000, { bm25Rank: 2 }),
    mockCandidate('dup_3', 'Completely different database error alert', 'chan_dup', 'charlie', now - 3000, { bm25Rank: 3 }),
  ];
  const mmrDiversified = rerankCandidates(identicalCandidates, {
    limit: 2,
    enableMMR: true,
    mmrLambda: 0.5,
    now,
  });
  assert(mmrDiversified.length === 2, 'MMR should return 2 candidates');
  assert(mmrDiversified.some((c) => c.candidate.id === 'dup_3'), 'MMR must select the diverse different candidate over the duplicate');

  // Case 5.3: Jaccard similarity edge cases
  assert(computeJaccardSimilarity('', '') === 0, 'Empty strings Jaccard similarity must be 0');
  assert(computeJaccardSimilarity('   ', '   ') === 1.0, 'Identical whitespace strings hit identity fast-path (1.0)');
  assert(computeJaccardSimilarity('   ', '    ') === 0, 'Disparate whitespace strings evaluate to 0 tokens -> 0');
  assert(computeJaccardSimilarity('a', 'a') === 1.0, 'Identical single word similarity must be 1.0');
  assert(computeJaccardSimilarity('a', 'b') === 0.0, 'Disjoint single word similarity must be 0.0');

  console.log('✅ Passed Suite 5: MMR Diversity & Cross-Scoring Edge Cases');

  console.log('\n======================================================================');
  console.log('🎯 ALL MILESTONE 3 CHALLENGER 1 ADVERSARIAL TESTS PASSED (5/5 SUITES)');
  console.log('======================================================================\n');
}

// Auto-run if executed directly
if (typeof require !== 'undefined' && require.main === module) {
  runMilestone3ChallengerTests();
}
