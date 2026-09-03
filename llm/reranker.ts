/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { extractQueryTokens } from '../storage/index/tokenizer';

/**
 * Standard candidate input for reranking across local index and remote search results.
 */
export interface RerankerCandidate {
  id: string;
  channelId: string;
  guildId?: string;
  authorId: string;
  authorName: string;
  timestamp: number; // Epoch milliseconds
  content: string;
  attachments?: Array<{ id: string; filename: string; url?: string; description?: string }>;
  embeds?: Array<{ title?: string; description?: string }>;
  replyParentId?: string;
  referencedMessage?: DiscordMessage | null;
  bm25Score?: number;
  bm25Rank?: number;
  semanticScore?: number;
  semanticRank?: number;
  regexMatches?: string[];
  regexRank?: number;
  rawMessage?: DiscordMessage;
}

/**
 * Configuration options for multi-feature cross-scoring and MMR.
 */
export interface RerankingOptions {
  query?: string;
  pattern?: string;
  now?: number;
  rrfK?: number; // Default: 60
  weightBM25?: number; // Default: 1.0
  weightSemantic?: number; // Default: 0.85
  weightRegex?: number; // Default: 1.25
  weightRecency?: number; // Default: 0.15
  weightContinuity?: number; // Default: 0.10
  boostExact?: number; // Default: 1.5
  recencyHalfLifeDays?: number; // Default: 30
  mmrLambda?: number; // Default: 0.7
  limit?: number; // Default: 25
  enableMMR?: boolean; // Default: true
}

/**
 * Scored and reranked message result with granular feature breakdown.
 */
export interface ScoredRerankedHit {
  candidate: RerankerCandidate;
  score: number;
  rrfScore: number;
  bm25Score: number;
  semanticScore: number;
  regexMatches: string[];
  exactBonus: number;
  recencyScore: number;
  continuityScore: number;
  mmrScore?: number;
}

/**
 * Grouped conversational context window containing an anchor hit and adjacent turns.
 */
export interface ExpandedConversationalWindow {
  anchorHit: ScoredRerankedHit;
  channelId: string;
  messages: RerankerCandidate[];
  replyChain: RerankerCandidate[];
  startTime: number;
  endTime: number;
  compositeScore: number;
}

/**
 * Computes the Jaccard similarity of two token sets for MMR diversity calculation.
 */
export function computeJaccardSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0;
  if (textA === textB) return 1.0;

  const tokensA = new Set(textA.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
  const tokensB = new Set(textB.toLowerCase().split(/\s+/).filter((t) => t.length > 0));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

/**
 * Multi-feature cross-scorer computing RRF and feature bonuses.
 */
export function scoreCandidate(
  candidate: RerankerCandidate,
  allCandidates: RerankerCandidate[],
  options: RerankingOptions = {},
): ScoredRerankedHit {
  const now = options.now ?? Date.now();
  const rrfK = options.rrfK ?? 60;
  const wBM25 = options.weightBM25 ?? 1.0;
  const wSemantic = options.weightSemantic ?? 0.85;
  const wRegex = options.weightRegex ?? 1.25;
  const wRecency = options.weightRecency ?? 0.15;
  const wContinuity = options.weightContinuity ?? 0.10;
  const boostExact = options.boostExact ?? 1.5;

  // 1. Reciprocal Rank Fusion
  let rrfScore = 0;
  if (candidate.bm25Rank && candidate.bm25Rank > 0) {
    rrfScore += wBM25 / (rrfK + candidate.bm25Rank);
  }
  if (candidate.semanticRank && candidate.semanticRank > 0) {
    const semScore = candidate.semanticScore ?? 0;
    rrfScore += (wSemantic * (1.0 + semScore)) / (rrfK + candidate.semanticRank);
  }
  if (candidate.regexRank && candidate.regexRank > 0) {
    rrfScore += (wRegex * 2.0) / (rrfK + candidate.regexRank);
  }

  // 2. Exact Phrase and Substring Match Bonus
  let exactBonus = 0;
  const contentLower = candidate.content.toLowerCase();
  const query = options.query?.trim().toLowerCase();

  if (query && query.length > 1) {
    if (contentLower.includes(query)) {
      exactBonus += 15.0 * boostExact;
    } else {
      const queryTokens = extractQueryTokens(query);
      if (queryTokens.length > 1) {
        let matched = 0;
        for (const token of queryTokens) {
          if (contentLower.includes(token.toLowerCase())) matched++;
        }
        exactBonus += (matched / queryTokens.length) * 8.0 * boostExact;
      }
    }
  }

  // 3. Exponential Recency Decay
  const ageDays = Math.max(0, (now - candidate.timestamp) / (1000 * 60 * 60 * 24));
  const halfLife = options.recencyHalfLifeDays ?? 30;
  const recencyScore = 2.0 * Math.exp(-ageDays / halfLife) * wRecency;

  // 4. Conversational Continuity Bonus
  let continuityScore = 0;
  if (candidate.replyParentId || candidate.referencedMessage) {
    continuityScore += 5.0 * wContinuity;
  }

  // Check temporal adjacency to other candidates in same channel (<5 min)
  const hasAdjacentCandidate = allCandidates.some(
    (c) =>
      c.id !== candidate.id &&
      c.channelId === candidate.channelId &&
      Math.abs(c.timestamp - candidate.timestamp) <= 5 * 60 * 1000,
  );
  if (hasAdjacentCandidate) {
    continuityScore += 5.0 * wContinuity;
  }

  const compositeScore = rrfScore * 100.0 + exactBonus + recencyScore + continuityScore;

  return {
    candidate,
    score: compositeScore,
    rrfScore,
    bm25Score: candidate.bm25Score ?? 0,
    semanticScore: candidate.semanticScore ?? 0,
    regexMatches: candidate.regexMatches ?? [],
    exactBonus,
    recencyScore,
    continuityScore,
  };
}

/**
 * Reranks candidates using multi-feature cross-scoring and MMR diversity filtering.
 */
export function rerankCandidates(
  candidates: RerankerCandidate[],
  options: RerankingOptions = {},
): ScoredRerankedHit[] {
  if (!candidates || candidates.length === 0) return [];

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  // 1. Initial Scoring
  const scoredHits = candidates.map((c) => scoreCandidate(c, candidates, options));
  scoredHits.sort((a, b) => b.score - a.score);

  const enableMMR = options.enableMMR ?? true;
  if (!enableMMR || scoredHits.length <= 1) {
    return scoredHits.slice(0, limit);
  }

  // 2. Maximal Marginal Relevance (MMR) Diversity Selection
  const lambda = options.mmrLambda ?? 0.7;
  const selected: ScoredRerankedHit[] = [];
  const remaining = [...scoredHits];

  const maxScore = scoredHits[0].score;
  const minScore = scoredHits[scoredHits.length - 1].score;
  const scoreRange = Math.max(maxScore - minScore, 1e-6);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidateHit = remaining[i];
      const normRel = (candidateHit.score - minScore) / scoreRange;

      let maxSim = 0;
      for (const sel of selected) {
        const sim = computeJaccardSimilarity(candidateHit.candidate.content, sel.candidate.content);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * normRel - (1 - lambda) * maxSim;
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const chosen = remaining.splice(bestIdx, 1)[0];
      chosen.mmrScore = bestMMR;
      selected.push(chosen);
    } else {
      break;
    }
  }

  return selected;
}

