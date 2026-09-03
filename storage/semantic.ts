/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { hasCJK, sanitizeDiscordText } from './index/tokenizer';

/**
 * Standard embedding vector dimension for in-client subword feature hashing.
 */
export const EMBEDDING_DIMENSION = 128;

/**
 * Dense vector representation using Float32Array for memory efficiency and fast dot products.
 */
export type DenseVector = Float32Array;

/**
 * In-client domain concept clusters for conceptual semantic expansion.
 * Maps domain terms and synonyms to canonical semantic concepts.
 */
const CONCEPT_SYNONYMS: Array<[string, string[]]> = [
  ['database', ['postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'db', 'schema', 'sql', 'query', 'table', 'datastore', 'tables']],
  ['migration', ['migrate', 'migrating', 'upgrade', 'update', 'schema', 'alter', 'mutation']],
  ['failure', ['error', 'fail', 'failed', 'failing', 'crash', 'exception', 'bug', 'contention', 'timeout', 'broken', 'issue', 'fault']],
  ['auth', ['login', 'authenticate', 'authentication', 'token', 'jwt', 'session', 'oauth', 'password', 'otp', '2fa', 'credential', 'passcode']],
  ['server', ['cluster', 'kubernetes', 'k8s', 'docker', 'container', 'host', 'node', 'instance', 'infra', 'cloud', 'aws', 'gcp']],
  ['network', ['ip', 'ipv4', 'ipv6', 'gateway', 'proxy', 'dns', 'tcp', 'udp', 'http', 'https', 'port', 'socket', 'connection', 'connect']],
  ['meeting', ['sync', 'call', 'huddle', 'lunch', 'bistro', 'restaurant', 'dinner', 'meet', 'calendar', 'schedule', 'appointment']],
  ['git', ['commit', 'branch', 'pr', 'pull', 'merge', 'repo', 'repository', 'github', 'diff', 'patch', 'sha', 'checkout']],
  ['deploy', ['deployment', 'deploying', 'release', 'ship', 'pipeline', 'cicd', 'build', 'staging', 'production', 'prod']],
  ['booking', ['flight', 'ticket', 'reservation', 'hotel', 'airline', 'denver', 'seat', 'trip', 'travel']],
  ['search', ['find', 'lookup', 'retrieval', 'query', 'filter', 'seek', 'scan']],
];

const WORD_TO_CONCEPTS = new Map<string, string[]>();
for (const [canonical, terms] of CONCEPT_SYNONYMS) {
  for (const term of [canonical, ...terms]) {
    const existing = WORD_TO_CONCEPTS.get(term) || [];
    if (!existing.includes(canonical)) {
      existing.push(canonical);
    }
    WORD_TO_CONCEPTS.set(term, existing);
  }
}

function isDamerauDistanceAtMostOne(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diffIdx1 = -1;
    let diffIdx2 = -1;
    let diffCount = 0;
    for (let k = 0; k < la; k++) {
      if (a[k] !== b[k]) {
        diffCount++;
        if (diffCount === 1) diffIdx1 = k;
        else if (diffCount === 2) diffIdx2 = k;
        else return false;
      }
    }
    if (diffCount === 0 || diffCount === 1) return true;
    if (diffCount === 2 && diffIdx2 === diffIdx1 + 1) {
      return a[diffIdx1] === b[diffIdx2] && a[diffIdx2] === b[diffIdx1];
    }
    return false;
  }

  const longer = la > lb ? a : b;
  const shorter = la > lb ? b : a;
  let i = 0;
  let j = 0;
  let diffs = 0;
  while (i < longer.length && j < shorter.length) {
    if (longer[i] !== shorter[j]) {
      diffs++;
      if (diffs > 1) return false;
      i++;
    } else {
      i++;
      j++;
    }
  }
  return true;
}

function findConceptsForWord(word: string): string[] {
  if (!word || word.length < 2) return [];

  // 1. Direct O(1) dictionary match
  const direct = WORD_TO_CONCEPTS.get(word);
  if (direct) return direct;

  if (word.length <= 3) return [];

  // 2. High-confidence morphological stem generation
  const candidateStems: string[] = [];

  if (word.endsWith('ies') && word.length > 4) {
    candidateStems.push(word.slice(0, -3) + 'y');
  } else if (word.endsWith('es') && word.length > 4) {
    candidateStems.push(word.slice(0, -1)); // e.g. databases -> database, nodes -> node
    candidateStems.push(word.slice(0, -2)); // e.g. crashes -> crash, branches -> branch
  } else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    candidateStems.push(word.slice(0, -1)); // e.g. servers -> server, tokens -> token
  }

  if (word.endsWith('ied') && word.length > 4) {
    candidateStems.push(word.slice(0, -3) + 'y');
  } else if (word.endsWith('ed') && word.length > 4) {
    candidateStems.push(word.slice(0, -2)); // e.g. crashed -> crash, failed -> fail
    candidateStems.push(word.slice(0, -1)); // e.g. migrated -> migrate, updated -> update
  }

  if (word.endsWith('ing') && word.length > 5) {
    candidateStems.push(word.slice(0, -3)); // e.g. failing -> fail, deploying -> deploy
    candidateStems.push(word.slice(0, -3) + 'e'); // e.g. migrating -> migrate, updating -> update
  }

  for (const stem of candidateStems) {
    const matched = WORD_TO_CONCEPTS.get(stem);
    if (matched && matched.length > 0) {
      return matched;
    }
  }

  // 3. High-confidence prefix & typo resilience for domain terms (term length >= 5, min prefix >= 5)
  if (word.length >= 5) {
    for (const [term, concepts] of WORD_TO_CONCEPTS) {
      if (term.length >= 5) {
        const prefixLen = Math.min(5, term.length);
        if (word.startsWith(term.slice(0, prefixLen)) && Math.abs(word.length - term.length) <= 3) {
          return concepts;
        }
        if (isDamerauDistanceAtMostOne(word, term)) {
          return concepts;
        }
      }
    }
  }

  return [];
}

