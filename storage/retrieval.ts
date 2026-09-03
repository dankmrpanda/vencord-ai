/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CurrentScopeContext } from '../types';
import { isChannelAllowedInScope } from '../discord/scope';
import { extractQueryTokens } from './index/tokenizer';
import { IndexSearchQuery, ScoredIndexHit, StoredMessageRecord } from './index/types';
import { indexBridge, WorkerBridge } from './index/workerBridge';
import { computeCosineSimilarity, DenseVector, generateDenseEmbedding } from './semantic';
import { extractMatchesFromText, isRegexSafe } from './regex';

/**
 * Comprehensive Hybrid Search Query parameters.
 */
export interface HybridSearchQuery {
  query?: string;
  pattern?: string;
  semanticQuery?: string;
  channelIds?: string[];
  guildId?: string;
  authorId?: string;
  date?: string;
  minTimestamp?: number;
  maxTimestamp?: number;
  flagsRequired?: number;
  flagsExcluded?: number;
  limit?: number; // Default: 25
  minScore?: number; // Default: 0.01
  rrfK?: number; // Default: 60
  weightBM25?: number; // Default: 1.0
  weightSemantic?: number; // Default: 0.85
  weightRegex?: number; // Default: 1.25
  boostExact?: number; // Default: 1.5
  boostRecency?: number; // Default: 0.15
  groupEpisodes?: boolean; // Default: false
}

/**
 * Scored Hybrid Result Hit.
 */
export interface ScoredHybridHit {
  docId: number;
  messageId: string;
  record: StoredMessageRecord;
  score: number;
  bm25Score: number;
  bm25Rank?: number;
  semanticScore: number;
  semanticRank?: number;
  regexMatches?: string[];
  regexRank?: number;
  exactBonus: number;
  recencyBonus: number;
  matchedTokens: number;
  totalQueryTokens: number;
}

/**
 * Grouped conversational burst / episode.
 */
export interface ConversationalEpisode {
  channelId: string;
  startTime: number;
  endTime: number;
  primaryHit: ScoredHybridHit;
  messages: StoredMessageRecord[];
  compositeScore: number;
}

/**
 * Unified search response.
 */
export interface HybridSearchResponse {
  hits: ScoredHybridHit[];
  episodes?: ConversationalEpisode[];
  totalCandidates: number;
  durationMs: number;
  querySummary: {
    lexicalTokens: string[];
    hasSemantic: boolean;
    hasPattern: boolean;
    channelFiltersApplied: number;
  };
}

/**
 * Unified Hybrid Retrieval Engine.
 */
export class HybridRetrievalEngine {
  constructor(private bridge: WorkerBridge = indexBridge) {}

