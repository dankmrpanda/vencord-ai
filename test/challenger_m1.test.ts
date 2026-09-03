/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { InvertedIndex, TopKHeap, binarySearchDocId } from '../storage/index/invertedIndex';
import { tokenizeText, extractQueryTokens, sanitizeDiscordText } from '../storage/index/tokenizer';
import { messageDb } from '../storage/db';
import { DiscordMessage } from '../types';

function createMsg(
  id: string,
  channelId: string,
  content: string,
  options: Partial<DiscordMessage> = {},
): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    guild_id: 'guild_test',
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

export async function runMilestone1ChallengerTests(): Promise<void> {
  console.log('\n======================================================');
  console.log('🔥 RUNNING EMPIRICAL CHALLENGER STRESS & ADVERSARIAL SUITE 🔥');
  console.log('======================================================\n');

  let passedTests = 0;
  let detectedBugs = 0;

  // =========================================================================
  // CHALLENGE 1: DocID Collision & Data Corruption on Snapshot Restore
  // =========================================================================
  console.log('--- Challenge 1: Snapshot Restore DocID Collision ---');
  {
    const idxA = new InvertedIndex(100);
    const msgs = [
      createMsg('m0', 'ch1', 'zero'),
      createMsg('m1', 'ch1', 'one'),
      createMsg('m2', 'ch1', 'two'),
      createMsg('m3', 'ch1', 'three unique_m3'),
      createMsg('m4', 'ch1', 'four unique_m4'),
    ];
    idxA.addBatch(msgs);
    idxA.deleteMessages(['m0', 'm1', 'm2']);

    const snap = idxA.exportSnapshot();

    const idxB = new InvertedIndex(100);
    idxB.importSnapshot(snap);

    // Adding 2 new messages
    idxB.addBatch([
      createMsg('m5', 'ch1', 'five new message'),
      createMsg('m6', 'ch1', 'six overwritten message'),
    ]);

    const resM3 = idxB.search({ query: 'unique_m3' });
    const isCorrupted = resM3.hits.length > 0 && resM3.records[0]?.id === 'm6';
    if (isCorrupted) {
      detectedBugs++;
      console.log('⚠️ [CONFIRMED BUG #1 - CRITICAL] DocId collision after snapshot restore: query for m3 content returned overwritten message m6!');
    } else if (resM3.hits.length === 0 || resM3.records[0]?.id !== 'm3') {
      detectedBugs++;
      console.log('⚠️ [CONFIRMED BUG #1 - CRITICAL] Message m3 was lost/corrupted after snapshot restore.');
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 1');
    }
  }

  // =========================================================================
  // CHALLENGE 2: Snapshot Restore RangeError Crash when docLengths > capacity
  // =========================================================================
  console.log('\n--- Challenge 2: Snapshot Restore RangeError Buffer Crash ---');
  {
    const idxA = new InvertedIndex(150_000);
    const msgs: DiscordMessage[] = [];
    for (let i = 0; i < 130_000; i++) {
      msgs.push(createMsg(`bulk_${i}`, 'ch1', `text payload ${i}`));
    }
    idxA.addBatch(msgs);
    idxA.deleteMessages(msgs.slice(0, 120_000).map((m) => m.id));

    const snap = idxA.exportSnapshot();

    const idxB = new InvertedIndex(50_000); // fresh index with default/smaller capacity
    try {
      idxB.importSnapshot(snap);
      passedTests++;
      console.log('✅ Passed Challenge 2');
    } catch (err: any) {
      detectedBugs++;
      console.log(`⚠️ [CONFIRMED BUG #2 - CRITICAL] importSnapshot threw unhandled exception: "${err.message}" due to capacity mismatch!`);
    }
  }

  // =========================================================================
  // CHALLENGE 3: Silent Buffer Truncation & DocLength Loss via nextDocId Growth
  // =========================================================================
  console.log('\n--- Challenge 3: docLengths Buffer Capacity vs nextDocId ---');
  {
    const smallIndex = new InvertedIndex(100);
    const b1: DiscordMessage[] = [];
    for (let i = 0; i < 80; i++) {
      b1.push(createMsg(`c3_m${i}`, 'ch1', `word_a word_b token_${i} long text message content`));
    }
    smallIndex.addBatch(b1);
    smallIndex.deleteMessages(b1.slice(0, 70).map((m) => m.id));

    // docCount = 10, nextDocId = 80. Now add 50 messages -> nextDocId reaches 130.
    const b2: DiscordMessage[] = [];
    for (let i = 80; i < 130; i++) {
      b2.push(createMsg(`c3_m${i}`, 'ch1', `word_a word_c token_${i} long text message content`));
    }
    smallIndex.addBatch(b2);

    const snap = smallIndex.exportSnapshot();
    if (snap.docLengths.length < 130 || snap.docLengths[120] === undefined || snap.docLengths[120] === 0) {
      detectedBugs++;
      console.log(`⚠️ [CONFIRMED BUG #3 - CRITICAL] docLengths buffer not resized to match nextDocId (length: ${snap.docLengths.length}, docLengths[120]: ${snap.docLengths[120]})!`);
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 3');
    }
  }

  // =========================================================================
  // CHALLENGE 4: Negative BM25 IDF Dropping Valid Documents after Deletions
  // =========================================================================
  console.log('\n--- Challenge 4: Negative IDF & False-Negative Drops ---');
  {
    const idx = new InvertedIndex();
    const msgs: DiscordMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(createMsg(
        `idf_${i}`,
        'ch1',
        `database connection error code 404 in server cluster node ${i}`,
        { timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString() },
      ));
    }
    idx.addBatch(msgs);
    idx.deleteMessages(msgs.slice(0, 9).map((m) => m.id));

    // Query remaining valid message idf_9
    const res = idx.search({ query: 'server database' });
    if (res.hits.length === 0) {
      detectedBugs++;
      console.log('⚠️ [CONFIRMED BUG #4 - HIGH] Valid matching document was dropped (0 hits) due to negative BM25 IDF when df > N after deletions!');
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 4');
    }
  }

  // =========================================================================
  // CHALLENGE 5: CJK / Multilingual Unsegmented Tokenization Failure
  // =========================================================================
  console.log('\n--- Challenge 5: CJK Unsegmented Text Tokenization ---');
  {
    const cjkIndex = new InvertedIndex();
    cjkIndex.addBatch([
      createMsg('cjk_1', 'ch1', '深度学习模型优化和推理加速'),
      createMsg('cjk_2', 'ch1', '東京の美味しいラーメン屋に行きました'),
    ]);

    const resChinese = cjkIndex.search({ query: '深度学习' });
    const resJapanese = cjkIndex.search({ query: 'ラーメン' });

    if (resChinese.hits.length === 0 || resJapanese.hits.length === 0) {
      detectedBugs++;
      console.log('⚠️ [CONFIRMED BUG #5 - MEDIUM] CJK unsegmented text fails keyword retrieval (Chinese hits: ' + resChinese.hits.length + ', Japanese hits: ' + resJapanese.hits.length + ')!');
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 5');
    }
  }

  // =========================================================================
  // CHALLENGE 6: Epoch Timestamp 0 Overwritten with Current Time
  // =========================================================================
  console.log('\n--- Challenge 6: Epoch Timestamp 0 Falsy Clashing ---');
  {
    const idx = new InvertedIndex();
    idx.addBatch([
      createMsg('epoch_0', 'ch1', 'historical message at epoch 0', { timestamp: new Date(0).toISOString() }),
    ]);

    const snap = idx.exportSnapshot();
    const storedTs = snap.documents[0]?.timestamp;
    if (storedTs > 1000000000) {
      detectedBugs++;
      console.log(`⚠️ [CONFIRMED BUG #6 - LOW] Epoch timestamp 0 was clobbered to current time (${storedTs})!`);
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 6');
    }
  }

  // =========================================================================
  // CHALLENGE 7: TopKHeap Min-Heap Property Stress Test (10,000 items)
  // =========================================================================
  console.log('\n--- Challenge 7: TopKHeap 10,000 Item Mathematical Invariant ---');
  {
    const k = 25;
    const heap = new TopKHeap(k);
    const allItems: Array<{ docId: number; score: number }> = [];

    for (let i = 0; i < 10000; i++) {
      const score = Math.random() * 1000;
      const item = {
        docId: i,
        messageId: `msg_${i}`,
        score,
        bm25Score: score,
        exactBonus: 0,
        recencyBonus: 0,
        matchedTokens: 1,
        totalQueryTokens: 1,
      };
      allItems.push({ docId: i, score });
      heap.push(item);
    }

    const expected = allItems.sort((a, b) => b.score - a.score).slice(0, k);
    const actual = heap.getSortedResults();

    let heapMatch = true;
    for (let i = 0; i < k; i++) {
      if (actual[i].docId !== expected[i].docId || Math.abs(actual[i].score - expected[i].score) > 1e-6) {
        heapMatch = false;
        break;
      }
    }

    if (!heapMatch) {
      detectedBugs++;
      console.log('⚠️ [FAIL] TopKHeap results diverged from exact sort!');
    } else {
      passedTests++;
      console.log('✅ Passed Challenge 7 (TopK min-heap matches exact sort)');
    }
  }

  // =========================================================================
  // CHALLENGE 8: Database Concurrency & Batch Transaction Stress
  // =========================================================================
  console.log('\n--- Challenge 8: Database High-Concurrency Batch Stress ---');
  {
    await messageDb.clearAll();
    const dbMsgs: DiscordMessage[] = [];
    for (let i = 0; i < 500; i++) {
      dbMsgs.push(createMsg(`db_stress_${i}`, `ch_db_${i % 5}`, `Database stress payload message ${i}`));
    }

    await Promise.all([
      messageDb.saveMessages(dbMsgs.slice(0, 250)),
      messageDb.saveMessages(dbMsgs.slice(250, 500)),
    ]);

    const ch0Msgs = await messageDb.getMessagesForChannel('ch_db_0', 200);
    const delList = ch0Msgs.slice(0, 50).map((m) => m.id);
    await messageDb.deleteMessages(delList);
    const postDelCh0 = await messageDb.getMessagesForChannel('ch_db_0', 200);

    if (ch0Msgs.length === 100 && postDelCh0.length === 50) {
      passedTests++;
      console.log('✅ Passed Challenge 8 (Database concurrency & channel retrieval)');
    } else {
      detectedBugs++;
      console.log(`⚠️ [FAIL] Database stress counts mismatch (initial: ${ch0Msgs.length}, postDel: ${postDelCh0.length})`);
    }
  }

  console.log('\n======================================================');
  console.log(`EMPIRICAL CHALLENGE SUITE COMPLETE: ${passedTests} Passed | ${detectedBugs} Critical/High/Medium Bugs Confirmed`);
  console.log('======================================================\n');
}

runMilestone1ChallengerTests().catch((e) => {
  console.error('Fatal error in challenger runner:', e);
  process.exitCode = 1;
});
