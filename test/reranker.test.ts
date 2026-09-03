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
  compactToolResult,
  estimateTokens,
  packEvidenceIntoBudget,
  summarizeHistory,
} from '../llm/compression';
import { AgentBudgetTracker, DEFAULT_AGENT_RUN_BUDGET } from '../llm/runBudget';
import { assert } from './assert';

export function runRerankerAndBudgetTests(): void {
  console.log('🧪 Starting Milestone 3: Reranker, Compression & Budgeting Tests...');

  const now = 1776000000000; // Fixed reference timestamp

  const mockCandidate = (
    id: string,
    content: string,
    channelId = 'chan1',
    authorName = 'alice',
    timestamp = now - 1000 * 60 * 60, // 1 hour ago
    extra: Partial<RerankerCandidate> = {},
  ): RerankerCandidate => ({
    id,
    channelId,
    authorId: 'user_' + authorName,
    authorName,
    timestamp,
    content,
    ...extra,
  });

  // =========================================================================
  // 1. Multi-Feature Scoring & RRF Tests
  // =========================================================================
  console.log('  -> Testing Multi-Feature Scoring & RRF...');

  const candA = mockCandidate('1', 'Database migration failed with timeout error', 'chan1', 'alice', now - 10000, {
    bm25Rank: 1,
    bm25Score: 12.5,
    semanticRank: 2,
    semanticScore: 0.88,
  });

  const candB = mockCandidate('2', 'General chat discussion about dinner', 'chan1', 'bob', now - 1000000, {
    bm25Rank: 10,
    bm25Score: 1.2,
    semanticRank: 15,
    semanticScore: 0.12,
  });

  const scoredA = scoreCandidate(candA, [candA, candB], { query: 'database migration', now });
  const scoredB = scoreCandidate(candB, [candA, candB], { query: 'database migration', now });

  assert(scoredA.score > scoredB.score, 'Relevant candidate with high BM25/semantic rank must outscore irrelevant candidate');
  assert(scoredA.exactBonus > 0, 'Exact phrase match must yield exactBonus > 0');
  assert(scoredA.rrfScore > scoredB.rrfScore, 'RRF score for top-ranked candidate must exceed lower-ranked candidate');

  // Recency Decay Verification
  const candRecent = mockCandidate('3', 'Server status OK', 'chan1', 'charlie', now - 1000 * 60 * 60 * 24 * 2); // 2 days ago
  const candOld = mockCandidate('4', 'Server status OK', 'chan1', 'charlie', now - 1000 * 60 * 60 * 24 * 120); // 120 days ago

  const scoredRecent = scoreCandidate(candRecent, [candRecent, candOld], { now });
  const scoredOld = scoreCandidate(candOld, [candRecent, candOld], { now });
  assert(scoredRecent.recencyScore > scoredOld.recencyScore, 'Recent message must have higher recency score than 120-day old message');

  // Continuity Bonus Verification
  const candReply = mockCandidate('5', 'I fixed the issue here', 'chan1', 'alice', now - 5000, { replyParentId: '1' });
  const scoredReply = scoreCandidate(candReply, [candA, candReply], { now });
  assert(scoredReply.continuityScore > 0, 'Reply candidate must receive continuity bonus');

  // =========================================================================
  // 2. MMR Diversity Filtering Tests
  // =========================================================================
  console.log('  -> Testing MMR Diversity Filtering...');

  const duplicateCandidates: RerankerCandidate[] = [
    mockCandidate('10', 'Automated CI/CD build #1042 passed successfully', 'alerts', 'bot', now - 1000, { bm25Rank: 1 }),
    mockCandidate('11', 'Automated CI/CD build #1043 passed successfully', 'alerts', 'bot', now - 2000, { bm25Rank: 2 }),
    mockCandidate('12', 'Automated CI/CD build #1044 passed successfully', 'alerts', 'bot', now - 3000, { bm25Rank: 3 }),
    mockCandidate('13', 'Critical error: auth token secret leaked in logs', 'dev', 'security', now - 4000, { bm25Rank: 4, semanticRank: 1, semanticScore: 0.95 }),
  ];

  const rerankedMMR = rerankCandidates(duplicateCandidates, { query: 'build error', limit: 2, enableMMR: true, mmrLambda: 0.5, now });
  assert(rerankedMMR.length === 2, 'MMR must return requested limit of 2');
  assert(rerankedMMR.some((h) => h.candidate.id === '13'), 'MMR must pick the diverse critical error hit despite duplicate build logs');

  const jaccardIdentical = computeJaccardSimilarity('hello world test', 'hello world test');
  assert(Math.abs(jaccardIdentical - 1.0) < 1e-6, 'Identical strings must have Jaccard similarity 1.0');

  const jaccardDisjoint = computeJaccardSimilarity('database postgres', 'airplane flight ticket');
  assert(jaccardDisjoint === 0, 'Disjoint strings must have Jaccard similarity 0');

  // =========================================================================
  // 3. Conversational Window & Reply Chain Expansion Tests
  // =========================================================================
  console.log('  -> Testing Conversational Window & Reply Chain Expansion...');

  const messagePool: RerankerCandidate[] = [
    mockCandidate('m1', 'What was the root cause of the outage?', 'chan1', 'alice', now - 50000),
    mockCandidate('m2', 'Checking the redis logs now', 'chan1', 'bob', now - 40000, { replyParentId: 'm1' }),
    mockCandidate('m3', 'Found it: Redis OOM error caused by leak', 'chan1', 'bob', now - 30000, { replyParentId: 'm2', bm25Rank: 1 }),
    mockCandidate('m4', 'Deploying hotfix patch', 'chan1', 'charlie', now - 20000),
    mockCandidate('m5', 'Hotfix verified live', 'chan1', 'alice', now - 10000),
  ];

  const primaryHit = scoreCandidate(messagePool[2], messagePool, { query: 'redis oom', now });
  const windows = expandConversationalWindows([primaryHit], messagePool, 2, 3);

  assert(windows.length === 1, 'Should create 1 expanded conversational window');
  assert(windows[0].messages.length >= 3, 'Window must contain adjacent channel turns');
  assert(windows[0].replyChain.length === 2, 'Reply chain must resolve parent messages m1 -> m2');
  assert(windows[0].replyChain[0].id === 'm1', 'Root reply m1 must be at start of chain');

  // Circular Reply Safety
  const circularPool: RerankerCandidate[] = [
    mockCandidate('c1', 'Message 1', 'chan2', 'alice', now - 2000, { replyParentId: 'c2' }),
    mockCandidate('c2', 'Message 2', 'chan2', 'bob', now - 1000, { replyParentId: 'c1' }),
  ];
  const circularHit = scoreCandidate(circularPool[0], circularPool, { now });
  const circularWindows = expandConversationalWindows([circularHit], circularPool, 1, 5);
  assert(circularWindows.length === 1, 'Circular reply reference must resolve safely without infinite recursion');

  // =========================================================================
  // 4. Token Estimation, Compression & Packing Tests
  // =========================================================================
  console.log('  -> Testing Token Estimation, Compression & Budget Packing...');

  const englishTokens = estimateTokens('This is a short English sentence.');
  assert(englishTokens > 5 && englishTokens < 15, 'English token estimate must be realistic (~3.4 chars/token)');

  const cjkTokens = estimateTokens('这是一个测试消息，包含中文字符。');
  assert(cjkTokens >= 10 && cjkTokens <= 25, 'CJK token estimate must account for high token density per character');

  const historySummary = summarizeHistory([
    { id: '1', role: 'user', content: 'Where is the report for Q3?', timestamp: 1 },
    { id: '2', role: 'assistant', content: 'The Q3 financial report is in #general-finance.', timestamp: 2 },
  ]);
  assert(historySummary.includes('user: Where is the report for Q3?'), 'History summary must preserve user turn');
  assert(historySummary.includes('assistant: The Q3 financial report'), 'History summary must preserve assistant turn');

  // Compact Tool Result Test
  const massiveData = {
    ok: true,
    code: 'search_results',
    summary: 'Found 100 messages.',
    untrustedData: true,
    data: {
      messages: Array.from({ length: 80 }, (_, i) => ({
        id: `msg_${i}`,
        content: `Long message text payload repeat ${i} `.repeat(15),
        author: { username: `user_${i}`, id: `id_${i}` },
      })),
    },
  };
  const uncompactedJson = JSON.stringify(massiveData);
  assert(uncompactedJson.length > 25_000, 'Raw payload should exceed 25k characters');

  const compacted = compactToolResult(uncompactedJson, 12_000);
  assert(compacted.length <= 12_000, 'Compacted output must strictly fit within 12,000 character limit');
  const parsedCompacted = JSON.parse(compacted);
  assert(parsedCompacted.ok === true, 'Compacted JSON must remain valid and keep ok: true');
  assert(parsedCompacted.truncation?.truncated === true, 'Compacted JSON must flag truncation.truncated = true');

  // Multi-tier Packing Test
  const packed = packEvidenceIntoBudget(windows, 4000);
  assert(packed.totalTokens <= 4000, 'Packed evidence must strictly respect token budget');
  assert(packed.includedCount > 0, 'Packed evidence must include at least 1 window');

  // =========================================================================
  // 5. Agent Turn & Resource Budget Tracker Tests
  // =========================================================================
  console.log('  -> Testing Agent Turn & Resource Budget Tracker...');

  const budget = new AgentBudgetTracker({
    ...DEFAULT_AGENT_RUN_BUDGET,
    maxModelTurns: 6,
    maxToolCalls: 12,
    maxReturnedRecords: 200,
    maxEstimatedInputTokens: 32_000,
    finalizationCalls: 1,
  });

  assert(budget.canModelTurn(), 'Fresh budget tracker must allow model turn');
  assert(budget.canToolCall(), 'Fresh budget tracker must allow tool call');

  // Test Deduplication
  const callAllowed1 = budget.markCall('search_messages', { query: 'database', limit: 25 });
  assert(callAllowed1 === true, 'First normalized tool call must be allowed');
  assert(budget.toolCalls === 1, 'Tool call count must increment to 1');

  const callAllowed2 = budget.markCall('search_messages', { limit: 25, query: 'database' });
  assert(callAllowed2 === false, 'Duplicate tool call with permuted key order must be rejected');
  assert(budget.toolCalls === 1, 'Tool call count must NOT increment on rejected duplicate');

  // Test Tool Call Limit Exhaustion
  for (let i = budget.toolCalls; i < 12; i++) {
    budget.markCall('search_messages', { query: `term_${i}` });
  }
  assert(!budget.canToolCall(), 'Tool call budget must be exhausted at 12 calls');

  // Test Model Turn Limit Exhaustion
  budget.modelTurns = 6;
  assert(!budget.canModelTurn(), 'Model turn budget must be exhausted at 6 turns');

  // Test Token Limit Exhaustion
  budget.modelTurns = 1;
  budget.estimatedInputTokens = 35_000;
  assert(!budget.canModelTurn(), 'Input token limit exceeding 32,000 must stop model turns');

  console.log('✅ All Milestone 3: Reranker, Compression & Budgeting Tests Passed!');
}

// Execute tests if run directly
if (typeof require !== 'undefined' && require.main === module) {
  runRerankerAndBudgetTests();
}