/**
 * Expands top-ranked hits into conversational context windows and reply chains.
 */
export function expandConversationalWindows(
  hits: ScoredRerankedHit[],
  allMessages: RerankerCandidate[],
  windowSize = 3,
  maxReplyDepth = 3,
): ExpandedConversationalWindow[] {
  const messageMap = new Map<string, RerankerCandidate>();
  for (const msg of allMessages) {
    messageMap.set(msg.id, msg);
  }

  const windows: ExpandedConversationalWindow[] = [];
  const processedMessageIds = new Set<string>();

  for (const hit of hits) {
    if (processedMessageIds.has(hit.candidate.id)) continue;

    const channelId = hit.candidate.channelId;
    const anchorTimestamp = hit.candidate.timestamp;
    const timeWindowMs = 5 * 60 * 1000; // 5 minutes

    // 1. Temporal Window: Adjacent messages in same channel
    const channelMessages = allMessages
      .filter((m) => m.channelId === channelId)
      .sort((a, b) => a.timestamp - b.timestamp);

    const anchorIndex = channelMessages.findIndex((m) => m.id === hit.candidate.id);
    let startIdx = Math.max(0, anchorIndex - windowSize);
    let endIdx = Math.min(channelMessages.length - 1, anchorIndex + windowSize);

    // Bound by time window
    while (startIdx < anchorIndex && anchorTimestamp - channelMessages[startIdx].timestamp > timeWindowMs) {
      startIdx++;
    }
    while (endIdx > anchorIndex && channelMessages[endIdx].timestamp - anchorTimestamp > timeWindowMs) {
      endIdx--;
    }

    const windowMessages = channelMessages.slice(startIdx, endIdx + 1);

    // 2. Reply Chain Traversal (Bounded Depth & Cycle Prevention)
    const replyChain: RerankerCandidate[] = [];
    const visitedReplies = new Set<string>([hit.candidate.id]);
    let currentReplyId = hit.candidate.replyParentId;
    let depth = 0;

    while (currentReplyId && depth < maxReplyDepth) {
      if (visitedReplies.has(currentReplyId)) break; // Cycle detected
      visitedReplies.add(currentReplyId);

      const parentMsg = messageMap.get(currentReplyId);
      if (!parentMsg) break;

      replyChain.unshift(parentMsg); // Root at start
      currentReplyId = parentMsg.replyParentId;
      depth++;
    }

    // Mark messages as processed
    for (const m of windowMessages) processedMessageIds.add(m.id);
    for (const m of replyChain) processedMessageIds.add(m.id);

    windows.push({
      anchorHit: hit,
      channelId,
      messages: windowMessages,
      replyChain,
      startTime: windowMessages[0]?.timestamp ?? anchorTimestamp,
      endTime: windowMessages[windowMessages.length - 1]?.timestamp ?? anchorTimestamp,
      compositeScore: hit.score,
    });
  }

  return windows;
}
