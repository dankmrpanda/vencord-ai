/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  AgentBudgetTracker,
  compactToolResult,
  DEFAULT_AGENT_RUN_BUDGET,
  estimateTokens,
  summarizeHistory,
} from '../llm/compression';
import { assert } from './assert';

export function runRerankerAndBudgetTests(): void {
  console.log('🧪 Starting Milestone 3: Compression & Budgeting Tests...');

  // =========================================================================
  // 1. Token Estimation & Compression Tests
  // =========================================================================
  console.log('  -> Testing Token Estimation & Compression...');

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

  // =========================================================================
  // 2. Agent Turn & Resource Budget Tracker Tests
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
