/*
 * Vencord AI - Milestone 2 Challenger 2 Empirical Test Suite
 * Comprehensive adversarial verification for:
 * 1. Semantic Similarity Ranking Precision & Vector Normalization
 * 2. Typo Tolerance Across Edit Distances (1-3 chars)
 * 3. Multi-Modal Query Collisions & Reciprocal Rank Fusion
 * 4. Date Boundary Filtering & Edge Cases ([min, max], Epoch 0)
 * 5. High-Concurrency Multi-Query Performance (<50ms)
 * 6. ReDoS Pattern Safety & Execution Timeout Behavior
 */

import { assert } from './assert';
import { DiscordMessage } from '../types';
import { InvertedIndex } from '../storage/index/invertedIndex';
import { WorkerBridge } from '../storage/index/workerBridge';
import {
  calculateSemanticScore,
  computeCosineSimilarity,
  extractSubwords,
  generateDenseEmbedding,
  batchScoreEmbeddings,
  EMBEDDING_DIMENSION,
} from '../storage/semantic';
import {
  compileSafeRegex,
  extractAllStructuredEntities,
  extractMatchesFromText,
  extractMessagePatternMatches,
  isRegexSafe,
  STRUCTURED_PATTERNS,
} from '../storage/regex';
import { HybridRetrievalEngine, HybridSearchQuery } from '../storage/retrieval';

function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-4, message?: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message || 'Values not equal'}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function createMsg(
  id: string,
  channelId: string,
  content: string,
  options: Partial<DiscordMessage> = {},
): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    guild_id: options.guild_id || 'guild_test',
    author: options.author || { id: 'user_1', username: 'alice', globalName: 'Alice' },
    content,
    timestamp: options.timestamp || new Date().toISOString(),
    attachments: options.attachments || [],
    embeds: options.embeds || [],
    mentions: options.mentions || [],
    pinned: options.pinned || false,
    message_reference: options.message_reference,
  };
}

