/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../../types';

/**
 * 32-bit internal document identifier (0 <= docId < 2^32 - 1).
 */
export type DocId = number;

/**
 * Compact bitmask flags for message attributes to minimize memory footprint.
 */
export const MESSAGE_FLAGS = {
  HAS_ATTACHMENTS: 1 << 0, // 1
  HAS_EMBEDS:      1 << 1, // 2
  HAS_LINKS:       1 << 2, // 4
  IS_PINNED:       1 << 3, // 8
  HAS_MENTIONS:    1 << 4, // 16
  HAS_REPLY:       1 << 5, // 32
} as const;

export type MessageFlag = typeof MESSAGE_FLAGS[keyof typeof MESSAGE_FLAGS];

/**
 * Memory-efficient stored message record retained in the index.
 */
export interface StoredMessageRecord {
  docId: DocId;
  id: string; // Discord Snowflake ID
  channelId: string; // Channel Snowflake ID
  guildId?: string; // Guild Snowflake ID (if in server)
  authorId: string; // Author User ID
  authorName: string; // Cached display/user name
  timestamp: number; // Epoch milliseconds (uint48)
  content: string; // Raw / sanitized text content
  tokenLength: number; // Document token count (|D| for BM25)
  flags: number; // Bitmask combining MESSAGE_FLAGS
  replyParentId?: string; // Referenced reply message ID
  attachmentNames?: string[]; // Cached attachment filenames for search
}

/**
 * In-memory posting list for a single normalized vocabulary term.
 */
export interface PostingList {
  term: string;
  df: number; // Document frequency n(t)
  docIds: Uint32Array; // Strictly ascending sorted DocIDs
  termFreqs: Uint8Array; // Term frequencies f(t, D) (clamped at 255)
}

/**
 * Dynamic mutable posting list used during batch ingestion before freezing into typed arrays.
 */
export interface MutablePostingList {
  term: string;
  docIds: number[];
  termFreqs: number[];
}

/**
 * Serialized posting list suitable for ArrayBuffer transfer or IndexedDB persistence.
 */
export interface SerializedPostingList {
  term: string;
  df: number;
  docIdsBuffer: ArrayBuffer;
  termFreqsBuffer: ArrayBuffer;
}

/**
 * BM25 configuration parameters.
 */
export interface BM25Config {
  k1: number; // Term frequency saturation (default: 1.2)
  b: number;  // Document length penalty (default: 0.75)
}

/**
 * Global index statistics required for BM25 scoring and monitoring.
 */
export interface IndexStats {
  totalDocs: number; // N
  totalTokens: number; // Sum of |D| across all docs
  avgdl: number; // totalTokens / max(1, totalDocs)
  uniqueTerms: number; // |Vocabulary|
  memoryUsageBytes: number; // Estimated memory usage
  lastUpdated: number; // Epoch ms of last mutation
}

/**
 * Query filter criteria for multi-modal index search.
 */
export interface IndexSearchQuery {
  query?: string;
  pattern?: string;
  tokens?: string[];
  channelIds?: string[];
  guildId?: string;
  authorId?: string;
  minTimestamp?: number;
  maxTimestamp?: number;
  flagsRequired?: number; // Must match all bits
  flagsExcluded?: number; // Must match none of bits
  limit?: number; // Default: 25, max: 100
  minScore?: number; // Default: 0.01
  boostExact?: number; // Default: 1.5
  boostRecency?: number; // Default: 0.15
}

/**
 * Scored search result returned by the index engine.
 */
export interface ScoredIndexHit {
  docId: DocId;
  messageId: string;
  score: number; // Composite hybrid score
  bm25Score: number; // Raw BM25 score
  exactBonus: number; // Exact substring bonus
  recencyBonus: number; // Recency decay bonus
  matchedTokens: number; // Number of distinct query tokens matched
  totalQueryTokens: number; // Total query tokens searched
}

/**
 * Full index snapshot representation for rapid IndexedDB save/restore.
 */
export interface IndexSnapshot {
  version: number;
  stats: IndexStats;
  nextDocId?: number;
  documents: StoredMessageRecord[];
  docLengths: Uint16Array;
  postings: Array<{
    term: string;
    df: number;
    docIds: Uint32Array;
    termFreqs: Uint8Array;
  }>;
  channelDocMap: Record<string, number[]>;
  authorDocMap: Record<string, number[]>;
}

/**
 * Incremental synchronization boundary for a Discord channel.
 */
export interface ChannelSyncState {
  channelId: string;
  lastMessageId?: string;
  oldestMessageId?: string;
  messageCount: number;
  lastSyncTimestamp: number;
}

/* =========================================================================
 * Web Worker IPC Protocol
 * ========================================================================= */

export type WorkerRequest =
  | { id: string; type: 'INGEST_BATCH'; messages: DiscordMessage[] }
  | { id: string; type: 'DELETE_MESSAGES'; messageIds: string[] }
  | { id: string; type: 'SEARCH'; query: IndexSearchQuery }
  | { id: string; type: 'CLEAR_INDEX' }
  | { id: string; type: 'GET_STATS' }
  | { id: string; type: 'CREATE_SNAPSHOT' }
  | { id: string; type: 'LOAD_SNAPSHOT'; snapshot: IndexSnapshot };

export type WorkerResponse =
  | { id: string; type: 'INGEST_PROGRESS'; indexed: number; total: number }
  | { id: string; type: 'INGEST_COMPLETE'; indexedCount: number; totalDocs: number; durationMs: number }
  | { id: string; type: 'DELETE_COMPLETE'; deletedCount: number }
  | { id: string; type: 'SEARCH_RESULTS'; hits: ScoredIndexHit[]; records: StoredMessageRecord[]; durationMs: number }
  | { id: string; type: 'STATS'; stats: IndexStats }
  | { id: string; type: 'SNAPSHOT_CREATED'; snapshot: IndexSnapshot }
  | { id: string; type: 'LOAD_SNAPSHOT_COMPLETE'; totalDocs: number }
  | { id: string; type: 'CLEAR_COMPLETE' }
  | { id: string; type: 'ERROR'; error: string };
