/*
 * Empirical Demonstration of Deletion Invariant & Unicode Edge Cases
 */

import { InvertedIndex } from '../storage/index/invertedIndex';
import { tokenizeText, extractQueryTokens } from '../storage/index/tokenizer';
import { DiscordMessage } from '../types';
import { assert } from './assert';

console.log('=== RUNNING ADVERSARIAL EDGE CASE HARNESS ===');

// Issue 1: Deletion IDF Desynchronization
console.log('Testing Deletion IDF Desynchronization...');
const index = new InvertedIndex();
const msgs: DiscordMessage[] = Array.from({ length: 20 }, (_, i) => ({
  id: `msg_del_${i}`,
  channel_id: 'ch_main',
  author: { id: 'u1', username: 'alice' },
  content: 'kubernetes deployment canary cluster',
  timestamp: new Date().toISOString(),
  attachments: [],
  embeds: [],
  mentions: [],
}));

index.addBatch(msgs);
const beforeDelHits = index.search({ query: 'kubernetes', boostExact: 0, boostRecency: 0 }).hits;
console.log(`Before deletion: 20 docs indexed, search for "kubernetes" returned ${beforeDelHits.length} hits, score = ${beforeDelHits[0]?.bm25Score.toFixed(3)}`);

// Delete 18 messages, leaving 2 messages with "kubernetes"
const deleted = index.deleteMessages(Array.from({ length: 18 }, (_, i) => `msg_del_${i}`));
console.log(`Deleted ${deleted} messages. Total surviving docs in index: ${index.getStats().totalDocs}`);

// Search again for "kubernetes"
const afterDelHits = index.search({ query: 'kubernetes', boostExact: 0, boostRecency: 0 }).hits;
console.log(`After deletion: search for "kubernetes" returned ${afterDelHits.length} hits (expected: 2 surviving docs)`);
assert(afterDelHits.length === 2, `Expected 2 surviving docs after deletion, got ${afterDelHits.length}`);
assert(afterDelHits[0].bm25Score > 0, 'BM25 score must be strictly positive');

// Issue 2: Smart Quotes & Unicode Punctuation
console.log('\nTesting Smart Quotes & Unicode Punctuation Collisions...');
const textSmartQuotes = '“Zero-Day” vulnerability in server';
const tokensSmart = tokenizeText(textSmartQuotes);
console.log('Indexed tokens for “Zero-Day”:', tokensSmart.terms);
const searchTokensASCII = extractQueryTokens('"Zero-Day"');
console.log('Search tokens for ASCII "Zero-Day":', searchTokensASCII);
assert(tokensSmart.terms.includes('zero-day'), 'Smart quote tokenized terms must include "zero-day"');
assert(searchTokensASCII.includes('zero-day'), 'ASCII search query tokens must include "zero-day"');

console.log('\nTesting Japanese Full Stop (。)...');
const textCJK = '東京のラーメン。Shinjuku';
const tokensCJK = tokenizeText(textCJK);
console.log('Tokens for "東京のラーメン。Shinjuku":', tokensCJK.terms);
assert(tokensCJK.terms.includes('shinjuku'), 'CJK full stop must separate "shinjuku" from Japanese text');
assert(tokensCJK.terms.includes('ラーメン'), 'Japanese text must include "ラーメン"');

console.log('=== EDGE CASE HARNESS COMPLETE ===');
