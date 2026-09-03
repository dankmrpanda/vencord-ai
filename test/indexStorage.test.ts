/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { messageDb } from '../storage/db';
import {
  binarySearchDocId,
  InvertedIndex,
  TopKHeap,
} from '../storage/index/invertedIndex';
import {
  CONVERSATIONAL_STOPWORDS,
  extractQueryTokens,
  sanitizeDiscordText,
  tokenizeText,
} from '../storage/index/tokenizer';
import { MESSAGE_FLAGS } from '../storage/index/types';
import { WorkerBridge } from '../storage/index/workerBridge';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertRoughlyEqual(a: number, b: number, epsilon = 0.001, message = ''): void {
  if (Math.abs(a - b) > epsilon) {
    throw new Error(`Assertion failed: ${a} not roughly equal to ${b}. ${message}`);
  }
}

console.log('[Test] Running Tokenizer tests...');

// 1. Tokenizer Tests
{
  // Test Discord syntax sanitization
  const raw = 'Hello <@123456> check <#789012> and <@&345678> with <:kekw:999> and <a:party:888> at https://example.com/docs/api';
  const sanitized = sanitizeDiscordText(raw);
  assert(sanitized.includes('mention_123456'), 'User mention should be sanitized to mention_<id>');
  assert(sanitized.includes('channel_789012'), 'Channel mention should be sanitized to channel_<id>');
  assert(sanitized.includes('role_345678'), 'Role mention should be sanitized to role_<id>');
  assert(sanitized.includes('kekw'), 'Static emoji name should be extracted');
  assert(sanitized.includes('party'), 'Animated emoji name should be extracted');
  assert(sanitized.includes('example.com') && sanitized.includes('docs'), 'URL hostname and path should be extracted');

  // Test tokenization and stopword removal
  const text = 'The quick brown fox jumps over the lazy dog and says hello lol tbh';
  const tokenized = tokenizeText(text, { removeStopwords: true });
  assert(!tokenized.terms.includes('the'), 'Stopword "the" should be filtered');
  assert(!tokenized.terms.includes('and'), 'Stopword "and" should be filtered');
  assert(!tokenized.terms.includes('over'), 'Stopword "over" should be filtered');
  assert(!tokenized.terms.includes('lol'), 'Chat slang "lol" should be filtered');
  assert(!tokenized.terms.includes('tbh'), 'Chat slang "tbh" should be filtered');
  assert(tokenized.terms.includes('quick'), '"quick" should be preserved');
  assert(tokenized.terms.includes('brown'), '"brown" should be preserved');
  assert(tokenized.terms.includes('fox'), '"fox" should be preserved');
  assert(tokenized.frequencies.get('fox') === 1, 'Frequency of "fox" should be 1');

  // Test punctuation trimming and hyphen/dot handling
  const punctuationText = '...example--- ...data... test_var error-code-404 auth.service';
  const punctResult = tokenizeText(punctuationText);
  assert(punctResult.terms.includes('example'), 'Leading/trailing dots and dashes should be stripped from example');
  assert(punctResult.terms.includes('data'), 'Leading/trailing dots and dashes should be stripped from data');
  assert(punctResult.terms.includes('test_var'), 'Underscores inside identifiers should be retained');
  assert(punctResult.terms.includes('error-code-404'), 'Hyphens inside identifiers should be retained');
  assert(punctResult.terms.includes('auth') && punctResult.terms.includes('service'), 'Dots should delimit identifiers like auth.service');

  // Test query token extraction with short queries relaxing stopwords
  const shortQuery = 'who is';
  const shortTokens = extractQueryTokens(shortQuery);
  assert(shortTokens.includes('who') && shortTokens.includes('is'), 'Short queries (<=2 words) should retain stopwords');

  const longQuery = 'who is the engineer that solved the issue';
  const longTokens = extractQueryTokens(longQuery);
  assert(!longTokens.includes('who'), 'Long queries should strip conversational stopwords');
  assert(longTokens.includes('engineer') && longTokens.includes('solved') && longTokens.includes('issue'), 'Keywords should be retained');
}

console.log('[Test] Running Binary Search & TopK Heap tests...');

