/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { InMemoryBM25Index, StoredMessageRecord } from './benchmark100k';
import { ChannelType, CurrentScopeContext, DiscordMessage } from '../types';
import { assert } from './assert';

function createMockMessage(
  id: string,
  channelId: string,
  content: string,
  options: Partial<DiscordMessage> = {}
): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    guild_id: channelId.startsWith('guild_') ? channelId.split('_ch_')[0] : undefined,
    author: options.author || { id: 'user_1', username: 'alice', globalName: 'Alice' },
    content,
    timestamp: options.timestamp || '2026-03-01T12:00:00.000Z',
    attachments: options.attachments || [],
    embeds: options.embeds || [],
    mentions: options.mentions || [],
    pinned: options.pinned || false,
    message_reference: options.message_reference,
    hit: true,
  };
}

export function runIndexerUnitAndPropertyTests(): void {
  console.log('\n--- Running Inverted Index, BM25 & Property Test Suite ---');

  // ==========================================================================
  // 1. TOKENIZATION UNIT TESTS
  // ==========================================================================
  const index = new InMemoryBM25Index();

  // Test 1.1: Basic Tokenization & Stopwords
  const tokensBasic = index.tokenize('The quick brown fox jumps over the lazy dog and we have it all');
  assert(tokensBasic.includes('quick') && tokensBasic.includes('brown') && tokensBasic.includes('fox'), 'Content tokens should be extracted');
  assert(!tokensBasic.includes('the') && !tokensBasic.includes('and') && !tokensBasic.includes('we'), 'Common stopwords must be pruned');

  // Test 1.2: Punctuation & Hyphenation
  const tokensPunct = index.tokenize('cross-site scripting (XSS) vulnerability in auth.service: v1.2.3!');
  assert(tokensPunct.includes('cross-site'), 'Hyphenated words like "cross-site" should be preserved');
  assert(tokensPunct.includes('xss'), 'Punctuation-enclosed words like "(XSS)" should be cleaned to "xss"');
  assert(tokensPunct.includes('vulnerability'), 'Words before colons should be extracted');

  // Test 1.3: Unicode, Emojis & Non-ASCII
  const tokensUnicode = index.tokenize('Tokyo trip 🚀 ラーメン in Shinjuku café');
  assert(tokensUnicode.includes('tokyo') && tokensUnicode.includes('shinjuku'), 'Unicode text should normalize properly');

  // Test 1.4: Empty & Whitespace strings
  assert(index.tokenize('').length === 0, 'Empty string tokenization should return empty array');
  assert(index.tokenize('   \t\n   ').length === 0, 'Whitespace-only tokenization should return empty array');

  // ==========================================================================
  // 2. BM25 MATHEMATICAL SCORING UNIT TESTS
  // ==========================================================================
  index.clear();

  // Populate small corpus to verify BM25 math
  const msgDoc1 = createMockMessage('1', 'ch_test', 'postgres migration lock database');
  const msgDoc2 = createMockMessage('2', 'ch_test', 'postgres postgres postgres high cpu lock lock');
  const msgDoc3 = createMockMessage('3', 'ch_test', 'react zustand state management frontend bundle');
  const msgDoc4 = createMockMessage('4', 'ch_test', 'postgres database performance tuning memory cache optimization tips and tricks for production clusters');

  index.indexBatch([msgDoc1, msgDoc2, msgDoc3, msgDoc4]);

  const testScope: CurrentScopeContext = {
    channelId: 'ch_test',
    channelName: 'test',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: 'guild_1',
    accessibleGuildChannels: [{ id: 'ch_test', name: 'test' }],
  };

  // Test 2.1: Term Frequency Saturation (doc2 has 3 "postgres", doc1 has 1)
  const resultsTf = index.search({ query: 'postgres' }, testScope);
  assert(resultsTf.length >= 2, 'Should find messages containing postgres');
  const scoreDoc2 = resultsTf.find((r) => r.message.id === '2')?.bm25Score || 0;
  const scoreDoc1 = resultsTf.find((r) => r.message.id === '1')?.bm25Score || 0;
  assert(scoreDoc2 > scoreDoc1, `Higher TF should yield higher BM25 score (doc2: ${scoreDoc2.toFixed(3)} vs doc1: ${scoreDoc1.toFixed(3)})`);

  // Test 2.2: Document Length Normalization
  // doc1 is short (4 tokens), doc4 is long (11 tokens). Both have 1 "postgres" and 1 "database".
  const resultsLen = index.search({ query: 'postgres database' }, testScope);
  const scoreShort = resultsLen.find((r) => r.message.id === '1')?.bm25Score || 0;
  const scoreLong = resultsLen.find((r) => r.message.id === '4')?.bm25Score || 0;
  assert(scoreShort > scoreLong, `Shorter document should receive BM25 length boost (short: ${scoreShort.toFixed(3)} vs long: ${scoreLong.toFixed(3)})`);

  // Test 2.3: IDF Term Rarity (term "zustand" appears in 1 doc, "postgres" appears in 3 docs)
  const postingZustand = index.postings.get('zustand');
  const postingPostgres = index.postings.get('postgres');
  assert(postingZustand && postingPostgres, 'Postings must exist');
  const N = index.records.length;
  const idfZustand = Math.log((N - postingZustand.docIds.length + 0.5) / (postingZustand.docIds.length + 0.5) + 1.0);
  const idfPostgres = Math.log((N - postingPostgres.docIds.length + 0.5) / (postingPostgres.docIds.length + 0.5) + 1.0);
  assert(idfZustand > idfPostgres, `Rare term "zustand" (IDF: ${idfZustand.toFixed(3)}) must have higher IDF than common "postgres" (IDF: ${idfPostgres.toFixed(3)})`);

  // ==========================================================================
  // 3. ATTRIBUTE & METADATA FILTERING TESTS
  // ==========================================================================
  index.clear();

  const msgFilter1 = createMockMessage('101', 'ch_test', 'Check image attachment', {
    author: { id: 'user_alice', username: 'alice' },
    timestamp: '2026-03-10T10:00:00.000Z',
    attachments: [{ id: 'a1', filename: 'screenshot.png', size: 100, url: '', proxy_url: '', content_type: 'image/png' }],
    pinned: true,
  });

  const msgFilter2 = createMockMessage('102', 'ch_test', 'Check pdf file attachment', {
    author: { id: 'user_bob', username: 'bob' },
    timestamp: '2026-03-15T15:00:00.000Z',
    attachments: [{ id: 'a2', filename: 'report.pdf', size: 500, url: '', proxy_url: '', content_type: 'application/pdf' }],
    pinned: false,
  });

  const msgFilter3 = createMockMessage('103', 'ch_test', 'Visit website: https://vencord.dev for plugins', {
    author: { id: 'user_alice', username: 'alice' },
    timestamp: '2026-03-20T18:00:00.000Z',
    mentions: [{ id: 'user_bob', username: 'bob' }],
    pinned: false,
  });

  index.indexBatch([msgFilter1, msgFilter2, msgFilter3]);

  // Test 3.1: Author Filter
  const aliceResults = index.search({ authorId: 'user_alice' }, testScope);
  assert(aliceResults.length === 2 && aliceResults.every((r) => r.message.author.id === 'user_alice'), 'Author filter should match Alice messages only');

  // Test 3.2: Date Bounds Filter (duringDate, afterDate, beforeDate)
  const duringResults = index.search({ duringDate: '2026-03-15' }, testScope);
  assert(duringResults.length === 1 && duringResults[0].message.id === '102', 'duringDate should match exact calendar day');

  const afterResults = index.search({ afterDate: '2026-03-12T00:00:00.000Z' }, testScope);
  assert(afterResults.length === 2 && !afterResults.some((r) => r.message.id === '101'), 'afterDate should filter out older messages');

  const beforeResults = index.search({ beforeDate: '2026-03-12T00:00:00.000Z' }, testScope);
  assert(beforeResults.length === 1 && beforeResults[0].message.id === '101', 'beforeDate should filter out newer messages');

  // Test 3.3: Media Type Filters
  const imgResults = index.search({ has: 'image' }, testScope);
  assert(imgResults.length === 1 && imgResults[0].message.id === '101', 'has:image should match image attachment');

  const fileResults = index.search({ has: 'file' }, testScope);
  assert(fileResults.length === 1 && fileResults[0].message.id === '102', 'has:file should match PDF attachment');

  const linkResults = index.search({ has: 'link' }, testScope);
  assert(linkResults.length === 1 && linkResults[0].message.id === '103', 'has:link should match URL in content');

  // Test 3.4: Pinned Filter
  const pinnedResults = index.search({ pinned: true }, testScope);
  assert(pinnedResults.length === 1 && pinnedResults[0].message.id === '101', 'pinned:true should match pinned message');

  // Test 3.5: Mentions Filter
  const mentionResults = index.search({ mentions: 'user_bob' }, testScope);
  assert(mentionResults.length === 1 && mentionResults[0].message.id === '103', 'mentions filter should match mentioned user');

  // ==========================================================================
  // 4. SCOPE PRIVACY & FAIL-CLOSED BOUNDARY TESTS
  // ==========================================================================
  index.clear();

  const msgPublic = createMockMessage('201', 'ch_public', 'Quarterly public roadmap announcements');
  const msgPrivate = createMockMessage('202', 'ch_private_vault', 'TOP SECRET admin passwords and database credentials');
  const msgForeignDM = createMockMessage('203', 'dm_foreign', 'Private message in foreign DM');

  index.indexBatch([msgPublic, msgPrivate, msgForeignDM]);

  const publicScope: CurrentScopeContext = {
    channelId: 'ch_public',
    channelName: 'public',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: 'guild_1',
    accessibleGuildChannels: [{ id: 'ch_public', name: 'public' }],
  };

  // Test 4.1: Query targeting private vault needle fails closed
  const secretSearch = index.search({ query: 'passwords credentials' }, publicScope);
  assert(secretSearch.length === 0, 'Private channel messages must NEVER be returned to unauthorized scope');

  // Test 4.2: Guild-wide scan must never leak foreign DM
  const dmSearch = index.search({ query: 'Private message' }, publicScope);
  assert(dmSearch.length === 0, 'DM messages must NEVER be returned in guild scope');

  // ==========================================================================
  // 5. PROPERTY-BASED INVARIANT TESTS
  // ==========================================================================

  // Property 1: Term Frequency Monotonicity
  // For any message D, duplicating a query term must never decrease its BM25 score.
  index.clear();
  const testMsgBase = createMockMessage('301', 'ch_test', 'alpha beta gamma delta');
  const testMsgBoost = createMockMessage('302', 'ch_test', 'alpha alpha alpha beta gamma delta');
  index.indexBatch([testMsgBase, testMsgBoost]);
  const resMono = index.search({ query: 'alpha' }, testScope);
  const scoreBase = resMono.find((r) => r.message.id === '301')?.bm25Score || 0;
  const scoreBoost = resMono.find((r) => r.message.id === '302')?.bm25Score || 0;
  assert(scoreBoost >= scoreBase, `Property 1 Monotonicity failed: ${scoreBoost} < ${scoreBase}`);

  // Property 2: Index Idempotence & Updates
  // Indexing the exact same message ID multiple times must update the record without creating duplicate docIds.
  index.clear();
  const originalMsg = createMockMessage('401', 'ch_test', 'original version');
  const updatedMsg = createMockMessage('401', 'ch_test', 'updated version with new text');
  index.indexMessage(originalMsg);
  const docIdFirst = index.docIdMap.get('401');
  index.indexMessage(updatedMsg);
  const docIdSecond = index.docIdMap.get('401');
  assert(docIdFirst === docIdSecond, 'DocID mapping must remain identical upon re-indexing same message ID');
  assert(index.records.length === 1, 'Records array must not grow upon re-indexing same message ID');
  assert(index.records[0].content === 'updated version with new text', 'Record content must be updated in place');

  // Property 3: Scope Isolation Invariance under Adversarial Queries
  // For any query Q and any unauthorized channel C, Results(Q, Scope) intersect C = empty set.
  index.clear();
  const adversarialMessages = [
    createMockMessage('501', 'allowed_ch', 'General dev chat message'),
    createMockMessage('502', 'forbidden_ch', 'Adversarial injection query match text'),
    createMockMessage('503', 'forbidden_vault', 'Special secret token: sec_998124'),
  ];
  index.indexBatch(adversarialMessages);
  const restrictedScope: CurrentScopeContext = {
    channelId: 'allowed_ch',
    channelName: 'allowed',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: 'guild_1',
    accessibleGuildChannels: [{ id: 'allowed_ch', name: 'allowed' }],
  };

  const queries = ['Adversarial', 'injection', 'Special secret token', 'sec_998124', ''];
  for (const q of queries) {
    const r = index.search({ query: q }, restrictedScope);
    assert(r.every((item) => item.message.channel_id === 'allowed_ch'), `Scope isolation invariant violated for query "${q}"`);
  }

  // Property 4: Memory Stability across 500 repeated search cycles
  // Executing 500 search queries on an index must not leak memory or grow internal structures.
  const recordsLenBefore = index.records.length;
  const postingsSizeBefore = index.postings.size;
  for (let i = 0; i < 500; i++) {
    index.search({ query: 'dev chat message', limit: 10 }, restrictedScope);
  }
  assert(index.records.length === recordsLenBefore, 'Records length must not change during queries');
  assert(index.postings.size === postingsSizeBefore, 'Postings map size must not change during queries');

  console.log('✅ All Indexer Unit, BM25 Math, Scope Privacy & Property Tests Passed Successfully!');
}
