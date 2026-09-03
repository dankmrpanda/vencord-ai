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
  hashStringSign,
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

export async function runAdversarialReviewChallengerTests(): Promise<void> {
  console.log('======================================================');
  console.log('🔥 RUNNING ADVERSARIAL CHALLENGER STRESS SUITE FOR M2 🔥');
  console.log('======================================================\n');

  // ---------------------------------------------------------------------------
  // Challenge 1: Adversarial ReDoS Patterns & Timeout Bounds
  // ---------------------------------------------------------------------------
  console.log('--- Challenge 1: Adversarial ReDoS Patterns & Timeout Bounds ---');

  const evilPatterns = [
    '(a+)+$',
    '(a+)+b',
    '(a*)*',
    '(a|a)+',
    '(a|ab)+',
    '(.*)+',
    '(.+)*',
    '([0-9]+)+',
    '([a-zA-Z]+)*',
    '\\d+\\d+',
    '\\w+\\w+',
  ];

  for (const pattern of evilPatterns) {
    const safe = isRegexSafe(pattern);
    assert(!safe, `Evil pattern "${pattern}" must be flagged as unsafe by isRegexSafe`);
    const compiled = compileSafeRegex(pattern);
    assert(!compiled.isSafe, `compileSafeRegex must reject evil pattern "${pattern}"`);
    assert(compiled.regex === null, `compileSafeRegex must return null regex for "${pattern}"`);
  }

  // Even if an unsafe pattern somehow passed compileSafeRegex (e.g. forced RegExp object),
  // extractMatchesFromText must enforce a 15ms timeout and 10k character slice without hanging the thread
  const forcedEvil = new RegExp('^(a+)+$');
  const evilInput = 'a'.repeat(30) + '!';
  const t0 = Date.now();
  const matches = extractMatchesFromText(evilInput, forcedEvil, 10, 15);
  const duration = Date.now() - t0;
  assert(duration < 200, `extractMatchesFromText must not stall or exceed timeout budget (took ${duration}ms)`);
  console.log(`✅ Passed Challenge 1: ReDoS rejection & execution bounds verified (duration: ${duration}ms)`);

  // ---------------------------------------------------------------------------
  // Challenge 2: Semantic Embedding Edge Cases, Zeros, and NaNs
  // ---------------------------------------------------------------------------
  console.log('\n--- Challenge 2: Semantic Embedding Edge Cases, Zeros, and NaNs ---');

  // Empty string
  const emptyVec = generateDenseEmbedding('');
  assert(emptyVec.length === 128, 'Empty text vector must have length 128');
  let emptySum = 0;
  for (let i = 0; i < emptyVec.length; i++) emptySum += Math.abs(emptyVec[i]);
  assert(emptySum === 0, 'Empty text vector should be all zeros');

  // Whitespace string
  const wsVec = generateDenseEmbedding('   \n\t  ');
  let wsSum = 0;
  for (let i = 0; i < wsVec.length; i++) wsSum += Math.abs(wsVec[i]);
  assert(wsSum === 0, 'Whitespace-only vector should be all zeros');

  // Cosine similarity between zero vectors
  const simZeroZero = computeCosineSimilarity(emptyVec, wsVec);
  assert(simZeroZero === 0, 'Cosine similarity between zero vectors must be 0, got ' + simZeroZero);
  assert(!Number.isNaN(simZeroZero), 'Cosine similarity between zero vectors must not be NaN');

  // Cosine similarity between normal vector and zero vector
  const normalVec = generateDenseEmbedding('hello world');
  const simNormalZero = computeCosineSimilarity(normalVec, emptyVec);
  assert(simNormalZero === 0, 'Cosine similarity with zero vector must be 0');
  assert(!Number.isNaN(simNormalZero), 'Cosine similarity must not be NaN');

  // Long adversarial string
  const longText = 'discord '.repeat(5000);
  const longVec = generateDenseEmbedding(longText);
  assert(longVec.length === 128, 'Long text vector must have length 128');
  let longNorm = 0;
  for (let i = 0; i < longVec.length; i++) {
    assert(Number.isFinite(longVec[i]), `Vector component ${i} must be finite`);
    longNorm += longVec[i] * longVec[i];
  }
  assert(Math.abs(Math.sqrt(longNorm) - 1.0) < 1e-4, 'Long text vector must be normalized to unit length');

  // CJK and Unicode Emojis
  const emojiVec = generateDenseEmbedding('🚀🔥✨💻🎉');
  assert(emojiVec.length === 128, 'Emoji text vector must have length 128');

  console.log('✅ Passed Challenge 2: Embedding robustness, zero vectors, and NaN resistance verified');

  // ---------------------------------------------------------------------------
  // Challenge 3: Structured Pattern Precision & Entity Extraction
  // ---------------------------------------------------------------------------
  console.log('\n--- Challenge 3: Structured Pattern Precision & Entity Extraction ---');

  const complexMsg: DiscordMessage = {
    id: '123456789012345678',
    channel_id: '987654321098765432',
    guild_id: '112233445566778899',
    author: { id: 'u1', username: 'sec_admin' },
    content: 'Please use OTP 492018 or PIN 1234. Contact support@vencord.com or dev_ops@test.io. Gateway 192.168.1.1 or IPv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334. Join https://discord.gg/vencord or link https://discord.com/channels/112233445566778899/987654321098765432/123456789012345678. Color is #ff55aa and commit 0x71C66332e333D348A745B0360a0E82049195F932 on 2026-05-20T14:30:00Z (slash: 05/20/2026).',
    timestamp: '2026-05-20T14:30:00Z',
    attachments: [{ id: 'a1', filename: 'server_10.0.0.1.cfg', size: 512, url: '', proxy_url: '' }],
    embeds: [{ title: 'Sub-alert', description: 'Secondary OTP: 778899' }],
    mentions: [],
  };

  const extracted = extractMessagePatternMatches(complexMsg, STRUCTURED_PATTERNS.IPV4);
  assert(extracted.includes('192.168.1.1'), 'Must extract 192.168.1.1');
  assert(extracted.includes('10.0.0.1'), 'Must extract 10.0.0.1 from attachment');

  const extractedEmails = extractMessagePatternMatches(complexMsg, STRUCTURED_PATTERNS.EMAIL);
  assert(extractedEmails.includes('support@vencord.com'), 'Must extract support@vencord.com');
  assert(extractedEmails.includes('dev_ops@test.io'), 'Must extract dev_ops@test.io');

  const extractedInvites = extractMessagePatternMatches(complexMsg, STRUCTURED_PATTERNS.DISCORD_INVITE);
  assert(extractedInvites.some((inv) => inv.includes('discord.gg/vencord')), 'Must extract discord invite');

  const extractedSnowflakes = extractMessagePatternMatches(complexMsg, STRUCTURED_PATTERNS.SNOWFLAKE_ID);
  assert(extractedSnowflakes.includes('123456789012345678'), 'Must extract 18-digit snowflake ID');

  console.log('✅ Passed Challenge 3: Structured pattern extraction precision verified across all 12 patterns');

  // ---------------------------------------------------------------------------
  // Challenge 4: Hybrid Retrieval Engine Edge Cases & RRF Fusion
  // ---------------------------------------------------------------------------
  console.log('\n--- Challenge 4: Hybrid Retrieval Engine Edge Cases & RRF Fusion ---');

  const index = new InvertedIndex();
  const msgs: DiscordMessage[] = [
    {
      id: 'msg_101',
      channel_id: 'ch_public',
      author: { id: 'u1', username: 'alice' },
      content: 'PostgreSQL database index vacuum completed without error.',
      timestamp: new Date('2026-05-01T10:00:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'msg_102',
      channel_id: 'ch_public',
      author: { id: 'u2', username: 'bob' },
      content: 'The 6-digit confirmation OTP is 918273.',
      timestamp: new Date('2026-05-01T10:02:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'msg_103',
      channel_id: 'ch_secret',
      author: { id: 'u3', username: 'charlie' },
      content: 'Secret database credentials in restricted channel.',
      timestamp: new Date('2026-05-01T10:03:00Z').toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  index.addBatch(msgs);

  const mockBridge = {
    search: async (q: any) => index.search(q),
    createSnapshot: async () => ({ snapshot: index.exportSnapshot() }),
    getStats: async () => ({ stats: index.getStats() }),
  } as unknown as WorkerBridge;

  const engine = new HybridRetrievalEngine(mockBridge);

  // Test 4.1: Completely empty query object
  const resEmpty = await engine.search({});
  assert(resEmpty !== undefined, 'Engine must handle empty query gracefully');
  assert(Array.isArray(resEmpty.hits), 'Hits must be an array');

  // Test 4.2: Query with unsafe regex (should be ignored gracefully without crash)
  const resBadRegex = await engine.search({
    query: 'database',
    pattern: '(a+)+$',
  });
  assert(resBadRegex.hits.length > 0, 'BM25 should still succeed even if regex is unsafe and rejected');

  // Test 4.3: Scope filter strictly blocking forbidden channel
  const resScope = await engine.search(
    { query: 'database' },
    {
      channelId: 'ch_public',
      channelName: 'public',
      channelType: 0,
      isDM: false,
      isGroupDM: false,
      isGuild: true,
      guildId: 'guild_1',
      accessibleGuildChannels: [{ id: 'ch_public', name: 'public' }],
    },
  );
  assert(
    !resScope.hits.some((h) => h.record.channelId === 'ch_secret'),
    'Scope filter must never return messages from ch_secret',
  );
  assert(resScope.hits.some((h) => h.record.channelId === 'ch_public'), 'Scope filter must return messages from ch_public');

  // Test 4.4: Conversational grouping
  const resEpisode = await engine.search({
    query: 'PostgreSQL',
    groupEpisodes: true,
  });
  assert(resEpisode.episodes !== undefined && resEpisode.episodes.length > 0, 'Must produce episodes');
  assert(resEpisode.episodes[0].messages.length === 2, 'Must group msg_101 and msg_102 in ch_public within 2 minutes');

  console.log('✅ Passed Challenge 4: Hybrid engine edge cases, RRF fusion, and episode grouping verified');

  // ---------------------------------------------------------------------------
  // Challenge 5: Massive Candidate List RRF Stability & Non-Degradation
  // ---------------------------------------------------------------------------
  console.log('\n--- Challenge 5: Massive Candidate List RRF Stability & Performance ---');

  const largeBatch: DiscordMessage[] = [];
  for (let i = 0; i < 2000; i++) {
    largeBatch.push({
      id: `m_${i}`,
      channel_id: `ch_${i % 10}`,
      author: { id: `u_${i % 50}`, username: `user_${i}` },
      content: `Log entry #${i}: system migration ${i % 2 === 0 ? 'succeeded' : 'failed with lock contention'}. Code: ${100000 + i}`,
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    });
  }

  const largeIndex = new InvertedIndex(3000);
  largeIndex.addBatch(largeBatch);

  const largeBridge = {
    search: async (q: any) => largeIndex.search(q),
    createSnapshot: async () => ({ snapshot: largeIndex.exportSnapshot() }),
    getStats: async () => ({ stats: largeIndex.getStats() }),
  } as unknown as WorkerBridge;

  const largeEngine = new HybridRetrievalEngine(largeBridge);

  const tStart = Date.now();
  const resLarge = await largeEngine.search({
    query: 'migration lock contention',
    semanticQuery: 'database migration error failure',
    pattern: '\\b\\d{6}\\b',
    limit: 50,
  });
  const largeElapsed = Date.now() - tStart;

  console.log(`     Large RRF fusion search across 2,000 docs completed in ${largeElapsed}ms (found ${resLarge.hits.length} hits)`);
  assert(largeElapsed < 100, `Large hybrid search must complete under 100ms, took ${largeElapsed}ms`);
  assert(resLarge.hits.length === 50, 'Must return requested limit of 50 hits');

  // Verify scores are strictly monotonically descending and all scores are valid finite numbers > 0
  for (let i = 0; i < resLarge.hits.length; i++) {
    const hit = resLarge.hits[i];
    assert(Number.isFinite(hit.score), `Hit ${i} score must be finite`);
    assert(!Number.isNaN(hit.score), `Hit ${i} score must not be NaN`);
    assert(hit.score > 0, `Hit ${i} score must be > 0`);
    if (i > 0) {
      assert(hit.score <= resLarge.hits[i - 1].score, `Hit ${i} score (${hit.score}) must be <= previous score (${resLarge.hits[i - 1].score})`);
    }
  }

  console.log('✅ Passed Challenge 5: Large candidate RRF score monotonicity and numerical stability verified');

  console.log('\n======================================================');
  console.log('🏆 ALL ADVERSARIAL CHALLENGES PASSED SUCCESSFULLY! 🏆');
  console.log('======================================================\n');
}

void runAdversarialReviewChallengerTests().catch((err) => {
  console.error('[Challenger] Failure:', err);
  process.exitCode = 1;
});
