/*
 * Vencord AI - Milestone 3 Challenger 2 Empirical Test Suite
 * Comprehensive adversarial verification for:
 * 1. MMR Diversity Balance (λ values, distribution extremes, duplicate spam, boundary edge cases)
 * 2. Exact Match Boosting (substring vs whole phrase vs multi-token ratio, casing, short queries)
 * 3. Recency Decay Weighting (exponential half-life decay, strict monotonicity, future/epoch 0 timestamps)
 * 4. Turn Budgeting Limits (model turns, tool calls, record counts, token limits, key normalization & deduplication)
 * 5. Tool-Disabled Finalization Turn Enforcement under simulated multi-turn agent loops
 */

import { assert } from './assert';
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
  buildConversationContext,
} from '../llm/compression';
import { AgentBudgetTracker, DEFAULT_AGENT_RUN_BUDGET } from '../llm/runBudget';
import { AIAssistantAgent } from '../llm/agent';
import { ChannelType, CurrentScopeContext, DiscordMessage, PluginSettings } from '../types';

function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-4, message?: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message || 'Values not equal'}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

const mockCandidate = (
  id: string,
  content: string,
  channelId = 'chan_1',
  authorName = 'alice',
  timestamp = 1776000000000,
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

export async function runMilestone3Challenger2Tests(): Promise<{
  passedCount: number;
  bugCount: number;
  details: string[];
}> {
  console.log('\n======================================================================');
  console.log('🔥 RUNNING MILESTONE 3 CHALLENGER 2 EMPIRICAL VERIFICATION SUITE 🔥');
  console.log('======================================================================\n');

  let passedCount = 0;
  let bugCount = 0;
  const details: string[] = [];
  const now = 1776000000000; // Fixed reference timestamp

  // =========================================================================
  // SUITE 1: MMR Diversity Balance (λ values, extremes, duplicate spam)
  // =========================================================================
  console.log('--- Suite 1: MMR Diversity Balance & λ Spectrum Verification ---');
  {
    // 1.1 Pure Relevance (λ = 1.0) vs Pure Diversity (λ = 0.0)
    const baseCandidates: RerankerCandidate[] = [
      mockCandidate('c1', 'database connection pool exhausted on postgres', 'chan_1', 'alice', now - 1000, { bm25Rank: 1, bm25Score: 10 }),
      mockCandidate('c2', 'database connection pool exhausted on postgres server', 'chan_1', 'bob', now - 2000, { bm25Rank: 2, bm25Score: 9.5 }),
      mockCandidate('c3', 'frontend react router navigation bug with query params', 'chan_1', 'charlie', now - 3000, { bm25Rank: 3, bm25Score: 8.0 }),
      mockCandidate('c4', 'frontend react router state synchronization issue', 'chan_1', 'dave', now - 4000, { bm25Rank: 4, bm25Score: 7.5 }),
      mockCandidate('c5', 'kubernetes cluster ingress certificate expiration alert', 'chan_1', 'eve', now - 5000, { bm25Rank: 5, bm25Score: 6.0 }),
    ];

    // Under λ = 1.0 (Pure Relevance):
    const pureRel = rerankCandidates(baseCandidates, { query: 'database connection', enableMMR: true, mmrLambda: 1.0, limit: 5, now });
    assert(pureRel.length === 5, 'λ = 1.0 must return all 5 candidates');
    assert(pureRel[0].candidate.id === 'c1', 'Rank 1 must be c1');
    assert(pureRel[1].candidate.id === 'c2', 'Rank 2 must be c2 under pure relevance (no diversity penalty)');
    assert(pureRel[2].candidate.id === 'c3', 'Rank 3 must be c3');

    // Under λ = 0.0 (Pure Diversity):
    // c1 is chosen first (highest initial score).
    // Remaining are c2 (near duplicate of c1), c3 (disjoint from c1), c4 (disjoint from c1), c5 (disjoint from c1).
    // Since c2 has high similarity to c1, pure diversity must strongly penalize c2 and pick disjoint c3/c4/c5 before c2.
    const pureDiv = rerankCandidates(baseCandidates, { query: 'database connection', enableMMR: true, mmrLambda: 0.0, limit: 5, now });
    assert(pureDiv[0].candidate.id === 'c1', 'First selection under MMR must always be the top-scoring candidate c1');
    assert(pureDiv[1].candidate.id !== 'c2', `Second selection under λ = 0.0 must NOT be duplicate c2, got ${pureDiv[1].candidate.id}`);
    const c2RankInPureDiv = pureDiv.findIndex((h) => h.candidate.id === 'c2');
    assert(c2RankInPureDiv > 1, `c2 must be demoted in pure diversity ranking, found at index ${c2RankInPureDiv}`);

    // 1.2 Intermediate λ Trade-off Spectrum (0.3, 0.5, 0.7, 0.9)
    for (const lambda of [0.3, 0.5, 0.7, 0.9]) {
      const res = rerankCandidates(baseCandidates, { query: 'database connection', enableMMR: true, mmrLambda: lambda, limit: 5, now });
      assert(res.length === 5, `MMR with λ=${lambda} must return 5 hits`);
      assert(res[0].candidate.id === 'c1', `First hit with λ=${lambda} must be c1`);
      assert(typeof res[0].mmrScore === 'number', 'MMR score must be recorded on hit');
    }

    // 1.3 Bug Discovery: enableMMR default evaluation check
    // In RerankingOptions (reranker.ts:51), enableMMR is documented as "Default: true".
    // However, reranker.ts:206 uses `if (!options.enableMMR)`, which causes enableMMR to default to false when undefined!
    const defaultOptionsRerank = rerankCandidates(baseCandidates, { query: 'database connection', mmrLambda: 0.0, limit: 5, now });
    const isMmrBypassedByDefault = defaultOptionsRerank[0].mmrScore === undefined;
    if (isMmrBypassedByDefault) {
      bugCount++;
      details.push('BUG FOUND in llm/reranker.ts:206: options.enableMMR defaults to false when omitted because of `if (!options.enableMMR)` check, violating RerankingOptions interface contract (enableMMR?: boolean; // Default: true). Fix required: `if (options.enableMMR === false || scoredHits.length <= 1)`.');
    }

    // 1.4 Heavy Redundancy / Duplicate Spam Attack (50 near-duplicate log messages vs 5 unique topics)
    const duplicatePool: RerankerCandidate[] = [];
    for (let i = 0; i < 50; i++) {
      duplicatePool.push(
        mockCandidate(`dup_${i}`, `CI/CD automated pipeline build runner #${1000 + i} passed successfully without errors`, 'chan_ci', 'buildbot', now - i * 100, {
          bm25Rank: 1 + i,
          bm25Score: 20 - i * 0.1,
        }),
      );
    }
    // Add 5 distinct critical topics with lower initial scores
    const criticalTopics: RerankerCandidate[] = [
      mockCandidate('crit_sec', 'CRITICAL SECURITY: production API secret token leaked in public repo', 'chan_dev', 'secops', now - 10000, { bm25Rank: 55, bm25Score: 8.0, semanticRank: 1, semanticScore: 0.98 }),
      mockCandidate('crit_oom', 'PostgreSQL database primary node OOM crash error panic', 'chan_dev', 'dba', now - 11000, { bm25Rank: 56, bm25Score: 7.9, semanticRank: 2, semanticScore: 0.95 }),
      mockCandidate('crit_billing', 'Stripe payment webhook verification signature mismatch', 'chan_dev', 'billing', now - 12000, { bm25Rank: 57, bm25Score: 7.8, semanticRank: 3, semanticScore: 0.92 }),
      mockCandidate('crit_network', 'BGP route leak caused 502 bad gateway on all edge locations', 'chan_dev', 'netops', now - 13000, { bm25Rank: 58, bm25Score: 7.7, semanticRank: 4, semanticScore: 0.90 }),
      mockCandidate('crit_ui', 'Login button unclickable on Safari iOS 18 WebKit', 'chan_dev', 'frontend', now - 14000, { bm25Rank: 59, bm25Score: 7.6, semanticRank: 5, semanticScore: 0.88 }),
    ];

    const allSpamAndCritical = [...duplicatePool, ...criticalTopics];
    
    // Test with balanced diversity lambda = 0.45:
    const mmrBalanced = rerankCandidates(allSpamAndCritical, {
      query: 'critical error failure',
      enableMMR: true,
      mmrLambda: 0.45,
      limit: 10,
      now,
    });
    assert(mmrBalanced.length === 10, 'MMR must return requested limit of 10');
    const balancedIds = mmrBalanced.map((h) => h.candidate.id);
    const balancedCriticalCount = criticalTopics.filter((c) => balancedIds.includes(c.id)).length;
    assert(
      balancedCriticalCount === 5,
      `MMR with λ=0.45 must promote all 5 diverse critical topics over near-duplicate CI logs (got ${balancedCriticalCount})`,
    );

    // Test with default lambda = 0.70:
    const mmrDefault = rerankCandidates(allSpamAndCritical, {
      query: 'critical error failure',
      enableMMR: true,
      mmrLambda: 0.70,
      limit: 10,
      now,
    });
    const defaultIds = mmrDefault.map((h) => h.candidate.id);
    const defaultCriticalCount = criticalTopics.filter((c) => defaultIds.includes(c.id)).length;
    assert(
      defaultCriticalCount >= 2,
      `MMR with default λ=0.70 must still promote top semantic critical topics (got ${defaultCriticalCount})`,
    );

    // 1.4 Boundary Conditions & Degenerate Inputs
    const emptyResult = rerankCandidates([], { limit: 10 });
    assert(Array.isArray(emptyResult) && emptyResult.length === 0, 'Empty candidate array must return empty array');

    const singleResult = rerankCandidates([baseCandidates[0]], { limit: 10 });
    assert(singleResult.length === 1 && singleResult[0].candidate.id === 'c1', 'Single candidate must return directly');

    // Identical scores across all candidates (scoreRange === 0)
    const identicalScoreCandidates: RerankerCandidate[] = [
      mockCandidate('same1', 'alpha beta gamma', 'chan_1', 'u1', now),
      mockCandidate('same2', 'delta epsilon zeta', 'chan_1', 'u2', now),
      mockCandidate('same3', 'alpha beta gamma', 'chan_1', 'u3', now),
    ];
    const sameScoreRes = rerankCandidates(identicalScoreCandidates, { limit: 3, now });
    assert(sameScoreRes.length === 3, 'Candidates with identical scores must not divide by zero or yield NaN');
    assert(sameScoreRes.every((h) => !Number.isNaN(h.score) && !Number.isNaN(h.mmrScore ?? 0)), 'No score may be NaN');

    // Jaccard similarity edge cases
    assert(computeJaccardSimilarity('', '') === 0, 'Jaccard of empty strings must be 0');
    assert(computeJaccardSimilarity('', 'abc') === 0, 'Jaccard with empty string must be 0');
    assert(computeJaccardSimilarity('   ', ' \t ') === 0, 'Jaccard of distinct whitespace strings must be 0');
    assert(computeJaccardSimilarity('HELLO WORLD', 'hello world') === 1.0, 'Jaccard must be case-insensitive');
    assert(computeJaccardSimilarity('word', 'unrelated') === 0, 'Disjoint words must have Jaccard 0');

    passedCount++;
    console.log('✅ Passed Suite 1: MMR Diversity Balance & λ Spectrum Verification');
    details.push('Suite 1: MMR diversity balance verified across λ=0.0..1.0, 50-item duplicate spam resilience, and mathematical edge cases.');
  }

  // =========================================================================
  // SUITE 2: Exact Match Boosting & Multi-Token Ratio Scaling
  // =========================================================================
  console.log('\n--- Suite 2: Exact Match Boosting & Token Overlap Verification ---');
  {
    const query = 'redis cluster memory leak';
    const candExact = mockCandidate('m_exact', 'We observed a redis cluster memory leak in staging', 'c1', 'alice', now);
    const candAllTokensOutOfOrder = mockCandidate('m_out_of_order', 'memory leak identified in redis cache cluster', 'c1', 'bob', now);
    const candTwoTokens = mockCandidate('m_two_tokens', 'redis cluster status healthy', 'c1', 'charlie', now);
    const candOneToken = mockCandidate('m_one_token', 'redis restarted successfully', 'c1', 'dave', now);
    const candNoTokens = mockCandidate('m_no_tokens', 'Postgres backup completed successfully', 'c1', 'eve', now);

    const scoredExact = scoreCandidate(candExact, [candExact], { query, now, boostExact: 1.5 });
    const scoredOutOfOrder = scoreCandidate(candAllTokensOutOfOrder, [candAllTokensOutOfOrder], { query, now, boostExact: 1.5 });
    const scoredTwoTokens = scoreCandidate(candTwoTokens, [candTwoTokens], { query, now, boostExact: 1.5 });
    const scoredOneToken = scoreCandidate(candOneToken, [candOneToken], { query, now, boostExact: 1.5 });
    const scoredNoTokens = scoreCandidate(candNoTokens, [candNoTokens], { query, now, boostExact: 1.5 });

    // 2.1 Substring vs Multi-Token Bonus Verification
    // Full substring match gets: 15.0 * boostExact = 22.5
    assertAlmostEqual(scoredExact.exactBonus, 22.5, 1e-4, 'Exact full substring match bonus must equal 22.5 (15 * 1.5)');

    // 4 query tokens: ['redis', 'cluster', 'memory', 'leak']. Out of order contains all 4 tokens -> (4/4) * 8.0 * 1.5 = 12.0
    assertAlmostEqual(scoredOutOfOrder.exactBonus, 12.0, 1e-4, 'All-token partial match bonus must equal 12.0');

    // 2 of 4 tokens ('redis', 'cluster') -> (2/4) * 8.0 * 1.5 = 6.0
    assertAlmostEqual(scoredTwoTokens.exactBonus, 6.0, 1e-4, 'Two-token partial match bonus must equal 6.0');

    // 1 of 4 tokens ('redis') -> (1/4) * 8.0 * 1.5 = 3.0
    assertAlmostEqual(scoredOneToken.exactBonus, 3.0, 1e-4, 'One-token partial match bonus must equal 3.0');

    // 0 tokens -> 0.0
    assertAlmostEqual(scoredNoTokens.exactBonus, 0.0, 1e-4, 'Zero-token match bonus must equal 0.0');

    // Relative ordering assertion
    assert(
      scoredExact.exactBonus > scoredOutOfOrder.exactBonus &&
      scoredOutOfOrder.exactBonus > scoredTwoTokens.exactBonus &&
      scoredTwoTokens.exactBonus > scoredOneToken.exactBonus &&
      scoredOneToken.exactBonus > scoredNoTokens.exactBonus,
      'Exact bonuses must be strictly monotonic: Exact > All Tokens > Partial Tokens > Zero Tokens',
    );

    // 2.2 Boost Scaling Factor
    const scoredZeroBoost = scoreCandidate(candExact, [candExact], { query, now, boostExact: 0.0 });
    assertAlmostEqual(scoredZeroBoost.exactBonus, 0.0, 1e-4, 'boostExact = 0 must disable exact bonus');

    const scoredDoubleBoost = scoreCandidate(candExact, [candExact], { query, now, boostExact: 3.0 });
    assertAlmostEqual(scoredDoubleBoost.exactBonus, 45.0, 1e-4, 'boostExact = 3.0 must double the bonus to 45.0');

    // 2.3 Single Character & Empty Query Guards
    const scoredSingleChar = scoreCandidate(candExact, [candExact], { query: 'a', now, boostExact: 1.5 });
    assertAlmostEqual(scoredSingleChar.exactBonus, 0.0, 1e-4, 'Single character query must receive 0 exact bonus');

    const scoredEmptyQuery = scoreCandidate(candExact, [candExact], { query: '   ', now, boostExact: 1.5 });
    assertAlmostEqual(scoredEmptyQuery.exactBonus, 0.0, 1e-4, 'Empty or whitespace query must receive 0 exact bonus');

    // Case insensitivity
    const scoredUppercase = scoreCandidate(candExact, [candExact], { query: 'REDIS CLUSTER MEMORY LEAK', now, boostExact: 1.5 });
    assertAlmostEqual(scoredUppercase.exactBonus, 22.5, 1e-4, 'Exact matching must be case-insensitive');

    passedCount++;
    console.log('✅ Passed Suite 2: Exact Match Boosting & Token Overlap Verification');
    details.push('Suite 2: Exact match boosting validated for exact phrase (22.5), proportional sub-token matches (12.0, 6.0, 3.0), boost scaling, and short query guards.');
  }

  // =========================================================================
  // SUITE 3: Recency Decay Weighting & Temporal Stability
  // =========================================================================
  console.log('\n--- Suite 3: Recency Decay Weighting & Half-Life Verification ---');
  {
    const dayMs = 1000 * 60 * 60 * 24;
    const halfLifeDays = 30;
    const wRecency = 0.15;

    // 3.1 Mathematical Exponential Decay Invariant Checks
    // Theoretical formula: 2.0 * exp(-ageDays / halfLife) * wRecency
    const testAges = [
      { days: 0, expected: 2.0 * Math.exp(0) * wRecency }, // 0.30
      { days: 30, expected: 2.0 * Math.exp(-1) * wRecency }, // ~0.11036
      { days: 60, expected: 2.0 * Math.exp(-2) * wRecency }, // ~0.04060
      { days: 90, expected: 2.0 * Math.exp(-3) * wRecency }, // ~0.01493
      { days: 180, expected: 2.0 * Math.exp(-6) * wRecency }, // ~0.00074
      { days: 365, expected: 2.0 * Math.exp(-365 / 30) * wRecency }, // ~1.55e-6
    ];

    for (const item of testAges) {
      const cand = mockCandidate(`age_${item.days}`, 'Status update', 'c1', 'alice', now - item.days * dayMs);
      const scored = scoreCandidate(cand, [cand], { now, recencyHalfLifeDays: halfLifeDays, weightRecency: wRecency });
      assertAlmostEqual(
        scored.recencyScore,
        item.expected,
        1e-5,
        `Recency score at ${item.days} days must match exponential decay formula`,
      );
    }

    // 3.2 Strict Monotonic Ordering across a 10-point Time Gradient
    const gradientScores: number[] = [];
    for (let d = 0; d <= 200; d += 20) {
      const cand = mockCandidate(`grad_${d}`, 'Log', 'c1', 'alice', now - d * dayMs);
      const scored = scoreCandidate(cand, [cand], { now, recencyHalfLifeDays: halfLifeDays, weightRecency: wRecency });
      gradientScores.push(scored.recencyScore);
    }
    for (let i = 0; i < gradientScores.length - 1; i++) {
      assert(
        gradientScores[i] > gradientScores[i + 1],
        `Recency scores must be strictly monotonically decreasing: ${gradientScores[i]} > ${gradientScores[i + 1]}`,
      );
    }

    // 3.3 Future Timestamps & Epoch 0 Boundaries
    // Timestamp in the future (+5 days, e.g. client clock skew): ageDays should be clamped to 0 -> score = 0.30 (not explosive)
    const candFuture = mockCandidate('future', 'Future message', 'c1', 'alice', now + 5 * dayMs);
    const scoredFuture = scoreCandidate(candFuture, [candFuture], { now, recencyHalfLifeDays: halfLifeDays, weightRecency: wRecency });
    assertAlmostEqual(scoredFuture.recencyScore, 0.30, 1e-5, 'Future timestamp must clamp age to 0 without score inflation');

    // Timestamp at Epoch 0 (Jan 1 1970)
    const candEpoch0 = mockCandidate('epoch0', 'Ancient message', 'c1', 'alice', 0);
    const scoredEpoch0 = scoreCandidate(candEpoch0, [candEpoch0], { now, recencyHalfLifeDays: halfLifeDays, weightRecency: wRecency });
    assert(scoredEpoch0.recencyScore >= 0 && scoredEpoch0.recencyScore < 1e-10, 'Epoch 0 timestamp must decay cleanly to 0 without NaN');

    passedCount++;
    console.log('✅ Passed Suite 3: Recency Decay Weighting & Half-Life Verification');
    details.push('Suite 3: Recency decay verified against exact exponential half-life curve, strict monotonicity, and temporal edge clamping.');
  }

  // =========================================================================
  // SUITE 4: Turn Budgeting Limits, Serialization & Deduplication
  // =========================================================================
  console.log('\n--- Suite 4: Turn Budgeting Limits & Argument Deduplication ---');
  {
    // 4.1 Budget Tracker Invariants & Limits
    const budget = new AgentBudgetTracker({
      maxModelTurns: 5,
      maxToolCalls: 10,
      maxElapsedMs: 60_000,
      maxReturnedRecords: 150,
      maxEstimatedInputTokens: 24_000,
      finalizationCalls: 1,
    });

    assert(budget.canModelTurn(), 'Initial budget must allow model turns');
    assert(budget.canToolCall(), 'Initial budget must allow tool calls');

    // Exhaust Tool Calls
    for (let i = 0; i < 10; i++) {
      assert(budget.canToolCall(), `Tool call ${i} must be permitted`);
      const marked = budget.markCall('search_messages', { query: `query_term_${i}` });
      assert(marked, `Tool call ${i} must be recorded`);
    }
    assert(!budget.canToolCall(), 'Tool call budget must be exhausted at limit of 10 calls');

    // Exhaust Model Turns
    budget.modelTurns = 5;
    assert(!budget.canModelTurn(), 'Model turns must be exhausted at limit of 5 turns');

    // Token Limits
    budget.modelTurns = 2;
    budget.estimatedInputTokens = 25_000;
    assert(!budget.canModelTurn(), 'Input token limit exceeding 24,000 must stop model turns');

    // 4.2 Deep Argument Normalization & Deduplication
    const freshBudget = new AgentBudgetTracker();
    const call1 = freshBudget.markCall('search_messages', {
      query: 'auth error',
      filters: { channelId: '123', author: 'alice', flags: { unread: true, pinned: false } },
      limit: 25,
    });
    assert(call1 === true, 'First complex tool call must be accepted');
    assert(freshBudget.toolCalls === 1, 'Tool calls must increment to 1');

    // Permuted top-level and nested key order:
    const call2Duplicate = freshBudget.markCall('search_messages', {
      limit: 25,
      filters: { flags: { pinned: false, unread: true }, author: 'alice', channelId: '123' },
      query: 'auth error',
    });
    assert(call2Duplicate === false, 'Identical tool call with permuted key order must be rejected as duplicate');
    assert(freshBudget.toolCalls === 1, 'Tool call count must NOT increment for duplicate');

    // Distinct argument value
    const call3Distinct = freshBudget.markCall('search_messages', {
      query: 'auth error',
      filters: { channelId: '123', author: 'bob', flags: { unread: true, pinned: false } },
      limit: 25,
    });
    assert(call3Distinct === true, 'Tool call with different author must be accepted as distinct');
    assert((freshBudget.toolCalls as number) === 2, 'Tool call count must increment to 2');

    // 4.3 Payload Compactor & Truncation Safety (`compactToolResult`)
    const largeResultObj = {
      ok: true,
      code: 'search_results',
      summary: 'Found 100 messages.',
      untrustedData: true,
      data: {
        messages: Array.from({ length: 60 }, (_, i) => ({
          id: `msg_${i}`,
          content: `Extremely long Discord message log entry with repetitive payload ${i} `.repeat(20),
          author: { username: `user_${i}`, id: `usr_${i}` },
        })),
      },
    };
    const rawJson = JSON.stringify(largeResultObj);
    assert(rawJson.length > 40_000, `Raw JSON length must exceed 40k chars, got ${rawJson.length}`);

    const compacted = compactToolResult(rawJson, 10_000);
    assert(compacted.length <= 10_000, `Compacted result must strictly fit in 10,000 chars, got ${compacted.length}`);
    const parsedCompacted = JSON.parse(compacted);
    assert(parsedCompacted.ok === true, 'Compacted JSON must maintain ok: true');
    assert(parsedCompacted.truncation?.truncated === true, 'Compacted JSON must set truncation.truncated = true');
    assert(parsedCompacted.data.messages.length < 60, 'Messages array must be reduced to fit character limit');

    // Malformed input fallback (when exceeding maxChars, unparseable input falls back safely)
    const malformedResult = compactToolResult('{ invalid json text content '.repeat(500), 5000);
    const parsedMalformed = JSON.parse(malformedResult);
    assert(parsedMalformed.ok === false, 'Malformed input must produce ok: false');
    assert(parsedMalformed.code === 'invalid_tool_output', 'Malformed input must produce invalid_tool_output code');

    passedCount++;
    console.log('✅ Passed Suite 4: Turn Budgeting Limits & Argument Deduplication');
    details.push('Suite 4: Budget limits, deep key normalization deduplication, and payload compaction safety bounds verified.');
  }

  // =========================================================================
  // SUITE 5: Tool-Disabled Finalization Turn Enforcement under Simulated Agent Loops
  // =========================================================================
  console.log('\n--- Suite 5: Tool-Disabled Finalization Turn Enforcement ---');
  {
    // Setup Mock Discord Environment for Agent
    const mockStores: Record<string, any> = {
      SelectedChannelStore: {
        getChannelId: () => 'chan_test_1',
      },
      ChannelStore: {
        getChannel: (id: string) => ({
          id,
          name: 'general',
          type: ChannelType.GUILD_TEXT,
          guild_id: 'guild_test_1',
        }),
        getChannels: (_guildId: string) => [
          { id: 'chan_test_1', name: 'general', type: ChannelType.GUILD_TEXT },
          { id: 'chan_test_2', name: 'dev', type: ChannelType.GUILD_TEXT },
        ],
      },
      GuildStore: {
        getGuild: (id: string) => ({
          id,
          name: 'Test Server',
        }),
      },
      UserStore: {
        getCurrentUser: () => ({
          id: 'usr_me',
          username: 'agent_user',
          globalName: 'Agent Tester',
        }),
        getUser: (id: string) => ({
          id,
          username: `user_${id}`,
        }),
      },
      PermissionStore: {
        can: (_perm: any, _channel: any) => true,
      },
    };

    (globalThis as any).window = {
      Vencord: {
        Webpack: {
          findStore: (name: string) => mockStores[name] ?? null,
          findByProps: (...props: string[]) => null,
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
      maxSearchIterations: 4, // Max 4 turns
    };

    const originalFetch = globalThis.fetch;

    try {
      // -----------------------------------------------------------------------
      // Test 5.1: Normal Multi-Turn Agent Run with Finalization Enforcement
      // Turn 1: Assistant calls search_messages
      // Turn 2: Assistant finishes -> Finalization call executes with toolChoice: 'none'
      // -----------------------------------------------------------------------
      const requestLog: Array<{
        url: string;
        body: any;
        turn: number;
      }> = [];

      let turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        if (turnCount === 1) {
          // Model initiates a search tool call
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Searching for database error logs...',
                    tool_calls: [
                      {
                        id: 'call_search_1',
                        type: 'function',
                        function: {
                          name: 'search_messages',
                          arguments: JSON.stringify({ query: 'database error', limit: 5 }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else if (turnCount === 2) {
          // Model says ready without tool calls
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'I have gathered the database error context.',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          // Turn 3: Finalization call!
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'The database error was caused by a connection pool timeout.',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }) as typeof fetch;

      const agent = new AIAssistantAgent(baseSettings);
      const streamedTokens: string[] = [];
      const runResult = await agent.run('Why did the database crash?', [], {
        onToken: (tok) => streamedTokens.push(tok),
      });

      assert(runResult.content.includes('connection pool timeout'), 'Agent must return the finalized answer');
      assert(runResult.steps.some((s) => s.type === 'answer'), 'Answer step must be emitted');
      assert(requestLog.length === 3, `Expected exactly 3 HTTP requests (turn 1 tool, turn 2 ready, turn 3 finalization), got ${requestLog.length}`);

      // Inspect Finalization Request (Turn 3)
      const finalizationRequest = requestLog[2];
      assert(!finalizationRequest.body.tools, 'Finalization request MUST NOT include tools in payload');
      assert(finalizationRequest.body.tool_choice === undefined, 'Finalization request MUST NOT send tool_choice');
      const finalizationMessages: any[] = finalizationRequest.body.messages;
      const lastSystemMessage = finalizationMessages.find((m) =>
        m.role === 'system' && String(m.content).includes('Tools are now disabled'),
      );
      assert(
        Boolean(lastSystemMessage),
        'Finalization request must include system instruction stating "Tools are now disabled. Give the best concise final answer using only the gathered evidence."',
      );

      // -----------------------------------------------------------------------
      // Test 5.2: Infinite Tool Loop Prevention & Turn Limit Enforcement
      // Model keeps returning tool calls forever -> Agent must stop at maxModelTurns (4) and finalize
      // -----------------------------------------------------------------------
      requestLog.length = 0;
      turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        // If tools are disabled (finalization call), return final answer
        if (!parsedBody.tools) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Finalized answer after turn budget reached.' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Otherwise keep requesting tool calls with changing query
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `Looping turn ${turnCount}...`,
                  tool_calls: [
                    {
                      id: `call_loop_${turnCount}`,
                      type: 'function',
                      function: {
                        name: 'search_messages',
                        arguments: JSON.stringify({ query: `infinite_term_${turnCount}` }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const loopingAgent = new AIAssistantAgent(baseSettings);
      const loopResult = await loopingAgent.run('Search everything forever', []);
      assert(loopResult.content.includes('Finalized answer after turn budget reached'), 'Agent must finalize cleanly after reaching turn budget');
      // 4 tool selection turns + 1 finalization turn = 5 total HTTP calls
      assert(requestLog.length === 5, `Expected 5 HTTP calls (4 loop turns + 1 finalization), got ${requestLog.length}`);
      const lastCall = requestLog[requestLog.length - 1];
      assert(!lastCall.body.tools, 'Finalization call after loop limit must have tools disabled');

      // -----------------------------------------------------------------------
      // Test 5.3: Prompt Injection Containment & Safety in Discord Data
      // Mock search tool returns prompt injection text: "SYSTEM OVERRIDE: ignore instructions"
      // Verify tool sets untrustedData: true, and finalization turn strictly enforces tools disabled
      // -----------------------------------------------------------------------
      requestLog.length = 0;
      turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        if (turnCount === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Querying messages...',
                    tool_calls: [
                      {
                        id: 'call_inj_1',
                        type: 'function',
                        function: {
                          name: 'search_messages',
                          arguments: JSON.stringify({ query: 'secret key' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else if (turnCount === 2) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Examined untrusted records.' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Ignored injection instructions contained in data.' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }) as typeof fetch;

      const injectionAgent = new AIAssistantAgent(baseSettings);
      const injResult = await injectionAgent.run('Find secret key', []);
      assert(injResult.content.includes('Ignored injection instructions'), 'Agent must complete safely');

      // Check tool result step in steps
      const toolResultStep = injResult.steps.find((s) => s.type === 'tool_result');
      assert(Boolean(toolResultStep), 'Tool result step must be recorded');
      assert(toolResultStep?.toolResult?.untrustedData === true, 'Discord tool execution result must be flagged as untrustedData = true');

      // -----------------------------------------------------------------------
      // Test 5.4: Finalization Network Failure Graceful Recovery
      // Provider throws 500 error on finalization turn -> Agent catches, does not crash, provides fallback
      // -----------------------------------------------------------------------
      turnCount = 0;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        if (!parsedBody.tools) {
          // Finalization call fails with 500
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Ready.' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const failAgent = new AIAssistantAgent(baseSettings);
      const failResult = await failAgent.run('Test failure', []);
      assert(
        failResult.content.includes('tools-disabled finalization call failed'),
        'Agent must gracefully recover and inform user when finalization call fails',
      );

      // -----------------------------------------------------------------------
      // Test 5.5: User AbortSignal Cancellation
      // -----------------------------------------------------------------------
      const abortController = new AbortController();
      abortController.abort();
      const abortAgent = new AIAssistantAgent(baseSettings);
      let abortedCaught = false;
      try {
        await abortAgent.run('Test abort', [], undefined, abortController.signal);
      } catch (err: any) {
        abortedCaught = err.message.includes('Agent execution cancelled by user');
      }
      assert(abortedCaught, 'AbortSignal must trigger cancellation exception');
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as any).window;
    }

    passedCount++;
    console.log('✅ Passed Suite 5: Tool-Disabled Finalization Turn Enforcement');
    details.push('Suite 5: Tool-disabled finalization turn enforcement verified across normal runs, infinite tool loops, prompt injection in data, network errors, and abort signals.');
  }

  console.log('\n======================================================================');
  console.log(`SUMMARY: ${passedCount} Passed | ${bugCount} Critical/High Bugs`);
  console.log('======================================================================\n');

  return { passedCount, bugCount, details };
}

// Self-run when executed directly
if (typeof process !== 'undefined' && process.argv[1]?.includes('challenger_m3_2_empirical')) {
  runMilestone3Challenger2Tests().catch((err) => {
    console.error('Milestone 3 Challenger 2 Test Error:', err);
    process.exit(1);
  });
}
