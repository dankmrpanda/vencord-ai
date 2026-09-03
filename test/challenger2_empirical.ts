/*
 * Vencord AI - Milestone 1 Challenger 2 Empirical Test Harness
 * Tests Tokenizer edge cases & BM25 InvertedIndex precision under adversarial conditions.
 */

import { extractQueryTokens, sanitizeDiscordText, tokenizeText, CONVERSATIONAL_STOPWORDS } from '../storage/index/tokenizer';
import { InvertedIndex, TopKHeap, binarySearchDocId } from '../storage/index/invertedIndex';
import { DiscordMessage } from '../types';
import { assert } from './assert';

function runTokenizerStressTests(): void {
  console.log('=== [1/2] TOKENIZER EMPIRICAL STRESS TESTS ===');

  // 1.1 Emojis & Surrogate Pairs
  console.log('Testing Emojis & Surrogate Pairs...');
  const textEmojis = '🚀 Rocket launch! 🔥 Hot bugfix! 🎉 Congrats! 👨‍👩‍👧‍👦 Family 👍🏽 Thumbs up';
  const tokensEmojis = tokenizeText(textEmojis);
  assert(tokensEmojis.terms.includes('rocket'), 'Should extract "rocket"');
  assert(tokensEmojis.terms.includes('launch'), 'Should extract "launch"');
  assert(tokensEmojis.terms.includes('hot'), 'Should extract "hot"');
  assert(tokensEmojis.terms.includes('bugfix'), 'Should extract "bugfix"');
  assert(tokensEmojis.terms.includes('congrats'), 'Should extract "congrats"');
  assert(tokensEmojis.terms.includes('family'), 'Should extract "family"');
  assert(tokensEmojis.terms.includes('thumbs'), 'Should extract "thumbs"');

  // Custom Discord Emojis
  const textCustomEmoji = 'Check this out <:pepe_dance:123456789012345678> and <a:hyper_cat:987654321098765432>';
  const sanitizedEmoji = sanitizeDiscordText(textCustomEmoji);
  assert(sanitizedEmoji.includes('pepe_dance'), 'Should preserve custom emoji name pepe_dance');
  assert(sanitizedEmoji.includes('hyper_cat'), 'Should preserve animated emoji name hyper_cat');
  const tokensCustomEmoji = tokenizeText(textCustomEmoji);
  assert(tokensCustomEmoji.terms.includes('pepe_dance'), 'Tokenized custom emoji should contain "pepe_dance"');
  assert(tokensCustomEmoji.terms.includes('hyper_cat'), 'Tokenized custom emoji should contain "hyper_cat"');

  // 1.2 Unicode & International Scripts
  console.log('Testing Unicode & International Scripts...');
  const textJapaneseSpace = '東京 ラーメン 新宿 ランチ Shinjuku Tokyo';
  const tokensJapanese = tokenizeText(textJapaneseSpace);
  assert(tokensJapanese.terms.includes('shinjuku'), 'Should extract English in multilingual text');
  assert(tokensJapanese.terms.includes('tokyo'), 'Should extract English in multilingual text');
  assert(tokensJapanese.totalTokens > 0, 'Should tokenize non-empty Japanese text');

  const textCyrillic = 'Привет мир! Быстрый поиск в базе данных postgres';
  const tokensCyrillic = tokenizeText(textCyrillic);
  assert(tokensCyrillic.terms.includes('postgres'), 'Should extract postgres');
  assert(tokensCyrillic.totalTokens >= 5, 'Should count Cyrillic word tokens');

  const textAccented = 'Café résumé naïve über façade';
  const tokensAccented = tokenizeText(textAccented);
  assert(tokensAccented.totalTokens >= 5, 'Accented latin tokens should be extracted');
  assert(tokensAccented.terms.some((t) => t.includes('caf')), 'Should contain cafe token');

  // 1.3 Punctuation Collisions & Hyphens
  console.log('Testing Punctuation Collisions & Hyphenation...');
  const textHyphens = 'cross-site scripting (XSS) in auth.service-v1.2.3; [CRITICAL-BUG_99] (3-5 mins)';
  const tokensHyphens = tokenizeText(textHyphens);
  assert(tokensHyphens.terms.includes('cross-site'), 'Should preserve hyphenated token "cross-site"');
  assert(tokensHyphens.terms.includes('xss'), 'Should strip enclosing parens to extract "xss"');
  assert(tokensHyphens.terms.includes('3-5'), 'Should preserve number range "3-5"');
  assert(tokensHyphens.terms.includes('critical-bug_99'), 'Should normalize bracketed token "critical-bug_99"');

  // Stripping leading/trailing dots and hyphens
  const edgePunct = '...leading and trailing--- -hyphen- .dot.';
  const tokensEdgePunct = tokenizeText(edgePunct);
  assert(tokensEdgePunct.terms.includes('leading'), 'Should strip leading dots');
  assert(tokensEdgePunct.terms.includes('trailing'), 'Should strip trailing hyphens');
  assert(tokensEdgePunct.terms.includes('hyphen'), 'Should strip surrounding hyphens');
  assert(tokensEdgePunct.terms.includes('dot'), 'Should strip surrounding dots');

  // 1.4 URLs & Discord Protocol Schemes
  console.log('Testing URL Sanitization & Tokenization...');
  const textUrls = 'Visit https://github.com/vencord/vencord/pull/1234?tab=files#diff-1 and http://192.168.1.1:8080/api/v1/health';
  const sanitizedUrls = sanitizeDiscordText(textUrls);
  assert(sanitizedUrls.includes('github.com'), 'Sanitized text should contain hostname github.com');
  assert(sanitizedUrls.includes('vencord'), 'Sanitized text should contain path token vencord');
  const tokensUrls = tokenizeText(textUrls);
  assert(tokensUrls.terms.includes('github'), 'Tokens should include host segment github');
  assert(tokensUrls.terms.includes('vencord'), 'Tokens should include vencord');
  assert(tokensUrls.terms.includes('pull'), 'Tokens should include path token pull');
  assert(tokensUrls.terms.includes('health'), 'Tokens should include path token health');

  // Malformed URL resilience
  const malformedUrlText = 'Broken http:// or https:/// or http://?foo=bar';
  const tokensMalformed = tokenizeText(malformedUrlText);
  assert(tokensMalformed.terms.includes('broken'), 'Should gracefully handle malformed URLs');

  // 1.5 Zero-Length Tokens, Whitespace, Unicode Whitespace
  console.log('Testing Zero-Length & Whitespace Variants...');
  assert(tokenizeText('').totalTokens === 0, 'Empty string has 0 tokens');
  assert(tokenizeText('   \r\n\t  ').totalTokens === 0, 'ASCII whitespace has 0 tokens');
  assert(tokenizeText('\u2000\u200B\u3000\u00A0\uFEFF').totalTokens === 0, 'Unicode whitespace has 0 tokens');
  assert(tokenizeText('!@#$%^&*()_+=~`{}[]|\\:;"\'<>,.?/').terms.length === 0 || tokenizeText('!@#$%^&*()_+=~`{}[]|\\:;"\'<>,.?/').terms.every(t => t.length >= 2), 'Pure punctuation returns clean tokens');

  // 1.6 Stopword Pruning vs Short Query Relaxation
  console.log('Testing Stopword Filtering & Query Token Extraction...');
  const stopwordDoc = 'The quick brown fox is in the house and we were there';
  const docTokens = tokenizeText(stopwordDoc, { removeStopwords: true });
  assert(!docTokens.terms.includes('the'), 'Stopword "the" should be pruned from document');
  assert(!docTokens.terms.includes('is'), 'Stopword "is" should be pruned from document');
  assert(!docTokens.terms.includes('and'), 'Stopword "and" should be pruned from document');
  assert(docTokens.terms.includes('quick'), 'Content term "quick" preserved');
  assert(docTokens.terms.includes('fox'), 'Content term "fox" preserved');

  // Short queries (1-2 words) should retain stopwords
  const shortQ1 = extractQueryTokens('who is');
  assert(shortQ1.includes('who') && shortQ1.includes('is'), 'Short 2-word query "who is" should retain stopwords');
  const shortQ2 = extractQueryTokens('the error');
  assert(shortQ2.includes('the') && shortQ2.includes('error'), 'Short 2-word query "the error" should retain stopwords');

  // Long queries (>2 words) should prune stopwords
  const longQ = extractQueryTokens('find the error in the server log');
  assert(!longQ.includes('the'), 'Long query should prune "the"');
  assert(!longQ.includes('in'), 'Long query should prune "in"');
  assert(longQ.includes('find') && longQ.includes('error') && longQ.includes('server') && longQ.includes('log'), 'Long query should keep content words');

  // 1.7 Extremely Long Tokens (>64 characters)
  console.log('Testing Max Token Length Limits...');
  const longToken = 'a'.repeat(70);
  const normalToken = 'b'.repeat(20);
  const mixedLong = `${longToken} ${normalToken}`;
  const resLong = tokenizeText(mixedLong, { maxTokenLen: 64 });
  assert(!resLong.terms.includes(longToken), '70-character token should exceed maxTokenLen 64 and be skipped');
  assert(resLong.terms.includes(normalToken), '20-character token should be accepted');

  console.log('✅ All Tokenizer Edge Cases Passed!');
}