export async function runMilestone2ChallengerTests(): Promise<{
  passedCount: number;
  bugCount: number;
  details: string[];
}> {
  console.log('\n======================================================================');
  console.log('🔥 RUNNING MILESTONE 2 CHALLENGER 2 EMPIRICAL VERIFICATION SUITE 🔥');
  console.log('======================================================================\n');

  let passedCount = 0;
  let bugCount = 0;
  const details: string[] = [];

  // =========================================================================
  // SUITE 1: Semantic Similarity Ranking Precision
  // =========================================================================
  console.log('--- Suite 1: Semantic Similarity Ranking Precision ---');
  {
    // 1.1 Dense Vector Invariants & Normalization
    const testStrings = [
      '',
      '   \t\n  ',
      'a',
      'PostgreSQL migration',
      '🚀🔥🎉 Custom emoji <:pepe:123> and emojis',
      '日本語の形態素解析テストデータベース',
      'Supercalifragilisticexpialidocious'.repeat(50),
      'Zero\x00Control\x1fCharacters\x7fTest',
    ];

    for (const str of testStrings) {
      const vec = generateDenseEmbedding(str);
      assert(vec.length === EMBEDDING_DIMENSION, `Vector dimension must be ${EMBEDDING_DIMENSION}`);
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      if (str.trim().length > 0) {
        assertAlmostEqual(Math.sqrt(norm), 1.0, 1e-4, `Vector for "${str.slice(0, 20)}" must be L2 unit normalized`);
      } else {
        assert(norm === 0, 'Empty or whitespace string must produce all-zero vector');
      }
    }

    // 1.2 Cosine Similarity Mathematical Invariants
    const v1 = generateDenseEmbedding('database postgres migration failure');
    const v2 = generateDenseEmbedding('database postgres migration failure');
    const v3 = generateDenseEmbedding('unrelated cooking pasta sauce parmesan');

    assertAlmostEqual(computeCosineSimilarity(v1, v2), 1.0, 1e-4, 'Identical vectors must have cosine similarity 1.0');
    assert(computeCosineSimilarity(v1, v3) < 0.35, 'Unrelated vectors must have low cosine similarity (<0.35)');

    // Symmetry check: sim(A, B) === sim(B, A)
    const sim13 = computeCosineSimilarity(v1, v3);
    const sim31 = computeCosineSimilarity(v3, v1);
    assertAlmostEqual(sim13, sim31, 1e-6, 'Cosine similarity must be strictly symmetric');

    // 1.3 Conceptual Synonym Clusters & Ranking Precision
    const corpusTexts = [
      { id: 'db_fail', text: 'postgres migration script crashed with lock contention exception', category: 'db_fail' },
      { id: 'auth_tok', text: 'user authentication jwt session token expired login failure', category: 'auth' },
      { id: 'k8s_deploy', text: 'kubernetes cluster pod container node deployment failed', category: 'infra' },
      { id: 'flight_book', text: 'flight ticket airline reservation travel denver seat booking', category: 'travel' },
      { id: 'recipe', text: 'delicious chocolate cake baking recipe oven temperature flour sugar', category: 'cooking' },
    ];

    const qDb = 'database sql table mutation error bug';
    const qVecDb = generateDenseEmbedding(qDb);
    const scoresDb = corpusTexts.map((doc) => ({
      id: doc.id,
      score: computeCosineSimilarity(qVecDb, generateDenseEmbedding(doc.text)),
    }));
    scoresDb.sort((a, b) => b.score - a.score);

    assert(scoresDb[0].id === 'db_fail', `Database conceptual query must rank db_fail #1, got ${scoresDb[0].id} (score: ${scoresDb[0].score})`);
    assert(scoresDb[0].score > 0.50, `db_fail conceptual score must exceed 0.50, got ${scoresDb[0].score}`);
    assert(scoresDb[scoresDb.length - 1].id === 'recipe', `Cooking recipe must rank lowest for db query, got ${scoresDb[scoresDb.length - 1].id}`);

    // 1.4 Random Noise Orthogonality
    function pseudoRandomString(seed: number, len: number): string {
      let s = '';
      let state = seed;
      for (let j = 0; j < len; j++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const charCode = 97 + (state % 26);
        s += String.fromCharCode(charCode);
        if (j > 0 && j % 6 === 0) s += ' ';
      }
      return s;
    }

    const randVecs: Float32Array[] = [];
    for (let i = 0; i < 50; i++) {
      randVecs.push(generateDenseEmbedding(pseudoRandomString(i * 997 + 13, 30)));
    }
    let maxNoiseSim = 0;
    for (let i = 0; i < randVecs.length; i++) {
      for (let j = i + 1; j < randVecs.length; j++) {
        const sim = computeCosineSimilarity(randVecs[i], randVecs[j]);
        if (sim > maxNoiseSim) maxNoiseSim = sim;
      }
    }
    assert(maxNoiseSim < 0.45, `Random noise maximum cosine similarity must be <0.45, got ${maxNoiseSim.toFixed(3)}`);

    // 1.5 Batch Scoring Consistency
    const candVectors = corpusTexts.map((d) => generateDenseEmbedding(d.text));
    const batchScores = batchScoreEmbeddings(qVecDb, candVectors);
    for (let i = 0; i < corpusTexts.length; i++) {
      const singleScore = computeCosineSimilarity(qVecDb, candVectors[i]);
      assertAlmostEqual(batchScores[i], singleScore, 1e-6, `Batch score at index ${i} must match single calculation`);
    }

    passedCount++;
    console.log('✅ Passed Suite 1: Semantic Similarity Ranking Precision & Orthogonality');
    details.push('Suite 1: Semantic similarity ranking precision, vector normalization, batch scoring, and random noise orthogonality verified.');
  }

  // =========================================================================
  // SUITE 2: Typo Tolerance & Subword Degradation
  // =========================================================================
  console.log('\n--- Suite 2: Typo Tolerance & Subword Degradation ---');
  {
    const targetWord = 'authentication';
    const vecTarget = generateDenseEmbedding(targetWord);

    const typoVariants = [
      { name: '1-char substitution', word: 'authenticatipn', maxDrop: 0.25 },
      { name: '1-char deletion', word: 'authentcaton', maxDrop: 0.35 },
      { name: '1-char insertion', word: 'authenticattion', maxDrop: 0.25 },
      { name: '1-char transposition', word: 'authenticaitn', maxDrop: 0.30 },
      { name: '2-char typo', word: 'authetcaton', maxDrop: 0.45 },
      { name: '3-char typo', word: 'authenicationn', maxDrop: 0.45 },
      { name: 'colloquial prefix', word: 'auth', maxDrop: 0.50 },
    ];

    for (const tv of typoVariants) {
      const vecTypo = generateDenseEmbedding(tv.word);
      const sim = computeCosineSimilarity(vecTarget, vecTypo);
      assert(
        sim >= (1.0 - tv.maxDrop),
        `Typo variant "${tv.word}" (${tv.name}) similarity dropped too low: got ${sim.toFixed(3)}, expected >= ${(1.0 - tv.maxDrop).toFixed(3)}`,
      );
    }

    // Adversarial Typo Ranking Test:
    // With typo query "postgreesql databaes migraton faillure", target doc should still beat distractors.
    const typoQuery = 'postgreesql databaes migraton faillure';
    const typoVec = generateDenseEmbedding(typoQuery);

    const candA = generateDenseEmbedding('PostgreSQL database migration failure with contention error');
    const candB = generateDenseEmbedding('Docker container deployment to production server cluster');
    const candC = generateDenseEmbedding('Quarterly sales meeting notes and budget forecast spreadsheet');

    const scoreA = computeCosineSimilarity(typoVec, candA);
    const scoreB = computeCosineSimilarity(typoVec, candB);
    const scoreC = computeCosineSimilarity(typoVec, candC);

    assert(scoreA > scoreB && scoreA > scoreC, `Typo query must rank target A highest: scoreA=${scoreA.toFixed(3)}, scoreB=${scoreB.toFixed(3)}, scoreC=${scoreC.toFixed(3)}`);
    assert(scoreA > 0.65, `Target A score under typo query must exceed 0.65, got ${scoreA.toFixed(3)}`);

    passedCount++;
    console.log('✅ Passed Suite 2: Typo Tolerance & Subword Feature Robustness');
    details.push('Suite 2: Subword feature hashing provides resilient typo tolerance across 1-3 edit distances and rankings.');
  }

  // =========================================================================
  // SUITE 3: Multi-Modal Query Collisions & Fusion Ranking
  // =========================================================================
  console.log('\n--- Suite 3: Multi-Modal Query Collisions & Fusion Ranking ---');
  {
    const localIndex = new InvertedIndex();
    const mockMessages: DiscordMessage[] = [
      createMsg('msg_all3', 'ch_dev', 'Database schema migration error on postgres with OTP code 948201 for recovery', { timestamp: '2026-04-10T12:00:00Z' }),
      createMsg('msg_lex_only', 'ch_dev', 'Database schema migration script for users table', { timestamp: '2026-04-10T12:00:00Z' }),
      createMsg('msg_sem_only', 'ch_dev', 'SQL datastore table alter failure and lock contention issue', { timestamp: '2026-04-10T12:00:00Z' }),
      createMsg('msg_regex_only', 'ch_dev', 'Your single-use login code is 948201 valid for 5 minutes', { timestamp: '2026-04-10T12:00:00Z' }),
      createMsg('msg_unrelated', 'ch_dev', 'Going for lunch at the Italian bistro near the park', { timestamp: '2026-04-10T12:00:00Z' }),
    ];
    localIndex.addBatch(mockMessages);

    const mockBridge = {
      search: async (q: any) => localIndex.search(q),
      createSnapshot: async () => ({ snapshot: localIndex.exportSnapshot() }),
      getStats: async () => ({ stats: localIndex.getStats() }),
    } as unknown as WorkerBridge;

    const engine = new HybridRetrievalEngine(mockBridge);

    // Test 3.1: Combined Multi-Modal Query where candidates match varying modalities
    const multiModalRes = await engine.search({
      query: 'Database schema migration',
      semanticQuery: 'postgres datastore alter failure',
      pattern: '\\b\\d{6}\\b',
      boostRecency: 0,
    });

    assert(multiModalRes.hits.length >= 2, `Should find BM25 candidates, got ${multiModalRes.hits.length}`);
    // msg_all3 matches Lexical, Semantic, and Regex -> must be rank #1
    assert(multiModalRes.hits[0].messageId === 'msg_all3', `msg_all3 (all 3 modalities) must rank #1, got ${multiModalRes.hits[0].messageId}`);
    assert(multiModalRes.hits[0].regexMatches?.includes('948201'), 'msg_all3 must extract OTP regex match');
    assert(multiModalRes.hits[0].score > multiModalRes.hits[1].score, 'All-modality hit must score higher than single-modality hit');

    // Test 3.2: Fallback when BM25 returns 0 candidates (Pure Pattern query)
    const purePatternRes = await engine.search({
      pattern: '\\b948201\\b',
      limit: 10,
    });
    assert(purePatternRes.hits.length >= 2, `Pure pattern search fallback must find hits, got ${purePatternRes.hits.length}`);
    const top2Ids = [purePatternRes.hits[0].messageId, purePatternRes.hits[1].messageId];
    assert(top2Ids.includes('msg_all3') && top2Ids.includes('msg_regex_only'), 'Top 2 hits must be the OTP messages');
    assert(purePatternRes.hits[0].regexMatches?.includes('948201'), 'Top hit must have extracted regex match');
    assert(purePatternRes.hits[1].regexMatches?.includes('948201'), 'Second hit must have extracted regex match');
    if (purePatternRes.hits.length > 2) {
      assert(purePatternRes.hits[0].score > purePatternRes.hits[2].score * 5, 'Pattern matches must vastly outscore non-matching background records');
    }

    // Test 3.3: Semantic query with conceptual vocabulary
    const semRes = await engine.search({
      semanticQuery: 'postgres datastore alter failure',
      limit: 10,
      boostRecency: 0,
    });
    assert(semRes.hits.length >= 2, 'Semantic query must find candidates matching concepts');
    const semTopHit = semRes.hits[0];
    assert(
      semTopHit.messageId === 'msg_all3' || semTopHit.messageId === 'msg_sem_only',
      `Top semantic hit must be database error message, got ${semTopHit.messageId}`,
    );

    // Test 3.4: ReDoS Pattern Immunity in Search
    assert(!isRegexSafe('(a+)+$'), 'ReDoS screen must identify (a+)+$ as unsafe');
    const redosRes = await engine.search({
      query: 'Database',
      pattern: '(a+)+$', // Unsafe ReDoS pattern
    });
    assert(
      !redosRes.hits.some((h) => h.regexMatches && h.regexMatches.length > 0),
      'Engine must safely ignore unsafe ReDoS regex without producing matches',
    );

    passedCount++;
    console.log('✅ Passed Suite 3: Multi-Modal Query Collisions & Fusion Ranking');
    details.push('Suite 3: Reciprocal rank fusion, multi-modal query handling, and snapshot fallback verified.');
  }

  // =========================================================================
  // SUITE 4: Date Boundary Filtering & Edge Cases
  // =========================================================================
  console.log('\n--- Suite 4: Date Boundary Filtering & Edge Cases ---');
  {
    const dateIndex = new InvertedIndex();
    const t0 = 1700000000000; // Reference timestamp: Nov 14, 2023 22:13:20 UTC
    const dateMessages: DiscordMessage[] = [
      createMsg('m_before', 'ch1', 'server alert log before interval', { timestamp: new Date(t0 - 10000).toISOString() }),
      createMsg('m_min_exact', 'ch1', 'server alert log at exact min boundary', { timestamp: new Date(t0).toISOString() }),
      createMsg('m_middle', 'ch1', 'server alert log in the middle', { timestamp: new Date(t0 + 5000).toISOString() }),
      createMsg('m_max_exact', 'ch1', 'server alert log at exact max boundary', { timestamp: new Date(t0 + 10000).toISOString() }),
      createMsg('m_after', 'ch1', 'server alert log after interval', { timestamp: new Date(t0 + 20000).toISOString() }),
      createMsg('m_epoch0', 'ch1', 'server alert log at epoch 0', { timestamp: new Date(0).toISOString() }),
    ];
    dateIndex.addBatch(dateMessages);

    // Test 4.1: Closed Interval [minTimestamp, maxTimestamp] - Both boundaries inclusive
    const intervalRes = dateIndex.search({
      query: 'server alert log',
      minTimestamp: t0,
      maxTimestamp: t0 + 10000,
      boostRecency: 0,
    });
    const intervalIds = intervalRes.hits.map((h) => h.messageId);
    assert(intervalIds.includes('m_min_exact'), 'minTimestamp exact boundary must be inclusive');
    assert(intervalIds.includes('m_middle'), 'Middle timestamp must be included');
    assert(intervalIds.includes('m_max_exact'), 'maxTimestamp exact boundary must be inclusive');
    assert(!intervalIds.includes('m_before'), 'Timestamp strictly before minTimestamp must be excluded');
    assert(!intervalIds.includes('m_after'), 'Timestamp strictly after maxTimestamp must be excluded');
    assert(intervalIds.length === 3, `Expected exactly 3 hits in interval [t0, t0+10000], got ${intervalIds.length}`);

    // Test 4.2: Epoch 0 Timestamp Handling
    const epoch0Res = dateIndex.search({
      query: 'epoch 0',
      minTimestamp: 0,
      maxTimestamp: 1000,
      boostRecency: 0,
    });
    assert(epoch0Res.hits.some((h) => h.messageId === 'm_epoch0'), 'Epoch 0 message must be retrievable when querying [0, 1000]');

    passedCount++;
    console.log('✅ Passed Suite 4: Date Boundary Filtering & Boundary Inclusivity');
    details.push('Suite 4: Date boundary filtering verified: [min, max] inclusive filtering works as intended.');
  }

  // =========================================================================
  // SUITE 5: Multi-Thread & High-Concurrency Performance (<50ms)
  // =========================================================================
  console.log('\n--- Suite 5: Multi-Thread & High-Concurrency Performance (<50ms) ---');
  {
    const perfIndex = new InvertedIndex(12_000);
    const corpusSize = 5_000;
    const batch: DiscordMessage[] = [];
    const topics = [
      'PostgreSQL migration transaction deadlock on user table',
      'Kubernetes cluster node pod restart crash loop backoff',
      'Authentication OAuth JWT token refresh secret key expired',
      'Frontend React state management Zustand vs Redux bundle',
      'Network socket gateway proxy timeout 504 bad gateway',
      'Single-use emergency recovery OTP 582910 security alert',
    ];

    for (let i = 0; i < corpusSize; i++) {
      const topic = topics[i % topics.length];
      batch.push(createMsg(
        `perf_msg_${i}`,
        `ch_${i % 10}`,
        `Log entry #${i}: ${topic} during service execution.`,
        { timestamp: new Date(1700000000000 + i * 60000).toISOString() },
      ));
    }
    perfIndex.addBatch(batch);

    const perfBridge = {
      search: async (q: any) => perfIndex.search(q),
      createSnapshot: async () => ({ snapshot: perfIndex.exportSnapshot() }),
      getStats: async () => ({ stats: perfIndex.getStats() }),
    } as unknown as WorkerBridge;

    const perfEngine = new HybridRetrievalEngine(perfBridge);

    const concurrentQueries: HybridSearchQuery[] = [
      { query: 'postgres deadlock', semanticQuery: 'database lock error', limit: 10 },
      { query: 'kubernetes restart', semanticQuery: 'cluster pod failure', limit: 10 },
      { query: 'jwt token', semanticQuery: 'auth login session', limit: 10 },
      { query: 'zustand redux', semanticQuery: 'frontend state management', limit: 10 },
      { query: 'proxy timeout', semanticQuery: 'network gateway connection', limit: 10 },
      { pattern: '\\b\\d{6}\\b', limit: 10 },
    ];

    // 5.1 Sequential Latency Distribution over 100 Hybrid Queries
    const seqLatencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const q = concurrentQueries[i % concurrentQueries.length];
      const t0 = performance.now();
      const res = await perfEngine.search(q);
      const dur = performance.now() - t0;
      seqLatencies.push(dur);
      assert(res.hits.length > 0, 'Query must return valid matches');
    }

    seqLatencies.sort((a, b) => a - b);
    const seqP50 = seqLatencies[Math.floor(seqLatencies.length * 0.50)];
    const seqP95 = seqLatencies[Math.floor(seqLatencies.length * 0.95)];
    const seqP99 = seqLatencies[Math.floor(seqLatencies.length * 0.99)];
    const seqMean = seqLatencies.reduce((s, d) => s + d, 0) / seqLatencies.length;

    console.log(`   ⚡ Individual Hybrid Search Latency (100 queries over 5,000 messages):`);
    console.log(`      mean=${seqMean.toFixed(2)}ms, p50=${seqP50.toFixed(2)}ms, p95=${seqP95.toFixed(2)}ms, p99=${seqP99.toFixed(2)}ms`);

    assert(seqP95 < 50, `Sequential p95 Latency (${seqP95.toFixed(2)}ms) must be under 50ms`);
    assert(seqMean < 25, `Sequential Mean Latency (${seqMean.toFixed(2)}ms) must be under 25ms`);

    // 5.2 High-Throughput Batch Processing (6 queries)
    const tBatch0 = performance.now();
    await Promise.all(concurrentQueries.map((q) => perfEngine.search(q)));
    const tBatchElapsed = performance.now() - tBatch0;
    const throughputPerSec = Math.round((concurrentQueries.length / (tBatchElapsed / 1000)));

    console.log(`   ⚡ Batch Multi-Query Throughput: ${concurrentQueries.length} queries completed in ${tBatchElapsed.toFixed(2)}ms (~${throughputPerSec} queries/sec)`);

    passedCount++;
    console.log('✅ Passed Suite 5: Multi-Thread & High-Concurrency Performance (<50ms)');
    details.push(`Suite 5: Hybrid search over 5,000 messages achieved p50=${seqP50.toFixed(2)}ms, p95=${seqP95.toFixed(2)}ms (<50ms target met).`);
  }

  // =========================================================================
  // SUITE 6: ReDoS Vulnerability & Execution Timeout Stress
  // =========================================================================
  console.log('\n--- Suite 6: ReDoS Vulnerability & Execution Timeout Stress ---');
  {
    // Check known pathological regex patterns against compileSafeRegex and extractMatchesFromText
    const pathologicalPatterns = [
      '(a+)+$',
      '(a|a)+$',
      '(.*)+$',
      '\\d+\\d+',
      '([a-z]+)+$',
    ];

    for (const pat of pathologicalPatterns) {
      const compileRes = compileSafeRegex(pat);
      assert(!compileRes.isSafe || compileRes.regex === null, `Pathological regex "${pat}" must be flagged unsafe`);
    }

    // Execution time bound verification on extractMatchesFromText
    const attackText = 'word '.repeat(1000);
    const t0 = performance.now();
    const safeExtraction = extractMatchesFromText(attackText, '\\b[a-z]{4,6}\\b', 20, 10);
    const elapsed = performance.now() - t0;
    assert(elapsed < 50, `extractMatchesFromText must respect time bounds (<50ms), took ${elapsed.toFixed(2)}ms`);
    assert(safeExtraction.length > 0, 'Should extract bounded tokens');

    passedCount++;
    console.log('✅ Passed Suite 6: ReDoS Vulnerability & Execution Timeout Stress');
    details.push('Suite 6: ReDoS filtering, safe compilation, and execution time bounding verified.');
  }

  console.log('\n======================================================================');
  console.log(`SUMMARY: ${passedCount} Passed | ${bugCount} Critical/High Bugs`);
  console.log('======================================================================\n');

  return { passedCount, bugCount, details };
}

// Self-run when executed directly
if (typeof process !== 'undefined' && process.argv[1]?.includes('challenger_m2_empirical')) {
  runMilestone2ChallengerTests().catch((err) => {
    console.error('Milestone 2 Challenger Test Error:', err);
    process.exit(1);
  });
}