/**
 * Fast 32-bit MurmurHash3-inspired string hash for deterministic subword projection.
 */
export function hashString32(str: string, seed = 0): number {
  let h = seed ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ c, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/**
 * Secondary hash function to generate independent sign bit (+1 or -1).
 */
export function hashStringSign(str: string, seed = 0x9747b28c): number {
  let h = seed ^ str.length;
  for (let i = str.length - 1; i >= 0; i--) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ c, 0xcc9e2d51);
    h ^= h >>> 13;
  }
  return (h & 1) === 1 ? 1.0 : -1.0;
}

/**
 * Extracts character n-grams and subwords from a word token.
 */
export function extractSubwords(
  word: string,
  minN = 2,
  maxN = 5,
): string[] {
  if (!word) return [];
  const subwords: string[] = [word]; // Include full word

  if (hasCJK(word)) {
    // CJK character unigrams and bigrams
    const chars = Array.from(word);
    for (let i = 0; i < chars.length; i++) {
      subwords.push(chars[i]);
      if (i < chars.length - 1) {
        subwords.push(chars[i] + chars[i + 1]);
      }
    }
    return subwords;
  }

  // Bound word length for n-gram generation
  if (word.length < minN) {
    subwords.push(`^${word}$`);
    return subwords;
  }

  const padded = `^${word}$`;
  const len = padded.length;

  for (let n = minN; n <= maxN && n <= len; n++) {
    for (let i = 0; i <= len - n; i++) {
      subwords.push(padded.slice(i, i + n));
    }
  }

  return subwords;
}

/**
 * Generates an L2-normalized dense feature hashing embedding vector for text.
 */
export function generateDenseEmbedding(
  text: string,
  dimension = EMBEDDING_DIMENSION,
): DenseVector {
  const vector = new Float32Array(dimension);
  if (!text || !text.trim()) return vector;

  const sanitized = sanitizeDiscordText(text).toLowerCase();
  const tokens = sanitized.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) return vector;

  const conceptsToAdd = new Set<string>();

  for (const token of tokens) {
    const subwords = extractSubwords(token);
    for (const sub of subwords) {
      const idx = (hashString32(sub) >>> 0) % dimension;
      const sign = hashStringSign(sub);
      const weight = Math.sqrt(Math.min(sub.length, 8)); // Length weighting
      vector[idx] += sign * weight;
    }

    const concepts = findConceptsForWord(token);
    for (const c of concepts) {
      conceptsToAdd.add(c);
    }
  }

  // Add projected semantic concept dimensions
  for (const concept of conceptsToAdd) {
    const conceptSubwords = extractSubwords(`concept_${concept}`);
    for (const sub of conceptSubwords) {
      const idx = (hashString32(sub) >>> 0) % dimension;
      const sign = hashStringSign(sub);
      vector[idx] += sign * 2.0;
    }
  }

  // Compute L2 norm
  let sumSq = 0;
  for (let i = 0; i < dimension; i++) {
    sumSq += vector[i] * vector[i];
  }

  if (sumSq > 1e-9) {
    const invNorm = 1.0 / Math.sqrt(sumSq);
    for (let i = 0; i < dimension; i++) {
      vector[i] *= invNorm;
    }
  }

  return vector;
}

/**
 * High-performance cosine similarity between two L2-normalized dense vectors.
 * Since vectors are unit length, cosine similarity is simply the inner dot product.
 */
export function computeCosineSimilarity(a: DenseVector, b: DenseVector): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;

  const len = a.length;
  let dot = 0;

  // Unrolled 4x loop for maximum V8 throughput
  const unrolled = len & ~3;
  let i = 0;
  for (; i < unrolled; i += 4) {
    dot += a[i] * b[i] +
           a[i + 1] * b[i + 1] +
           a[i + 2] * b[i + 2] +
           a[i + 3] * b[i + 3];
  }
  for (; i < len; i++) {
    dot += a[i] * b[i];
  }

  // Clamp to [0, 1] range
  if (dot <= 0) return 0;
  if (dot >= 1.0) return 1.0;
  return dot;
}

/**
 * Calculates semantic similarity score directly between query and target document text.
 */
export function calculateSemanticScore(query: string, documentText: string): number {
  if (!query || !documentText) return 0;
  const qVec = generateDenseEmbedding(query);
  const dVec = generateDenseEmbedding(documentText);
  return computeCosineSimilarity(qVec, dVec);
}

/**
 * Batch dense similarity scoring against a pre-computed query vector.
 */
export function batchScoreEmbeddings(
  queryVector: DenseVector,
  candidateVectors: DenseVector[],
): Float32Array {
  const count = candidateVectors.length;
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    scores[i] = computeCosineSimilarity(queryVector, candidateVectors[i]);
  }
  return scores;
}

/**
 * Optional external embedding adapter interface for companion models (Ollama, LMStudio, etc.)
 */
export interface ExternalEmbeddingProvider {
  name: string;
  dimension: number;
  embedText(text: string): Promise<DenseVector>;
  embedBatch(texts: string[]): Promise<DenseVector[]>;
}
