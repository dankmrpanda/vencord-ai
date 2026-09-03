/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { assert } from './assert';
import {
  compileSafeRegex,
  extractAllStructuredEntities,
  extractMatchesFromText,
  isRegexSafe,
  STRUCTURED_PATTERNS,
} from '../storage/regex';
import {
  calculateSemanticScore,
  computeCosineSimilarity,
  extractSubwords,
  generateDenseEmbedding,
  hashString32,
  hashStringSign,
} from '../storage/semantic';

function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runMilestone2ChallengerTests(): Promise<void> {
  console.log('\n======================================================');
  console.log('🔥 RUNNING MILESTONE 2 EMPIRICAL CHALLENGER SUITE 🔥');
  console.log('======================================================\n');

  // -------------------------------------------------------------------------
  // Challenge 1: ReDoS Static Filter Bypasses
  // -------------------------------------------------------------------------
  console.log('--- Challenge 1: ReDoS Static Filter Bypasses ---');
  const knownVulnerablePatterns = [
    { pattern: '((a)+)+$', name: 'Nested grouping with outer quantifier' },
    { pattern: '((a+))+', name: 'Nested grouping with double quantifier' },
    { pattern: '(a?)+$', name: 'Quantified optional group' },
    { pattern: '([a-z]?)+$', name: 'Quantified optional character class' },
    { pattern: '(a|aa)+$', name: 'Overlapping alternation with suffix' },
    { pattern: '(aa|a)+$', name: 'Overlapping alternation with prefix' },
    { pattern: '(a|ab)+$', name: 'Overlapping alternation with distinct character' },
    { pattern: '(a|b|ab)+$', name: 'Multi-branch overlapping alternation' },
    { pattern: '(0|1|01)+$', name: 'Numeric overlapping alternation' },
    { pattern: '(a|a?)+$', name: 'Alternation with optional member' },
    { pattern: '(a|b|c|d|a)+$', name: 'Non-adjacent duplicate alternation' },
  ];

  let bypassCount = 0;
  for (const { pattern, name } of knownVulnerablePatterns) {
    const isSafe = isRegexSafe(pattern);
    if (isSafe) {
      bypassCount++;
      console.log(`  ⚠️  BYPASS: Pattern "${pattern}" (${name}) is marked SAFE by isRegexSafe`);
    }
  }
  console.log(`  Result: ${bypassCount}/${knownVulnerablePatterns.length} pathological ReDoS patterns bypassed isRegexSafe.\n`);
  assert(bypassCount === 0, 'No pathological ReDoS patterns must bypass isRegexSafe');

  // Verify safe patterns continue to pass
  for (const [key, pat] of Object.entries(STRUCTURED_PATTERNS)) {
    assert(isRegexSafe(pat.source), `Structured pattern ${key} must be marked safe`);
  }
  assert(isRegexSafe('\\b[A-Z0-9]{6}\\b'), 'Standard alphanumeric pattern must be marked safe');
  assert(isRegexSafe('database migration'), 'Plain text pattern must be marked safe');
  console.log('  ✅ Passed Challenge 1 (All ReDoS patterns rejected, safe patterns accepted)\n');

  // -------------------------------------------------------------------------
  // Challenge 2: Synchronous Execution Stall & Time Limit Ineffectiveness
  // -------------------------------------------------------------------------
  console.log('--- Challenge 2: Synchronous Execution Stall on Catastrophic Backtracking ---');
  const attackInput = 'a'.repeat(24) + '!';
  const t0 = Date.now();
  const matches = extractMatchesFromText(attackInput, '(a|aa)+$', 10, 5);
  const elapsed = Date.now() - t0;
  console.log(`  Execution of (a|aa)+$ on length 25 took: ${elapsed}ms (requested time limit: 5ms)`);
  assert(matches.length === 0, 'Unsafe pattern extraction must return empty array without stalling');
  console.log('  ✅ Passed Challenge 2 (Safe execution on unsafe pattern input)\n');

  // -------------------------------------------------------------------------
  // Challenge 3: Semantic Vector Collision Rates on Random Noise
  // -------------------------------------------------------------------------
  console.log('--- Challenge 3: Semantic Vector Orthogonality & Collision Rates ---');
  const rng = createSeededRng(42);
  const chars = 'abcdefghijklmnopqrstuvwxyz ';
  const randomCorpus: string[] = [];
  for (let i = 0; i < 200; i++) {
    let s = '';
    const len = 20 + Math.floor(rng() * 40);
    for (let j = 0; j < len; j++) s += chars[Math.floor(rng() * chars.length)];
    randomCorpus.push(s);
  }

  const vectors = randomCorpus.map((t) => generateDenseEmbedding(t));
  let maxCollision = 0;
  let highCollisions = 0;
  let comparisons = 0;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = computeCosineSimilarity(vectors[i], vectors[j]);
      if (sim > maxCollision) maxCollision = sim;
      if (sim > 0.5) highCollisions++;
      comparisons++;
    }
  }

  console.log(`  Evaluated ${comparisons} random string pairs.`);
  console.log(`  Max Cosine Similarity: ${maxCollision.toFixed(4)} (Threshold for concern: > 0.50)`);
  console.log(`  Collisions > 0.50: ${highCollisions}`);
  assert(highCollisions === 0, 'Random noise should not produce semantic similarity > 0.50');
  console.log('  ✅ Passed Challenge 3 (Random feature hashing preserves orthogonality)\n');

  // -------------------------------------------------------------------------
  // Challenge 4: Semantic Concept False Positive Prefix Over-Expansion
  // -------------------------------------------------------------------------
  console.log('--- Challenge 4: Semantic Concept Prefix Over-Expansion ---');
  const falsePositivePairs = [
    {
      textA: 'enjoying seafood during summer season',
      textB: 'flight seat reservation hotel',
      reason: 'seafood/season matching "sea" -> concept "booking"',
    },
    {
      textA: 'The author wrote an automatic script in the autumn',
      textB: 'Please enter your 2FA authentication password',
      reason: 'author/auto/autumn matching "aut" -> concept "auth"',
    },
    {
      textA: 'I went to the dentist for dental care wearing denim',
      textB: 'Flight airline reservation hotel booking',
      reason: 'dentist/dental/denim matching "den" -> concept "booking"',
    },
    {
      textA: 'syntax error in python script',
      textB: 'calendar sync meeting appointment call',
      reason: 'syntax matching "syn" -> concept "meeting"',
    },
  ];

  for (const pair of falsePositivePairs) {
    const score = calculateSemanticScore(pair.textA, pair.textB);
    console.log(`  Score: ${score.toFixed(4)} | "${pair.textA}" vs "${pair.textB}"`);
    console.log(`    Trigger: ${pair.reason}`);
    assert(score < 0.35, `Unrelated text score should be low (<0.35), got ${score.toFixed(4)}`);
  }
  console.log('  ✅ Passed Challenge 4 (Semantic concept prefix over-expansion resolved)\n');

  // -------------------------------------------------------------------------
  // Challenge 5: Large Token / Memory Safety in Subword Generation
  // -------------------------------------------------------------------------
  console.log('--- Challenge 5: Large Token & Extreme String Stability ---');
  const hugeInput = 'x'.repeat(100_000);
  const tHugeStart = Date.now();
  const hugeVec = generateDenseEmbedding(hugeInput);
  const hugeElapsed = Date.now() - tHugeStart;
  console.log(`  Embedding generation for 100,000 char continuous token took: ${hugeElapsed}ms`);
  assert(!hugeVec.some((v) => Number.isNaN(v)), 'Vector must not contain NaNs');
  assert(hugeElapsed < 200, 'Embedding 100k chars must complete in < 200ms');
  console.log('  ✅ Passed Challenge 5 (Memory and numerical stability intact)\n');

  console.log('======================================================');
  console.log('EMPIRICAL CHALLENGER SUITE COMPLETE');
  console.log('======================================================\n');
}

// Self-run when executed directly
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('challenger_m2.test.ts')) {
  runMilestone2ChallengerTests().catch((err) => {
    console.error('Challenger Suite Failure:', err);
    process.exit(1);
  });
}