// 2. Binary Search & Heap Tests
{
  const sortedArr = new Uint32Array([10, 20, 35, 50, 100, 250, 999]);
  assert(binarySearchDocId(sortedArr, 10) === 0, 'Should find first element');
  assert(binarySearchDocId(sortedArr, 50) === 3, 'Should find middle element');
  assert(binarySearchDocId(sortedArr, 999) === 6, 'Should find last element');
  assert(binarySearchDocId(sortedArr, 40) === -1, 'Should return -1 for missing element');

  const heap = new TopKHeap(3);
  heap.push({ docId: 1, messageId: 'm1', score: 10, bm25Score: 10, exactBonus: 0, recencyBonus: 0, matchedTokens: 1, totalQueryTokens: 1 });
  heap.push({ docId: 2, messageId: 'm2', score: 50, bm25Score: 50, exactBonus: 0, recencyBonus: 0, matchedTokens: 1, totalQueryTokens: 1 });
  heap.push({ docId: 3, messageId: 'm3', score: 20, bm25Score: 20, exactBonus: 0, recencyBonus: 0, matchedTokens: 1, totalQueryTokens: 1 });
  heap.push({ docId: 4, messageId: 'm4', score: 40, bm25Score: 40, exactBonus: 0, recencyBonus: 0, matchedTokens: 1, totalQueryTokens: 1 });
  heap.push({ docId: 5, messageId: 'm5', score: 5, bm25Score: 5, exactBonus: 0, recencyBonus: 0, matchedTokens: 1, totalQueryTokens: 1 });

  const results = heap.getSortedResults();
  assert(results.length === 3, 'TopK heap should limit results to maxK = 3');
  assert(results[0].score === 50 && results[0].docId === 2, 'Top result should have highest score (50)');
  assert(results[1].score === 40 && results[1].docId === 4, 'Second result should have score (40)');
  assert(results[2].score === 20 && results[2].docId === 3, 'Third result should have score (20)');
}

console.log('[Test] Running InvertedIndex & BM25 Scoring tests...');

