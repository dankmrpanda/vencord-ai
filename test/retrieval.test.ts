/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
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
  hashString32,
} from '../storage/semantic';
import {
  compileSafeRegex,
  extractAllStructuredEntities,
  extractMatchesFromText,
  extractMessagePatternMatches,
  isRegexSafe,
  STRUCTURED_PATTERNS,
} from '../storage/regex';
import { HybridRetrievalEngine } from '../storage/retrieval';

function assertAlmostEqual(actual: number, expected: number, tolerance = 1e-4, message?: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message || 'Values not equal'}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

export async function runRetrievalUnitAndIntegrationTests(): Promise<void> {
  console.log('[Test:Retrieval] Running Milestone 2 Hybrid Retrieval Test Suite...');

  // =========================================================================
  // 1. Semantic Similarity Unit Tests
  // =========================================================================
  console.log('  -> 1. Semantic Embedding & Cosine Similarity Tests');

  // Test 1.1: Vector dimension & normalization
  const vec1 = generateDenseEmbedding('PostgreSQL database migration in progress');
  assert(vec1.length === 128, 'Embedding dimension must be 128');

  let norm = 0;
  for (let i = 0; i < vec1.length; i++) norm += vec1[i] * vec1[i];
  assertAlmostEqual(Math.sqrt(norm), 1.0, 1e-4, 'Dense vector must be L2 normalized to unit length');

  // Test 1.2: Identity cosine similarity
  const selfSim = computeCosineSimilarity(vec1, vec1);
  assertAlmostEqual(selfSim, 1.0, 1e-4, 'Self-similarity must equal 1.0');

  // Test 1.3: Morphological and synonym similarity
  const vecA = generateDenseEmbedding('PostgreSQL database migration failure');
  const vecB = generateDenseEmbedding('migrating postgres databases failed');
  const simAB = computeCosineSimilarity(vecA, vecB);
  assert(simAB > 0.55, `Morphological variant similarity must be high, got ${simAB}`);

  // Test 1.4: Typo resilience
  const vecCorrect = generateDenseEmbedding('authentication token expired');
  const vecTypo = generateDenseEmbedding('authenticattion tokn expird');
  const typoSim = computeCosineSimilarity(vecCorrect, vecTypo);
  assert(typoSim > 0.60, `Typo similarity must exceed 0.60, got ${typoSim}`);

  // Test 1.5: Unrelated orthogonal text
  const vecUnrelated = generateDenseEmbedding('chocolate cake recipe baking temperature');
  const unrecSim = computeCosineSimilarity(vecA, vecUnrelated);
  assert(unrecSim < 0.35, `Unrelated text similarity must be low (<0.35), got ${unrecSim}`);

  // Test 1.6: CJK Semantic Embeddings
  const vecCJK1 = generateDenseEmbedding('データベースの移行エラー');
  const vecCJK2 = generateDenseEmbedding('データベース移行の障害');
  const cjkSim = computeCosineSimilarity(vecCJK1, vecCJK2);
  assert(cjkSim > 0.60, `CJK semantic similarity must be high, got ${cjkSim}`);

  // =========================================================================
  // 2. Regex & Pattern Matching Unit Tests
  // =========================================================================
  console.log('  -> 2. Regex & Structured Pattern Extraction Tests');

  // Test 2.1: OTP Extraction
  const otpText = 'Your Discord 2FA verification code is: 582910. Do not share it.';
  const otps = extractMatchesFromText(otpText, STRUCTURED_PATTERNS.OTP);
  assert(otps.length === 1 && otps[0] === '582910', 'Should extract 6-digit OTP code');

  // Test 2.2: Email Extraction
  const emailText = 'Contact support at security-team@vencord.dev or dev@example.com for help.';
  const emails = extractMatchesFromText(emailText, STRUCTURED_PATTERNS.EMAIL);
  assert(emails.length === 2 && emails.includes('security-team@vencord.dev'), 'Should extract both emails');

  // Test 2.3: IPv4 and IPv6 Extraction
  const ipText = 'Connected from 192.168.1.100 and gateway 10.0.0.1';
  const ips = extractMatchesFromText(ipText, STRUCTURED_PATTERNS.IPV4);
  assert(ips.length === 2 && ips.includes('192.168.1.100'), 'Should extract valid IPv4 addresses');

  // Test 2.4: Hex Hashes & Ethereum Addresses
  const hexText = 'Commit SHA: 7b3f910a2c4e68d1 and ETH: 0x71C66332e333D348A745B0360a0E82049195F932';
  const hexes = extractMatchesFromText(hexText, STRUCTURED_PATTERNS.HEX_HASH);
  assert(hexes.some((h) => h.startsWith('0x71C66332')), 'Should extract Ethereum address');

  // Test 2.5: ReDoS Safety Pre-Screening
  assert(!isRegexSafe('(a+)+$'), 'ReDoS screen must reject nested quantifiers (a+)+');
  assert(!isRegexSafe('(a|a)+$'), 'ReDoS screen must reject duplicate alternations');
  assert(!isRegexSafe('(.*)+$'), 'ReDoS screen must reject quantified wildcards');
  assert(isRegexSafe('\\b\\d{4,8}\\b'), 'ReDoS screen must allow safe bounded digit regex');

  const unsafeCompile = compileSafeRegex('(a+)+$');
  assert(!unsafeCompile.isSafe && unsafeCompile.regex === null, 'compileSafeRegex must return isSafe=false for dangerous regex');

  // Test 2.6: Message multi-field extraction
  const mockMsg: DiscordMessage = {
    id: '1001',
    channel_id: 'ch_1',
    author: { id: 'u1', username: 'alice' },
    content: 'Check the attached config file.',
    timestamp: new Date().toISOString(),
    attachments: [{ id: 'a1', filename: 'debug_192.168.1.50.log', size: 1024, url: '', proxy_url: '' }],
    embeds: [{ title: 'Server Alert', description: 'Error code: 404928' }],
    mentions: [],
  };
  const extractedIps = extractMessagePatternMatches(mockMsg, STRUCTURED_PATTERNS.IPV4);
  assert(extractedIps.includes('192.168.1.50'), 'Should extract IP from attachment filename');

  const extractedOtps = extractMessagePatternMatches(mockMsg, STRUCTURED_PATTERNS.OTP);
  assert(extractedOtps.includes('404928'), 'Should extract OTP code from embed description');

  // Test 2.7: Extract all structured entities
  const multiEntityText = 'Alert on 10.0.0.5 sent to admin@corp.net with OTP 987654 at 2026-04-15';
  const allEntities = extractAllStructuredEntities(multiEntityText);
  assert(allEntities.IPV4.includes('10.0.0.5'), 'All entities must include IPv4');
  assert(allEntities.EMAIL.includes('admin@corp.net'), 'All entities must include email');
  assert(allEntities.OTP.includes('987654'), 'All entities must include OTP');
  assert(allEntities.DATE_ISO.some((d) => d.startsWith('2026-04-15')), 'All entities must include ISO date');

  // =========================================================================
  // 3. Unified Hybrid Retrieval & RRF Integration Tests
  // =========================================================================
  console.log('  -> 3. Unified Hybrid Retrieval & RRF Integration Tests');

  const localIndex = new InvertedIndex();
  const testMessages: DiscordMessage[] = [
    {
      id: 'msg_1',
      channel_id: 'ch_dev',
      guild_id: 'guild_1',
      author: { id: 'u1', username: 'alice' },
      content: 'Database migration script failed with lock contention on table users.',
      timestamp: new Date('2026-04-10T12:00:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'msg_2',
      channel_id: 'ch_dev',
      guild_id: 'guild_1',
      author: { id: 'u2', username: 'bob' },
      content: 'Here is the one-time backup OTP code: 849201 for server recovery.',
      timestamp: new Date('2026-04-10T12:02:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'msg_3',
      channel_id: 'ch_random',
      guild_id: 'guild_1',
      author: { id: 'u3', username: 'charlie' },
      content: 'Lunch meeting at the Italian bistro near the park.',
      timestamp: new Date('2026-04-10T12:05:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  localIndex.addBatch(testMessages);

  // Mock Worker Bridge backed by direct InvertedIndex
  const mockBridge = {
    search: async (q: any) => localIndex.search(q),
    createSnapshot: async () => ({ snapshot: localIndex.exportSnapshot() }),
    getStats: async () => ({ stats: localIndex.getStats() }),
  } as unknown as WorkerBridge;

  const engine = new HybridRetrievalEngine(mockBridge);

  // Test 3.1: Pure Lexical + Exact Bonus Search
  const resLexical = await engine.search({ query: 'Database migration script' });
  assert(resLexical.hits.length > 0, 'Should find lexical matches');
  assert(resLexical.hits[0].messageId === 'msg_1', 'Message 1 must be top ranked for lexical query');
  assert(resLexical.hits[0].exactBonus > 0, 'Exact phrase must receive bonus');

  // Test 3.2: Semantic Conceptual Search
  const resSemantic = await engine.search({
    query: 'postgres schema update error',
    semanticQuery: 'postgres schema update error',
  });
  assert(resSemantic.hits.length > 0, 'Should return semantic candidates');
  assert(resSemantic.hits[0].messageId === 'msg_1', 'Message 1 must rank highest semantically for database migration error');

  // Test 3.3: Regex Pattern Search
  const resPattern = await engine.search({
    pattern: '\\b\\d{6}\\b',
  });
  assert(resPattern.hits.length > 0, 'Should find pattern matches');
  assert(resPattern.hits[0].messageId === 'msg_2', 'Message 2 with OTP 849201 must match pattern');
  assert(resPattern.hits[0].regexMatches?.includes('849201'), 'Must capture extracted OTP match');

  // Test 3.4: Scope Isolation Enforcement
  const scopeRestricted = await engine.search(
    { query: 'Database' },
    {
      channelId: 'ch_random',
      channelName: 'random',
      channelType: 0,
      isDM: false,
      isGroupDM: false,
      isGuild: true,
      guildId: 'guild_1',
      accessibleGuildChannels: [{ id: 'ch_random', name: 'random' }],
    },
  );
  assert(
    scopeRestricted.hits.length === 0,
    'Scope filtering must reject inaccessible channel ch_dev when user only has access to ch_random',
  );

  // Test 3.5: Conversational Episode Grouping
  const episodeRes = await engine.search({
    query: 'Database',
    groupEpisodes: true,
  });
  assert(episodeRes.episodes !== undefined && episodeRes.episodes.length > 0, 'Should group episodes when requested');
  assert(episodeRes.episodes[0].primaryHit.messageId === 'msg_1', 'Primary hit should be msg_1');
  assert(episodeRes.episodes[0].messages.length >= 2, 'Should include adjacent messages within 5 min window');

  // =========================================================================
  // 4. Performance & Scalability Verification
  // =========================================================================
  console.log('  -> 4. Performance & Scale Latency Verification (5,000 Messages)');

  const perfIndex = new InvertedIndex(6000);
  const perfBatch: DiscordMessage[] = [];
  const words = ['deploy', 'kubernetes', 'cluster', 'timeout', 'database', 'postgres', 'docker', 'pipeline', 'gateway', 'auth'];

  for (let i = 0; i < 5000; i++) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 3) % words.length];
    perfBatch.push({
      id: `perf_${i}`,
      channel_id: `ch_${i % 5}`,
      author: { id: `u_${i % 20}`, username: `user_${i % 20}` },
      content: `System test log #${i} ${w1} encountered ${w2} during execution.`,
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    });
  }

  perfIndex.addBatch(perfBatch);

  const perfBridge = {
    search: async (q: any) => perfIndex.search(q),
    createSnapshot: async () => ({ snapshot: perfIndex.exportSnapshot() }),
    getStats: async () => ({ stats: perfIndex.getStats() }),
  } as unknown as WorkerBridge;

  const perfEngine = new HybridRetrievalEngine(perfBridge);

  const t0 = Date.now();
  const perfRes = await perfEngine.search({
    query: 'kubernetes cluster timeout',
    semanticQuery: 'kubernetes cluster timeout',
    limit: 25,
  });
  const elapsed = Date.now() - t0;

  console.log(`     Latency for hybrid query across 5,000 messages: ${elapsed}ms (found ${perfRes.hits.length} hits)`);
  assert(elapsed < 50, `Retrieval latency must be under 50ms, took ${elapsed}ms`);
  assert(perfRes.hits.length > 0, 'Should find top hits in perf test');

  console.log('[Test:Retrieval] All Milestone 2 Unit & Integration Tests Passed Successfully! ✓\n');
}

// Direct execution harness
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('retrieval.test.ts')) {
  runRetrievalUnitAndIntegrationTests().catch((err) => {
    console.error('[Test:Retrieval] Test Failure:', err);
    process.exit(1);
  });
}