function runBM25PrecisionStressTests(): void {
  console.log('\n=== [2/2] BM25 SCORING & INVERTED INDEX PRECISION TESTS ===');

  // 2.1 Theoretical IDF Oracle Verification
  console.log('Verifying BM25 IDF Mathematical Properties...');
  // Formula: idf = ln(1 + (N - n + 0.5) / (n + 0.5))
  const testCorpusSizes = [1, 2, 5, 10, 100, 1_000, 100_000];

  for (const N of testCorpusSizes) {
    let prevIdf = Infinity;
    for (let n = 1; n <= N; n = n < 20 ? n + 1 : Math.floor(n * 1.5) + 1) {
      const actualN = Math.min(n, N);
      const idf = Math.log(1 + (N - actualN + 0.5) / (actualN + 0.5));

      // Property 1: Non-negativity (IDF >= 0)
      assert(idf >= 0, `IDF must be non-negative (N=${N}, n=${actualN}, idf=${idf})`);
      assert(!isNaN(idf) && isFinite(idf), `IDF must be a valid finite number (N=${N}, n=${actualN})`);

      // Property 2: Strict Monotonicity with respect to document frequency n
      assert(idf <= prevIdf, `IDF must strictly decrease as document frequency increases (prev: ${prevIdf}, curr: ${idf})`);
      prevIdf = idf;
    }

    // Property 3: Boundary at n = N (all docs matching)
    const idfAll = Math.log(1 + (N - N + 0.5) / (N + 0.5));
    assert(idfAll > 0, `IDF when all docs match (n=N) must remain strictly positive (N=${N}, idf=${idfAll})`);

    // Property 4: Boundary at n = 1 (single doc matching)
    const idfSingle = Math.log(1 + (N - 1 + 0.5) / (1 + 0.5));
    if (N > 1) {
      assert(idfSingle > idfAll, `IDF for single match (n=1) must exceed all-match IDF (n=N)`);
    }
  }

  // 2.2 InvertedIndex Search with Empty Corpus (N = 0)
  console.log('Testing InvertedIndex with 0 documents...');
  const emptyIndex = new InvertedIndex();
  const emptyResult = emptyIndex.search({ query: 'database' });
  assert(emptyResult.hits.length === 0, 'Search on 0 docs must return 0 hits');
  assert(emptyResult.records.length === 0, 'Search on 0 docs must return 0 records');
  const emptyStats = emptyIndex.getStats();
  assert(emptyStats.totalDocs === 0 && emptyStats.totalTokens === 0, 'Stats on 0 docs must be 0');

  // 2.3 Single Document Corpus (N = 1)
  console.log('Testing InvertedIndex with Single Document (N = 1)...');
  const singleIndex = new InvertedIndex();
  const singleMsg: DiscordMessage = {
    id: 'msg_single_1',
    channel_id: 'ch_main',
    author: { id: 'u1', username: 'alice' },
    content: 'postgres database migration',
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };
  singleIndex.addBatch([singleMsg]);
  const singleSearchHit = singleIndex.search({ query: 'postgres' });
  assert(singleSearchHit.hits.length === 1, 'Search for existing term in single doc should return 1 hit');
  assert(singleSearchHit.hits[0].messageId === 'msg_single_1', 'Message ID should match');
  assert(singleSearchHit.hits[0].bm25Score > 0, 'BM25 score must be strictly positive');

  const singleSearchMiss = singleIndex.search({ query: 'nonexistent_term' });
  assert(singleSearchMiss.hits.length === 0, 'Search for missing term should return 0 hits');

  // 2.4 Document Length Normalization Empirical Verification
  console.log('Testing Document Length Normalization...');
  const lenIndex = new InvertedIndex();
  // Doc A: Concise (3 tokens) -> "postgres database migration"
  // Doc B: Medium (10 tokens) -> "postgres database migration along with several additional general conversational terms here"
  // Doc C: Long (40 tokens) -> "postgres database migration plus lots of extra words ..."
  const wordsExtra = 'extra informational context words discussing various topics without repeating keyword '.repeat(5);
  const msgConcise: DiscordMessage = {
    id: 'doc_concise',
    channel_id: 'ch_test',
    author: { id: 'u1', username: 'alice' },
    content: 'postgres database migration',
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgMedium: DiscordMessage = {
    id: 'doc_medium',
    channel_id: 'ch_test',
    author: { id: 'u2', username: 'bob' },
    content: 'postgres database migration with some extra conversational background filler information added',
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgLong: DiscordMessage = {
    id: 'doc_long',
    channel_id: 'ch_test',
    author: { id: 'u3', username: 'charlie' },
    content: `postgres database migration ${wordsExtra}`,
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  lenIndex.addBatch([msgConcise, msgMedium, msgLong]);

  // Query: "postgres database migration"
  // All 3 docs have exactly 1 occurrence of each of the 3 query words.
  // BM25 document length normalization (b=0.75) dictates: score(concise) > score(medium) > score(long)
  const lenResults = lenIndex.search({ query: 'postgres database migration', boostExact: 0 });
  assert(lenResults.hits.length === 3, 'All 3 docs should match');
  const scoreConcise = lenResults.hits.find((h) => h.messageId === 'doc_concise')!.bm25Score;
  const scoreMedium = lenResults.hits.find((h) => h.messageId === 'doc_medium')!.bm25Score;
  const scoreLong = lenResults.hits.find((h) => h.messageId === 'doc_long')!.bm25Score;

  assert(
    scoreConcise > scoreMedium && scoreMedium > scoreLong,
    `Doc length normalization failed: concise(${scoreConcise.toFixed(3)}) > medium(${scoreMedium.toFixed(3)}) > long(${scoreLong.toFixed(3)})`,
  );

  // 2.5 Term Frequency Saturation & Monotonicity
  console.log('Testing Term Frequency Saturation...');
  const tfIndex = new InvertedIndex();
  // Doc 1: tf = 1
  // Doc 2: tf = 3
  // Doc 3: tf = 10
  // Doc 4: tf = 50
  const msgTf1: DiscordMessage = {
    id: 'tf_1',
    channel_id: 'ch_tf',
    author: { id: 'u1', username: 'a' },
    content: 'redis '.repeat(1) + 'filler '.repeat(60),
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgTf3: DiscordMessage = {
    id: 'tf_3',
    channel_id: 'ch_tf',
    author: { id: 'u1', username: 'a' },
    content: 'redis '.repeat(3) + 'filler '.repeat(58),
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgTf10: DiscordMessage = {
    id: 'tf_10',
    channel_id: 'ch_tf',
    author: { id: 'u1', username: 'a' },
    content: 'redis '.repeat(10) + 'filler '.repeat(51),
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgTf50: DiscordMessage = {
    id: 'tf_50',
    channel_id: 'ch_tf',
    author: { id: 'u1', username: 'a' },
    content: 'redis '.repeat(50) + 'filler '.repeat(11),
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  tfIndex.addBatch([msgTf1, msgTf3, msgTf10, msgTf50]);

  const tfResults = tfIndex.search({ query: 'redis', boostExact: 0 });
  const sTf1 = tfResults.hits.find((h) => h.messageId === 'tf_1')!.bm25Score;
  const sTf3 = tfResults.hits.find((h) => h.messageId === 'tf_3')!.bm25Score;
  const sTf10 = tfResults.hits.find((h) => h.messageId === 'tf_10')!.bm25Score;
  const sTf50 = tfResults.hits.find((h) => h.messageId === 'tf_50')!.bm25Score;

  // Monotonic increase with TF
  assert(sTf1 < sTf3 && sTf3 < sTf10 && sTf10 < sTf50, `TF monotonicity failed: ${sTf1} < ${sTf3} < ${sTf10} < ${sTf50}`);
  // Asymptotic saturation: gain from 1->3 is greater than gain from 10->50 despite 40x jump
  const delta1to3 = (sTf3 - sTf1) / 2;
  const delta10to50 = (sTf50 - sTf10) / 40;
  assert(delta1to3 > delta10to50, `TF saturation property failed: marginal gain per TF unit must diminish`);

  // 2.6 Exact Substring Phrase Boosting
  console.log('Testing Exact Substring Phrase Bonus...');
  const phraseIndex = new InvertedIndex();
  // Doc Exact: "flight connection in denver" (exact phrase match)
  // Doc Scrambled: "denver connection was delayed for our flight" (same words, scrambled order)
  const msgExact: DiscordMessage = {
    id: 'msg_exact',
    channel_id: 'ch_travel',
    author: { id: 'u1', username: 'a' },
    content: 'My flight connection in Denver was only 5 minutes',
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msgScrambled: DiscordMessage = {
    id: 'msg_scrambled',
    channel_id: 'ch_travel',
    author: { id: 'u2', username: 'b' },
    content: 'Denver airport was crowded so the connection flight was very delayed',
    timestamp: '2026-03-01T12:00:00.000Z',
    attachments: [],
    embeds: [],
    mentions: [],
  };
  phraseIndex.addBatch([msgExact, msgScrambled]);

  const phraseRes = phraseIndex.search({ query: 'flight connection in denver', boostExact: 1.5 });
  assert(phraseRes.hits[0].messageId === 'msg_exact', 'Exact phrase match must rank #1');
  assert(phraseRes.hits[0].exactBonus > 0, 'Exact bonus must be applied to exact match');
  assert(phraseRes.hits[1].exactBonus === 0, 'Scrambled match must not receive exact bonus');

  // 2.7 Recency Decay Bonus
  console.log('Testing Recency Decay Bonus...');
  const recencyIndex = new InvertedIndex();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const msgToday: DiscordMessage = {
    id: 'msg_today',
    channel_id: 'ch_rec',
    author: { id: 'u1', username: 'a' },
    content: 'authentication server token secret',
    timestamp: new Date(now).toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msg30DaysAgo: DiscordMessage = {
    id: 'msg_30d',
    channel_id: 'ch_rec',
    author: { id: 'u1', username: 'a' },
    content: 'authentication server token secret',
    timestamp: new Date(now - 30 * dayMs).toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };
  const msg180DaysAgo: DiscordMessage = {
    id: 'msg_180d',
    channel_id: 'ch_rec',
    author: { id: 'u1', username: 'a' },
    content: 'authentication server token secret',
    timestamp: new Date(now - 180 * dayMs).toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };
  recencyIndex.addBatch([msgToday, msg30DaysAgo, msg180DaysAgo]);

  const recencyRes = recencyIndex.search({ query: 'authentication server token secret', boostExact: 0, boostRecency: 1.0 });
  const recToday = recencyRes.hits.find((h) => h.messageId === 'msg_today')!.recencyBonus;
  const rec30d = recencyRes.hits.find((h) => h.messageId === 'msg_30d')!.recencyBonus;
  const rec180d = recencyRes.hits.find((h) => h.messageId === 'msg_180d')!.recencyBonus;

  assert(recToday > rec30d && rec30d > rec180d, `Recency decay failed: today(${recToday}) > 30d(${rec30d}) > 180d(${rec180d})`);

  // Future timestamp clock skew test
  const msgFuture: DiscordMessage = {
    id: 'msg_future',
    channel_id: 'ch_rec',
    author: { id: 'u1', username: 'a' },
    content: 'future clock skew message',
    timestamp: new Date(now + 2 * dayMs).toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };
  recencyIndex.addBatch([msgFuture]);
  const futureRes = recencyIndex.search({ query: 'future clock skew message' });
  assert(!isNaN(futureRes.hits[0].recencyBonus) && isFinite(futureRes.hits[0].recencyBonus), 'Future timestamp must produce finite recency bonus');

  // 2.8 TopK Min-Heap Correctness under Random Stress
  console.log('Testing TopK Min-Heap Property with 1000 random items...');
  const heap = new TopKHeap(10);
  const items = Array.from({ length: 1000 }, (_, i) => ({
    docId: i,
    messageId: `msg_${i}`,
    score: Math.random() * 1000,
    bm25Score: 0,
    exactBonus: 0,
    recencyBonus: 0,
    matchedTokens: 0,
    totalQueryTokens: 0,
  }));

  for (const item of items) {
    heap.push(item);
  }

  const heapResults = heap.getSortedResults();
  assert(heapResults.length === 10, `Heap must maintain size K=10, got ${heapResults.length}`);
  const expectedTop10 = [...items].sort((a, b) => b.score - a.score).slice(0, 10);
  for (let k = 0; k < 10; k++) {
    assert(
      Math.abs(heapResults[k].score - expectedTop10[k].score) < 1e-9,
      `Heap top ${k} score mismatch: got ${heapResults[k].score}, expected ${expectedTop10[k].score}`,
    );
  }

  // 2.9 Snapshot Export & Import Consistency
  console.log('Testing Snapshot Export & Import Roundtrip...');
  const snapshot = recencyIndex.exportSnapshot();
  const restoredIndex = new InvertedIndex();
  restoredIndex.importSnapshot(snapshot);

  const origStats = recencyIndex.getStats();
  const restStats = restoredIndex.getStats();
  assert(origStats.totalDocs === restStats.totalDocs, 'Total docs must match after snapshot import');
  assert(origStats.totalTokens === restStats.totalTokens, 'Total tokens must match after snapshot import');
  assert(origStats.uniqueTerms === restStats.uniqueTerms, 'Unique terms count must match after snapshot import');

  const origHits = recencyIndex.search({ query: 'authentication server token secret' });
  const restHits = restoredIndex.search({ query: 'authentication server token secret' });
  assert(origHits.hits.length === restHits.hits.length, 'Hit count must match between original and restored index');
  for (let i = 0; i < origHits.hits.length; i++) {
    assert(origHits.hits[i].messageId === restHits.hits[i].messageId, `Hit ${i} message ID must match`);
    assert(Math.abs(origHits.hits[i].score - restHits.hits[i].score) < 1e-9, `Hit ${i} score must match`);
  }

  console.log('✅ All BM25 Scoring & Inverted Index Precision Tests Passed Successfully!');
}

runTokenizerStressTests();
runBM25PrecisionStressTests();