// 3. InvertedIndex Tests
{
  const index = new InvertedIndex();

  const now = Date.now();
  const sampleMessages: DiscordMessage[] = [
    {
      id: 'msg_101',
      channel_id: 'chan_general',
      guild_id: 'guild_1',
      author: { id: 'user_alice', username: 'Alice', globalName: 'Alice Wonderland' },
      content: 'Database connection failed with error code ECONNREFUSED in PostgreSQL pool',
      timestamp: new Date(now - 1000 * 60 * 5).toISOString(), // 5 mins ago
      attachments: [{ id: 'att1', filename: 'server_dump.log', size: 1024, url: 'http://example.com/log', proxy_url: 'http://example.com/log' }],
      embeds: [],
      mentions: [],
    },
    {
      id: 'msg_102',
      channel_id: 'chan_general',
      guild_id: 'guild_1',
      author: { id: 'user_bob', username: 'Bob', globalName: 'Bob The Builder' },
      content: 'I restarted PostgreSQL and refreshed the connection credentials',
      timestamp: new Date(now - 1000 * 60 * 2).toISOString(), // 2 mins ago
      attachments: [],
      embeds: [{ title: 'PostgreSQL status' }],
      mentions: [],
      pinned: true,
    },
    {
      id: 'msg_103',
      channel_id: 'chan_dev',
      guild_id: 'guild_1',
      author: { id: 'user_charlie', username: 'Charlie' },
      content: 'Frontend build passing with webpack bundle optimization',
      timestamp: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(), // 10 days ago
      attachments: [],
      embeds: [],
      mentions: [{ id: 'user_alice', username: 'Alice' }],
      message_reference: { message_id: 'msg_101', channel_id: 'chan_general' },
    },
  ];

  const added = index.addBatch(sampleMessages);
  assert(added === 3, `Should add 3 messages, got ${added}`);

  // Deduplication check
  const duplicateAdded = index.addBatch(sampleMessages);
  assert(duplicateAdded === 0, 'Duplicate message additions should be ignored');

  const stats = index.getStats();
  assert(stats.totalDocs === 3, 'Stats should report 3 total docs');
  assert(stats.uniqueTerms > 0, 'Vocabulary terms should be registered');

  // Verify search for "PostgreSQL connection"
  const searchRes1 = index.search({ query: 'PostgreSQL connection', limit: 10 });
  assert(searchRes1.hits.length >= 2, 'Should find matching messages mentioning PostgreSQL');
  assert(searchRes1.records[0].id === 'msg_101' || searchRes1.records[0].id === 'msg_102', 'Top result should be msg_101 or msg_102');

  // Verify attachment search: "server_dump"
  const searchAttachment = index.search({ query: 'server_dump' });
  assert(searchAttachment.hits.length === 1 && searchAttachment.hits[0].messageId === 'msg_101', 'Should match attachment filename');

  // Verify exact match boosting
  const exactRes = index.search({ query: 'error code ECONNREFUSED' });
  assert(exactRes.hits.length > 0 && exactRes.hits[0].exactBonus > 0, 'Exact phrase should receive exact match bonus');

  // Verify Channel Scope Filter
  const devScopeRes = index.search({ query: 'PostgreSQL', channelIds: ['chan_dev'] });
  assert(devScopeRes.hits.length === 0, 'Channel filter chan_dev should exclude general channel messages');

  const genScopeRes = index.search({ query: 'PostgreSQL', channelIds: ['chan_general'] });
  assert(genScopeRes.hits.length === 2, 'Channel filter chan_general should return both messages');

  // Verify Author Filter
  const authorRes = index.search({ query: 'PostgreSQL', authorId: 'user_alice' });
  assert(authorRes.hits.length === 1 && authorRes.hits[0].messageId === 'msg_101', 'Author filter should match only Alice');

  // Verify Flag Filters (Pinned, Mentions, Attachments, Replies)
  const pinnedRes = index.search({ query: 'PostgreSQL', flagsRequired: MESSAGE_FLAGS.IS_PINNED });
  assert(pinnedRes.hits.length === 1 && pinnedRes.hits[0].messageId === 'msg_102', 'Flags filter should match only pinned message');

  const replyRes = index.search({ query: 'frontend', flagsRequired: MESSAGE_FLAGS.HAS_REPLY });
  assert(replyRes.hits.length === 1 && replyRes.hits[0].messageId === 'msg_103', 'Flags filter should match reply message');

  // Verify Deletion
  const deletedCount = index.deleteMessages(['msg_101']);
  assert(deletedCount === 1, 'Should report 1 deleted message');
  const postDeleteRes = index.search({ query: 'ECONNREFUSED' });
  assert(postDeleteRes.hits.length === 0, 'Deleted message should no longer appear in search results');
  assert(index.getStats().totalDocs === 2, 'Stats totalDocs should decrease to 2');
}

console.log('[Test] Running Snapshot Export/Import tests...');

