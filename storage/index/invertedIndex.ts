/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../../types';
import { extractQueryTokens, tokenizeText } from './tokenizer';
import {
  BM25Config,
  DocId,
  IndexSearchQuery,
  IndexSnapshot,
  IndexStats,
  MESSAGE_FLAGS,
  PostingList,
  ScoredIndexHit,
  StoredMessageRecord,
} from './types';

/**
 * Min-Heap implementation for Top-K candidate collection in O(M log K).
 */
export class TopKHeap {
  private heap: ScoredIndexHit[] = [];

  constructor(private readonly maxK: number) {}

  public push(item: ScoredIndexHit): void {
    if (this.heap.length < this.maxK) {
      this.heap.push(item);
      this.siftUp(this.heap.length - 1);
    } else if (item.score > this.heap[0].score) {
      this.heap[0] = item;
      this.siftDown(0);
    }
  }

  public getSortedResults(): ScoredIndexHit[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }

  public get size(): number {
    return this.heap.length;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >>> 1;
      if (this.heap[current].score < this.heap[parent].score) {
        this.swap(current, parent);
        current = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let current = index;
    const len = this.heap.length;
    while (true) {
      const left = (current << 1) + 1;
      const right = left + 1;
      let smallest = current;

      if (left < len && this.heap[left].score < this.heap[smallest].score) {
        smallest = left;
      }
      if (right < len && this.heap[right].score < this.heap[smallest].score) {
        smallest = right;
      }
      if (smallest !== current) {
        this.swap(current, smallest);
        current = smallest;
      } else {
        break;
      }
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}

/**
 * Fast binary search in sorted Uint32Array DocIDs.
 */
export function binarySearchDocId(arr: Uint32Array, target: number): number {
  let low = 0;
  let high = arr.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const val = arr[mid];
    if (val === target) return mid;
    if (val < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * High-Performance Inverted Index Engine.
 */
export class InvertedIndex {
  private docRecords: Map<DocId, StoredMessageRecord> = new Map();
  private messageIdToDocId: Map<string, DocId> = new Map();
  private docLengths: Uint16Array;
  private docCount = 0;
  private totalTokens = 0;
  private nextDocId: DocId = 0;
  private capacity: number;

  // Term -> PostingList
  private termDict: Map<string, PostingList> = new Map();

  // Dynamic accumulator lists used during batch ingestion
  private dynamicPostings: Map<string, { docIds: number[]; tfs: number[] }> = new Map();

  // Filter Indices
  private channelDocs: Map<string, Set<DocId>> = new Map();
  private authorDocs: Map<string, Set<DocId>> = new Map();

  // BM25 Configuration
  private readonly config: BM25Config;

  constructor(initialCapacity = 120_000, config: Partial<BM25Config> = {}) {
    this.capacity = initialCapacity;
    this.docLengths = new Uint16Array(this.capacity);
    this.config = {
      k1: config.k1 ?? 1.2,
      b: config.b ?? 0.75,
    };
  }

  private ensureCapacity(required: number): void {
    if (required > this.capacity) {
      const newCap = Math.max(required, Math.floor(this.capacity * 1.5));
      const nextDocLengths = new Uint16Array(newCap);
      nextDocLengths.set(this.docLengths);
      this.docLengths = nextDocLengths;
      this.capacity = newCap;
    }
  }

  /**
   * Adds a batch of Discord messages to the index.
   */
  public addBatch(messages: DiscordMessage[]): number {
    this.ensureCapacity(this.nextDocId + messages.length);
    let added = 0;

    for (const msg of messages) {
      if (!msg?.id || this.messageIdToDocId.has(msg.id)) {
        continue;
      }

      const docId = this.nextDocId++;
      const fullText = `${msg.content || ''} ${msg.attachments?.map((a) => a.filename).join(' ') || ''}`;
      const tokenized = tokenizeText(fullText);

      let flags = 0;
      if (msg.attachments && msg.attachments.length > 0) flags |= MESSAGE_FLAGS.HAS_ATTACHMENTS;
      if (msg.embeds && msg.embeds.length > 0) flags |= MESSAGE_FLAGS.HAS_EMBEDS;
      if (/https?:\/\//.test(msg.content || '')) flags |= MESSAGE_FLAGS.HAS_LINKS;
      if (msg.pinned) flags |= MESSAGE_FLAGS.IS_PINNED;
      if (msg.mentions && msg.mentions.length > 0) flags |= MESSAGE_FLAGS.HAS_MENTIONS;
      if (msg.message_reference?.message_id) flags |= MESSAGE_FLAGS.HAS_REPLY;

      const rawTs = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (msg.timestamp !== undefined && msg.timestamp !== null ? new Date(msg.timestamp).getTime() : Date.now());
      const timestamp = Number.isFinite(rawTs) ? rawTs : Date.now();

      const record: StoredMessageRecord = {
        docId,
        id: msg.id,
        channelId: msg.channel_id,
        guildId: msg.guild_id,
        authorId: msg.author?.id || 'unknown',
        authorName: msg.author?.globalName || msg.author?.username || 'Unknown',
        timestamp,
        content: msg.content || '',
        tokenLength: tokenized.totalTokens,
        flags,
        replyParentId: msg.message_reference?.message_id,
        attachmentNames: msg.attachments?.map((a) => a.filename),
      };

      this.docRecords.set(docId, record);
      this.messageIdToDocId.set(msg.id, docId);
      this.docLengths[docId] = Math.min(tokenized.totalTokens, 65535);
      this.totalTokens += tokenized.totalTokens;
      this.docCount++;

      // Channel & Author Filter mapping
      if (!this.channelDocs.has(record.channelId)) {
        this.channelDocs.set(record.channelId, new Set());
      }
      this.channelDocs.get(record.channelId)!.add(docId);

      if (!this.authorDocs.has(record.authorId)) {
        this.authorDocs.set(record.authorId, new Set());
      }
      this.authorDocs.get(record.authorId)!.add(docId);

      // Postings accumulation
      for (const [term, tf] of tokenized.frequencies.entries()) {
        let post = this.dynamicPostings.get(term);
        if (!post) {
          post = { docIds: [], tfs: [] };
          this.dynamicPostings.set(term, post);
        }
        post.docIds.push(docId);
        post.tfs.push(Math.min(tf, 255));
      }

      added++;
    }

    this.freezeDynamicPostings();
    return added;
  }

  /**
   * Deletes messages from the index by their message IDs.
   */
  public deleteMessages(messageIds: string[]): number {
    let deleted = 0;
    for (const msgId of messageIds) {
      const docId = this.messageIdToDocId.get(msgId);
      if (docId === undefined) continue;

      this.messageIdToDocId.delete(msgId);
      const record = this.docRecords.get(docId);
      if (record) {
        const chSet = this.channelDocs.get(record.channelId);
        if (chSet) chSet.delete(docId);

        const authSet = this.authorDocs.get(record.authorId);
        if (authSet) authSet.delete(docId);

        // Decrement postings df and cleanup empty terms
        const fullText = `${record.content} ${record.attachmentNames?.join(' ') || ''}`;
        const tokenized = tokenizeText(fullText);
        for (const term of tokenized.frequencies.keys()) {
          const post = this.termDict.get(term);
          if (post) {
            post.df = Math.max(0, post.df - 1);
            if (post.df <= 0) {
              this.termDict.delete(term);
            }
          }
        }

        this.totalTokens -= record.tokenLength;
        this.docCount--;
        this.docRecords.delete(docId);
        this.docLengths[docId] = 0;
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Compiles dynamic postings into frozen contiguous Uint32Array / Uint8Array structures.
   */
  private freezeDynamicPostings(): void {
    for (const [term, dyn] of this.dynamicPostings.entries()) {
      const existing = this.termDict.get(term);
      if (!existing) {
        this.termDict.set(term, {
          term,
          df: dyn.docIds.length,
          docIds: new Uint32Array(dyn.docIds),
          termFreqs: new Uint8Array(dyn.tfs),
        });
      } else {
        // Filter surviving docIds from existing postings
        const survivingDocIds: number[] = [];
        const survivingTfs: number[] = [];
        for (let i = 0; i < existing.docIds.length; i++) {
          const d = existing.docIds[i];
          if (this.docRecords.has(d)) {
            survivingDocIds.push(d);
            survivingTfs.push(existing.termFreqs[i]);
          }
        }

        const combinedLen = survivingDocIds.length + dyn.docIds.length;
        const newDocIds = new Uint32Array(combinedLen);
        const newTfs = new Uint8Array(combinedLen);

        newDocIds.set(survivingDocIds, 0);
        newDocIds.set(dyn.docIds, survivingDocIds.length);
        newTfs.set(survivingTfs, 0);
        newTfs.set(dyn.tfs, survivingTfs.length);

        this.termDict.set(term, {
          term,
          df: combinedLen,
          docIds: newDocIds,
          termFreqs: newTfs,
        });
      }
    }
    this.dynamicPostings.clear();
  }

  /**
   * Executes a fast BM25 search with candidate filtering and exact phrase boosting.
   */
  public search(query: IndexSearchQuery): { hits: ScoredIndexHit[]; records: StoredMessageRecord[] } {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const minScore = query.minScore ?? 0.01;
    const tokens = query.tokens || (query.query ? extractQueryTokens(query.query) : []);

    // Scope pre-filtering set
    let allowedDocs: Set<DocId> | null = null;
    if (query.channelIds && query.channelIds.length > 0) {
      allowedDocs = new Set<DocId>();
      for (const chId of query.channelIds) {
        const set = this.channelDocs.get(chId);
        if (set) {
          for (const d of set) allowedDocs.add(d);
        }
      }
    }

    if (query.authorId) {
      const authorSet = this.authorDocs.get(query.authorId);
      if (!authorSet) return { hits: [], records: [] };
      if (allowedDocs) {
        const intersected = new Set<DocId>();
        for (const d of authorSet) {
          if (allowedDocs.has(d)) intersected.add(d);
        }
        allowedDocs = intersected;
      } else {
        allowedDocs = authorSet;
      }
    }

    if (tokens.length === 0 && !allowedDocs) {
      return { hits: [], records: [] };
    }

    const avgdl = this.totalTokens / Math.max(1, this.docCount);
    const N = this.docCount;
    const candidateScores = new Map<DocId, { bm25: number; matched: number }>();

    if (tokens.length > 0) {
      // Evaluate BM25 for each query term
      for (const token of tokens) {
        const posting = this.termDict.get(token);
        if (!posting) continue;

        const df = Math.min(posting.df, N);
        const idf = Math.max(1e-4, Math.log(1 + Math.max(0, N - df + 0.5) / (df + 0.5)));
        const docIds = posting.docIds;
        const tfs = posting.termFreqs;
        const len = docIds.length;

        for (let i = 0; i < len; i++) {
          const docId = docIds[i];

          if (!this.docRecords.has(docId)) continue;
          if (allowedDocs && !allowedDocs.has(docId)) continue;

          const tf = tfs[i];
          const dl = this.docLengths[docId] || 1;
          const normTf = (tf * (this.config.k1 + 1)) /
            (tf + this.config.k1 * (1 - this.config.b + this.config.b * (dl / avgdl)));
          const termScore = idf * normTf;

          const entry = candidateScores.get(docId);
          if (entry) {
            entry.bm25 += termScore;
            entry.matched += 1;
          } else {
            candidateScores.set(docId, { bm25: termScore, matched: 1 });
          }
        }
      }
    } else if (allowedDocs) {
      // If only filtering without tokens, evaluate all allowed documents
      for (const docId of allowedDocs) {
        if (this.docRecords.has(docId)) {
          candidateScores.set(docId, { bm25: 1.0, matched: 0 });
        }
      }
    }

    // Min-heap for Top-K scoring
    const heap = new TopKHeap(limit);
    const now = Date.now();
    const queryLower = query.query?.toLowerCase();

    for (const [docId, { bm25, matched }] of candidateScores.entries()) {
      const record = this.docRecords.get(docId);
      if (!record) continue;

      // Guild Filter
      if (query.guildId && record.guildId !== query.guildId) continue;

      // Date Filters
      if (query.minTimestamp && record.timestamp < query.minTimestamp) continue;
      if (query.maxTimestamp && record.timestamp > query.maxTimestamp) continue;

      // Flag Filters
      if (query.flagsRequired && (record.flags & query.flagsRequired) !== query.flagsRequired) continue;
      if (query.flagsExcluded && (record.flags & query.flagsExcluded) !== 0) continue;

      // Exact Match Bonus
      let exactBonus = 0;
      if (queryLower && record.content.toLowerCase().includes(queryLower)) {
        exactBonus = 15.0 * (query.boostExact ?? 1.5);
      }

      // Recency Decay Bonus (scaled up to 2.0 points for messages < 30 days old)
      const ageDays = (now - record.timestamp) / (1000 * 60 * 60 * 24);
      const recencyBonus = 2.0 * Math.exp(-Math.max(0, ageDays) / 30.0) * (query.boostRecency ?? 0.15);

      const totalScore = bm25 + exactBonus + recencyBonus;

      if (totalScore >= minScore) {
        heap.push({
          docId,
          messageId: record.id,
          score: totalScore,
          bm25Score: bm25,
          exactBonus,
          recencyBonus,
          matchedTokens: matched,
          totalQueryTokens: tokens.length,
        });
      }
    }

    const hits = heap.getSortedResults();
    const records = hits
      .map((h) => this.docRecords.get(h.docId))
      .filter((r): r is StoredMessageRecord => Boolean(r));

    return { hits, records };
  }

  /**
   * Returns current engine statistics.
   */
  public getStats(): IndexStats {
    let postingMemory = 0;
    for (const post of this.termDict.values()) {
      postingMemory += post.docIds.byteLength + post.termFreqs.byteLength;
    }

    return {
      totalDocs: this.docCount,
      totalTokens: this.totalTokens,
      avgdl: this.totalTokens / Math.max(1, this.docCount),
      uniqueTerms: this.termDict.size,
      memoryUsageBytes: postingMemory + this.docLengths.byteLength + (this.docCount * 128),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Exports an index snapshot for persistent storage.
   */
  public exportSnapshot(): IndexSnapshot {
    const channelDocMap: Record<string, number[]> = {};
    for (const [chId, set] of this.channelDocs.entries()) {
      channelDocMap[chId] = Array.from(set);
    }

    const authorDocMap: Record<string, number[]> = {};
    for (const [authId, set] of this.authorDocs.entries()) {
      authorDocMap[authId] = Array.from(set);
    }

    return {
      version: 1,
      stats: this.getStats(),
      nextDocId: this.nextDocId,
      documents: Array.from(this.docRecords.values()),
      docLengths: this.docLengths.slice(0, this.nextDocId),
      postings: Array.from(this.termDict.values()),
      channelDocMap,
      authorDocMap,
    };
  }

  /**
   * Imports an index snapshot to restore in-memory state.
   */
  public importSnapshot(snapshot: IndexSnapshot): void {
    this.clear();
    this.docCount = snapshot.stats.totalDocs;
    this.totalTokens = snapshot.stats.totalTokens;

    let maxDocId = -1;
    for (const doc of snapshot.documents) {
      if (doc.docId > maxDocId) maxDocId = doc.docId;
    }

    const snapDocLengthsLen = snapshot.docLengths ? snapshot.docLengths.length : 0;
    this.nextDocId = Math.max(
      snapshot.nextDocId ?? 0,
      snapDocLengthsLen,
      maxDocId + 1,
    );

    const requiredCap = Math.max(
      snapDocLengthsLen,
      this.nextDocId,
      this.docCount,
    );
    this.ensureCapacity(requiredCap);

    if (snapshot.docLengths) {
      this.docLengths.set(snapshot.docLengths);
    }

    for (const doc of snapshot.documents) {
      this.docRecords.set(doc.docId, doc);
      this.messageIdToDocId.set(doc.id, doc.docId);
    }

    for (const post of snapshot.postings) {
      this.termDict.set(post.term, {
        term: post.term,
        df: post.df,
        docIds: new Uint32Array(post.docIds),
        termFreqs: new Uint8Array(post.termFreqs),
      });
    }

    for (const [chId, arr] of Object.entries(snapshot.channelDocMap)) {
      this.channelDocs.set(chId, new Set(arr));
    }

    for (const [authId, arr] of Object.entries(snapshot.authorDocMap)) {
      this.authorDocs.set(authId, new Set(arr));
    }
  }

  public clear(): void {
    this.docRecords.clear();
    this.messageIdToDocId.clear();
    this.termDict.clear();
    this.dynamicPostings.clear();
    this.channelDocs.clear();
    this.authorDocs.clear();
    this.docCount = 0;
    this.totalTokens = 0;
    this.nextDocId = 0;
    this.docLengths.fill(0);
  }
}