  /**
   * Executes unified hybrid search combining BM25, semantic similarity, and regex matching.
   */
  public async search(
    query: HybridSearchQuery,
    scope?: CurrentScopeContext,
  ): Promise<HybridSearchResponse> {
    const startTime = Date.now();
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const rrfK = query.rrfK ?? 60;
    const wBM25 = query.weightBM25 ?? 1.0;
    const wSemantic = query.weightSemantic ?? 0.85;
    const wRegex = query.weightRegex ?? 1.25;

    // 1. Resolve Permitted Scope Channels
    let allowedChannels = query.channelIds;
    if (scope) {
      if (scope.isGuild && scope.accessibleGuildChannels) {
        const permitted = new Set(scope.accessibleGuildChannels.map((c) => c.id));
        if (allowedChannels) {
          allowedChannels = allowedChannels.filter((id) => permitted.has(id));
        } else {
          allowedChannels = Array.from(permitted);
        }
      } else if (!scope.isGuild) {
        // DM Scope isolation
        const activeDm = scope.channelId;
        const mutualDms = scope.explicitMutualGroupDMIds?.length
          ? scope.explicitMutualGroupDMIds
          : (scope.mutualGroupDMs || []).map((g) => g.id);
        const permittedDms = new Set([activeDm, ...mutualDms]);
        if (allowedChannels) {
          allowedChannels = allowedChannels.filter((id) => permittedDms.has(id));
        } else {
          allowedChannels = Array.from(permittedDms);
        }
      }
    }

    // 2. Execute BM25 Index Search via Worker Bridge
    const indexQuery: IndexSearchQuery = {
      query: query.query || query.semanticQuery,
      channelIds: allowedChannels,
      guildId: query.guildId,
      authorId: query.authorId,
      minTimestamp: query.minTimestamp,
      maxTimestamp: query.maxTimestamp,
      flagsRequired: query.flagsRequired,
      flagsExcluded: query.flagsExcluded,
      limit: Math.max(limit * 4, 100), // Over-fetch candidates for RRF fusion
      minScore: 0.0001,
      boostExact: query.boostExact,
      boostRecency: query.boostRecency,
    };

    let bm25Result: { hits: ScoredIndexHit[]; records: StoredMessageRecord[] } = { hits: [], records: [] };
    try {
      const res = await this.bridge.search(indexQuery);
      if (res) {
        bm25Result = {
          hits: res.hits || [],
          records: res.records || [],
        };
      }
    } catch {
      bm25Result = { hits: [], records: [] };
    }

    let candidateRecords = bm25Result.records || [];
    const bm25Hits = bm25Result.hits || [];

    // Fallback if BM25 found 0 candidates (e.g. pattern-only query or disjoint semantic query)
    if (candidateRecords.length === 0 && (query.pattern || query.semanticQuery || !query.query)) {
      if (typeof this.bridge.createSnapshot === 'function') {
        try {
          const snapObj: any = await this.bridge.createSnapshot();
          const docs: StoredMessageRecord[] | undefined = snapObj?.snapshot?.documents ?? snapObj?.documents;
          if (docs) {
            candidateRecords = [...docs];
            if (allowedChannels && allowedChannels.length > 0) {
              const allowedSet = new Set(allowedChannels);
              candidateRecords = candidateRecords.filter((r) => allowedSet.has(r.channelId));
            }
            if (query.guildId) {
              candidateRecords = candidateRecords.filter((r) => r.guildId === query.guildId);
            }
            if (query.authorId) {
              candidateRecords = candidateRecords.filter((r) => r.authorId === query.authorId);
            }
            if (query.minTimestamp) {
              candidateRecords = candidateRecords.filter((r) => r.timestamp >= query.minTimestamp!);
            }
            if (query.maxTimestamp) {
              candidateRecords = candidateRecords.filter((r) => r.timestamp <= query.maxTimestamp!);
            }
            if (query.flagsRequired) {
              candidateRecords = candidateRecords.filter((r) => (r.flags & query.flagsRequired!) === query.flagsRequired);
            }
            if (query.flagsExcluded) {
              candidateRecords = candidateRecords.filter((r) => (r.flags & query.flagsExcluded!) === 0);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // 3. Modality A: BM25 Ranks Map
    const bm25RankMap = new Map<string, { rank: number; score: number; rawHit: ScoredIndexHit }>();
    bm25Hits.forEach((hit, idx) => {
      bm25RankMap.set(hit.messageId, { rank: idx + 1, score: hit.score, rawHit: hit });
    });

    // 4. Modality B: Semantic Dense Scoring
    const semanticRankMap = new Map<string, { rank: number; score: number }>();
    const semanticText = query.semanticQuery || query.query;
    let queryVector: DenseVector | null = null;

    if (semanticText && semanticText.trim()) {
      queryVector = generateDenseEmbedding(semanticText);
      const scoredCandidates: Array<{ id: string; score: number }> = [];

      for (const rec of candidateRecords) {
        const docVector = generateDenseEmbedding(rec.content);
        const sim = computeCosineSimilarity(queryVector, docVector);
        scoredCandidates.push({ id: rec.id, score: sim });
      }

      scoredCandidates.sort((a, b) => b.score - a.score);
      scoredCandidates.forEach((item, idx) => {
        semanticRankMap.set(item.id, { rank: idx + 1, score: item.score });
      });
    }

    // 5. Modality C: Regex / Structured Pattern Matching
    const regexRankMap = new Map<string, { rank: number; matches: string[] }>();
    if (query.pattern && isRegexSafe(query.pattern)) {
      const patternMatches: Array<{ id: string; matches: string[] }> = [];

      for (const rec of candidateRecords) {
        const fullText = `${rec.content} ${rec.attachmentNames?.join(' ') || ''}`;
        const matches = extractMatchesFromText(fullText, query.pattern);
        if (matches.length > 0) {
          patternMatches.push({ id: rec.id, matches });
        }
      }

      // Sort by match count descending
      patternMatches.sort((a, b) => b.matches.length - a.matches.length);
      patternMatches.forEach((item, idx) => {
        regexRankMap.set(item.id, { rank: idx + 1, matches: item.matches });
      });
    }

    // 6. Reciprocal Rank Fusion & Composite Score Computation
    const hybridHits: ScoredHybridHit[] = [];
    const queryLower = query.query?.toLowerCase();
    const queryTokens = query.query ? extractQueryTokens(query.query) : [];

    for (const record of candidateRecords) {
      // Fail-closed scope check
      if (scope && !isChannelAllowedInScope(record.channelId, scope)) {
        continue;
      }

      const bm25Entry = bm25RankMap.get(record.id);
      const semanticEntry = semanticRankMap.get(record.id);
      const regexEntry = regexRankMap.get(record.id);

      let rrfScore = 0;

      if (bm25Entry) {
        rrfScore += wBM25 / (rrfK + bm25Entry.rank);
      }
      if (semanticEntry && semanticEntry.score > 0.05) {
        rrfScore += (wSemantic * (1.0 + semanticEntry.score)) / (rrfK + semanticEntry.rank);
      }
      if (regexEntry) {
        rrfScore += (wRegex * 2.0) / (rrfK + regexEntry.rank);
      }

      // Exact substring boost
      let exactBonus = 0;
      if (queryLower && record.content.toLowerCase().includes(queryLower)) {
        exactBonus = 15.0 * (query.boostExact ?? 1.5);
      }

      // Recency decay bonus
      const ageDays = (Date.now() - record.timestamp) / (1000 * 60 * 60 * 24);
      const recencyBonus = 2.0 * Math.exp(-Math.max(0, ageDays) / 30.0) * (query.boostRecency ?? 0.15);

      const totalScore = rrfScore * 100.0 + exactBonus + recencyBonus;

      if (totalScore >= (query.minScore ?? 0.001)) {
        hybridHits.push({
          docId: record.docId,
          messageId: record.id,
          record,
          score: totalScore,
          bm25Score: bm25Entry?.rawHit.bm25Score ?? 0,
          bm25Rank: bm25Entry?.rank,
          semanticScore: semanticEntry?.score ?? 0,
          semanticRank: semanticEntry?.rank,
          regexMatches: regexEntry?.matches,
          regexRank: regexEntry?.rank,
          exactBonus,
          recencyBonus,
          matchedTokens: bm25Entry?.rawHit.matchedTokens ?? 0,
          totalQueryTokens: queryTokens.length,
        });
      }
    }

    // Sort descending by composite hybrid score
    hybridHits.sort((a, b) => b.score - a.score);
    const topHits = hybridHits.slice(0, limit);

    // 7. Optional Conversational Episode Grouping
    let episodes: ConversationalEpisode[] | undefined;
    if (query.groupEpisodes && topHits.length > 0) {
      let corpusRecords = candidateRecords;
      if (typeof this.bridge.createSnapshot === 'function') {
        try {
          const snapObj: any = await this.bridge.createSnapshot();
          const docs: StoredMessageRecord[] | undefined = snapObj?.snapshot?.documents ?? snapObj?.documents;
          if (docs) {
            corpusRecords = docs;
          }
        } catch {
          // fallback
        }
      }
      episodes = this.groupConversationalEpisodes(topHits, corpusRecords);
    }

    const durationMs = Date.now() - startTime;

    return {
      hits: topHits,
      episodes,
      totalCandidates: candidateRecords.length,
      durationMs,
      querySummary: {
        lexicalTokens: queryTokens,
        hasSemantic: Boolean(queryVector),
        hasPattern: Boolean(query.pattern),
        channelFiltersApplied: allowedChannels?.length ?? 0,
      },
    };
  }

  /**
   * Groups adjacent messages in the same channel into conversational bursts (<5 min gap).
   */
  private groupConversationalEpisodes(
    hits: ScoredHybridHit[],
    allRecords: StoredMessageRecord[],
  ): ConversationalEpisode[] {
    const episodes: ConversationalEpisode[] = [];
    const timeWindow = 5 * 60 * 1000; // 5 minutes

    for (const hit of hits) {
      const primaryRec = hit.record;
      const channelId = primaryRec.channelId;

      // Find adjacent records in same channel within time window
      const adjacent = allRecords
        .filter(
          (r) =>
            r.channelId === channelId &&
            Math.abs(r.timestamp - primaryRec.timestamp) <= timeWindow,
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      episodes.push({
        channelId,
        startTime: adjacent[0]?.timestamp ?? primaryRec.timestamp,
        endTime: adjacent[adjacent.length - 1]?.timestamp ?? primaryRec.timestamp,
        primaryHit: hit,
        messages: adjacent,
        compositeScore: hit.score,
      });
    }

    return episodes;
  }
}

export const retrievalEngine = new HybridRetrievalEngine();