// 4. Snapshot Export / Import Tests
{
  const indexA = new InvertedIndex();
  const msgs: DiscordMessage[] = [
    {
      id: 'snap_1',
      channel_id: 'ch_1',
      author: { id: 'u_1', username: 'User1' },
      content: 'Snapshot test alpha bravo charlie',
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'snap_2',
      channel_id: 'ch_2',
      author: { id: 'u_2', username: 'User2' },
      content: 'Snapshot test delta echo foxtrot',
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  indexA.addBatch(msgs);
  const snapshot = indexA.exportSnapshot();

  assert(snapshot.version === 1, 'Snapshot version should be 1');
  assert(snapshot.documents.length === 2, 'Snapshot should contain 2 documents');
  assert(snapshot.postings.length > 0, 'Snapshot should contain postings');

  const indexB = new InvertedIndex();
  indexB.importSnapshot(snapshot);

  const statsB = indexB.getStats();
  assert(statsB.totalDocs === 2, 'Imported index should have totalDocs === 2');

  const resB = indexB.search({ query: 'alpha bravo' });
  assert(resB.hits.length === 1 && resB.hits[0].messageId === 'snap_1', 'Imported index should produce identical search results');
}

console.log('[Test] Running WorkerBridge tests...');

// 5. WorkerBridge Tests
export async function runWorkerBridgeTests(): Promise<void> {
  const bridge = new WorkerBridge();
  await bridge.init();

  const msgs: DiscordMessage[] = [
    {
      id: 'wb_1',
      channel_id: 'ch_test',
      author: { id: 'u_test', username: 'Tester' },
      content: 'Worker bridge integration verified successfully',
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  let progressCalled = false;
  const ingestResult = await bridge.ingestBatch(msgs, (indexed, total) => {
    progressCalled = true;
  });

  assert(ingestResult.indexedCount === 1, 'Bridge ingest should index 1 message');
  assert(progressCalled, 'Progress callback should be invoked');

  const searchResult = await bridge.search({ query: 'bridge integration' });
  assert(searchResult.hits.length === 1, 'Bridge search should find matching message');
  assert(searchResult.records[0].id === 'wb_1', 'Bridge search record should match wb_1');

  const stats = await bridge.getStats();
  assert(stats.totalDocs === 1, 'Bridge stats should report 1 document');

  const snapshot = await bridge.createSnapshot();
  assert(snapshot.documents.length === 1, 'Bridge createSnapshot should export snapshot');

  await bridge.clear();
  const clearedStats = await bridge.getStats();
  assert(clearedStats.totalDocs === 0, 'Bridge clear should empty index');

  await bridge.loadSnapshot(snapshot);
  const reloadedStats = await bridge.getStats();
  assert(reloadedStats.totalDocs === 1, 'Bridge loadSnapshot should restore index');

  await bridge.deleteMessages(['wb_1']);
  const postDeleteStats = await bridge.getStats();
  assert(postDeleteStats.totalDocs === 0, 'Bridge deleteMessages should remove message');
}

console.log('[Test] Running MessageDatabase tests...');

// 6. Database Tests
export async function runDatabaseTests(): Promise<void> {
  await messageDb.clearAll();

  const msgs: DiscordMessage[] = [
    {
      id: 'db_m1',
      channel_id: 'ch_db_1',
      author: { id: 'u_1', username: 'Alice' },
      content: 'Persisted message content 1',
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
    {
      id: 'db_m2',
      channel_id: 'ch_db_1',
      author: { id: 'u_2', username: 'Bob' },
      content: 'Persisted message content 2',
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  ];

  await messageDb.saveMessages(msgs);
  const channelMsgs = await messageDb.getMessagesForChannel('ch_db_1');
  assert(channelMsgs.length === 2, `Should retrieve 2 channel messages, got ${channelMsgs.length}`);

  const singleMsg = await messageDb.getMessage('db_m1');
  assert(singleMsg !== null && singleMsg.id === 'db_m1', 'Should retrieve single message by id');

  await messageDb.deleteMessages(['db_m1']);
  const remaining = await messageDb.getMessagesForChannel('ch_db_1');
  assert(remaining.length === 1 && remaining[0].id === 'db_m2', 'Should delete single message');

  // Test ChannelSyncState
  await messageDb.setChannelSyncState({
    channelId: 'ch_db_1',
    lastMessageId: 'db_m2',
    oldestMessageId: 'db_m2',
    messageCount: 1,
    lastSyncTimestamp: Date.now(),
  });

  const syncState = await messageDb.getChannelSyncState('ch_db_1');
  assert(syncState !== null && syncState.lastMessageId === 'db_m2', 'Should retrieve channel sync state');

  const allSyncStates = await messageDb.getAllChannelSyncStates();
  assert(allSyncStates.length === 1, 'Should retrieve all channel sync states');

  // Test Snapshot storage
  const sampleSnapshot = {
    version: 1,
    stats: {
      totalDocs: 1,
      totalTokens: 5,
      avgdl: 5,
      uniqueTerms: 3,
      memoryUsageBytes: 100,
      lastUpdated: Date.now(),
    },
    documents: [],
    docLengths: new Uint16Array([5]),
    postings: [],
    channelDocMap: {},
    authorDocMap: {},
  };

  await messageDb.saveIndexSnapshot(sampleSnapshot);
  const loadedSnapshot = await messageDb.loadIndexSnapshot();
  assert(loadedSnapshot !== null && loadedSnapshot.version === 1, 'Should persist and load index snapshot');

  await messageDb.clearAll();
  const clearedMsgs = await messageDb.getMessagesForChannel('ch_db_1');
  assert(clearedMsgs.length === 0, 'clearAll should wipe all stores');
}

export async function runIndexStorageTests(): Promise<void> {
  await runWorkerBridgeTests();
  await runDatabaseTests();
  console.log('Index and Storage tests passed.');
}
