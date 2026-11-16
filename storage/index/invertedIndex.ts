/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../../types';
import { extractQueryTokens, TOKENIZER_VERSION, tokenizeText } from './tokenizer';
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

/** Snapshot format version. Tokenizer changes are tracked separately by TOKENIZER_VERSION. */
export const SNAPSHOT_VERSION = 1;

/** Accepts a typed array, a plain array, or the object form a typed array takes after JSON. */
function toTypedArray<T extends Uint32Array | Uint8Array>(
  value: unknown,
  Ctor: { from(src: ArrayLike<number>): T },
): T | null {
  if (value instanceof Uint32Array || value instanceof Uint8Array) return Ctor.from(value);
  if (!value || typeof value !== 'object') return null;
  const nums = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const n of nums) {
    if (!Number.isInteger(n) || (n as number) < 0) return null;
  }
  return Ctor.from(nums as number[]);
}

/**
 * Total order on hits: lower score is worse; equal scores fall back to the message id (snowflakes
 * compare numerically: shorter is older; older is worse), so ties do not depend on docId history.
 */
function isWorseHit(a: ScoredIndexHit, b: ScoredIndexHit): boolean {
  if (a.score !== b.score) return a.score < b.score;
  const x = a.messageId;
  const y = b.messageId;
  return x.length !== y.length ? x.length < y.length : x < y;
}

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
    } else if (isWorseHit(this.heap[0], item)) {
      this.heap[0] = item;
      this.siftDown(0);
    }
  }

  public getSortedResults(): ScoredIndexHit[] {
    return [...this.heap].sort((a, b) => (isWorseHit(a, b) ? 1 : isWorseHit(b, a) ? -1 : 0));
  }

  public get size(): number {
    return this.heap.length;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >>> 1;
      if (isWorseHit(this.heap[current], this.heap[parent])) {
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

      if (left < len && isWorseHit(this.heap[left], this.heap[smallest])) {
        smallest = left;
      }
      if (right < len && isWorseHit(this.heap[right], this.heap[smallest])) {
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

  // Channel & author filter mapping.
  private addToFilterMaps(record: StoredMessageRecord): void {
    let ch = this.channelDocs.get(record.channelId);
    if (!ch) {
      ch = new Set();
      this.channelDocs.set(record.channelId, ch);
    }
    ch.add(record.docId);
    let au = this.authorDocs.get(record.authorId);
    if (!au) {
      au = new Set();
      this.authorDocs.set(record.authorId, au);
    }
    au.add(record.docId);
  }

  /**
   * Adds a batch of Discord messages to the index.
   */
  public addBatch(messages: DiscordMessage[]): number {
    this.ensureCapacity(this.nextDocId + messages.length);
    let added = 0;

    for (const msg of messages) {
      if (!msg?.id) continue;

      const attachmentNames = msg.attachments?.map((a) => a.filename);
      let flags = 0;
      if (msg.attachments && msg.attachments.length > 0) flags |= MESSAGE_FLAGS.HAS_ATTACHMENTS;
      if (msg.embeds && msg.embeds.length > 0) flags |= MESSAGE_FLAGS.HAS_EMBEDS;
      if (/https?:\/\//.test(msg.content || '')) flags |= MESSAGE_FLAGS.HAS_LINKS;
      if (msg.pinned) flags |= MESSAGE_FLAGS.IS_PINNED;
      if (msg.mentions && msg.mentions.length > 0) flags |= MESSAGE_FLAGS.HAS_MENTIONS;
      if (msg.message_reference?.message_id) flags |= MESSAGE_FLAGS.HAS_REPLY;

      // An id that is already indexed: identical copies are no-ops; an edited copy (content,
      // attachments or flags changed) replaces the stored one.
      const existingDocId = this.messageIdToDocId.get(msg.id);
      if (existingDocId !== undefined) {
        const prev = this.docRecords.get(existingDocId);
        if (prev && prev.content === (msg.content || '') && prev.flags === flags
          && (prev.attachmentNames ?? []).join('\n') === (attachmentNames ?? []).join('\n')) {
          continue;
        }
        this.deleteMessages([msg.id]);
      }

      const docId = this.nextDocId++;
      const fullText = `${msg.content || ''} ${attachmentNames?.join(' ') || ''}`;
      const tokenized = tokenizeText(fullText);

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
        attachmentNames,
      };

      this.docRecords.set(docId, record);
      this.messageIdToDocId.set(msg.id, docId);
      this.docLengths[docId] = Math.min(tokenized.totalTokens, 65535);
      this.totalTokens += tokenized.totalTokens;
      this.docCount++;

      this.addToFilterMaps(record);

      for (const [term, tf] of tokenized.frequencies) {
        this.appendPosting(term, docId, tf);
      }

      added++;
    }

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
        // Remove the record first so compaction below already treats this docId as dead.
        this.docRecords.delete(docId);

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
            } else if (post.length >= 16 && (post.length - post.df) * 2 > post.length) {
              this.compactPosting(post); // lazy: only once dead entries outnumber live ones
            }
          }
        }

        this.totalTokens -= record.tokenLength;
        this.docCount--;
        this.docLengths[docId] = 0;
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Appends one entry to a term's posting list. Lists are capacity-doubling typed arrays with a
   * `length` field, so a batch only touches the terms it adds (no re-filtering of existing
   * entries). Entries of deleted docs stay in place until the list grows or is compacted.
   * Exported arrays are never written in place: a full list is always reallocated.
   */
  private appendPosting(term: string, docId: DocId, tf: number): void {
    let post = this.termDict.get(term);
    if (!post) {
      post = { term, df: 0, length: 0, docIds: new Uint32Array(4), termFreqs: new Uint8Array(4) };
      this.termDict.set(term, post);
    } else if (post.length === post.docIds.length) {
      if (post.df < post.length) this.compactPosting(post);
      const cap = Math.max(4, post.length * 2);
      const docIds = new Uint32Array(cap);
      const termFreqs = new Uint8Array(cap);
      docIds.set(post.docIds.subarray(0, post.length));
      termFreqs.set(post.termFreqs.subarray(0, post.length));
      post.docIds = docIds;
      post.termFreqs = termFreqs;
    }
    post.docIds[post.length] = docId;
    post.termFreqs[post.length] = Math.min(tf, 255);
    post.length++;
    post.df++;
  }

  /** Drops entries of deleted docs into new exact-length arrays and recomputes df from them. */
  private compactPosting(post: PostingList): void {
    let live = 0;
    for (let i = 0; i < post.length; i++) {
      if (this.docRecords.has(post.docIds[i])) live++;
    }
    const docIds = new Uint32Array(live);
    const termFreqs = new Uint8Array(live);
    let j = 0;
    for (let i = 0; i < post.length; i++) {
      if (this.docRecords.has(post.docIds[i])) {
        docIds[j] = post.docIds[i];
        termFreqs[j] = post.termFreqs[i];
        j++;
      }
    }
    post.docIds = docIds;
    post.termFreqs = termFreqs;
    post.length = live;
    post.df = live;
  }

  /**
   * Executes a fast BM25 search with candidate filtering and exact phrase boosting.
   */
  public search(query: IndexSearchQuery): { hits: ScoredIndexHit[]; records: StoredMessageRecord[] } {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const minScore = query.minScore ?? 0.01;
    const tokens = query.tokens || (query.query ? extractQueryTokens(query.query) : []);

    // Scope pre-filtering set. `channelIds` undefined = no channel filter; any array is an
    // allowlist, so an empty array matches nothing (fail closed).
    let allowedDocs: Set<DocId> | null = null;
    if (query.channelIds) {
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
        const len = posting.length;

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
      version: SNAPSHOT_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      stats: this.getStats(),
      nextDocId: this.nextDocId,
      documents: Array.from(this.docRecords.values()),
      docLengths: this.docLengths.slice(0, this.nextDocId),
      postings: Array.from(this.termDict.values(), (post) => {
        // Exact-length, live-only arrays; after this they are shared, never written in place.
        if (post.df !== post.length || post.docIds.length !== post.length) this.compactPosting(post);
        return { term: post.term, df: post.df, docIds: post.docIds, termFreqs: post.termFreqs };
      }),
      channelDocMap,
      authorDocMap,
    };
  }

  /**
   * Imports an index snapshot to restore in-memory state. The snapshot is validated and the new
   * state is built aside first, so a rejected snapshot leaves the live index untouched. Counts,
   * document lengths and the channel/author maps are derived from `documents` rather than trusted.
   * Typed arrays that went through JSON (plain objects / arrays) are accepted.
   */
  public importSnapshot(snapshot: IndexSnapshot): void {
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
      throw new Error(`Unsupported index snapshot version: ${snapshot?.version}`);
    }
    // Postings built by another tokenizer would not match new queries, and deleteMessages
    // re-tokenizes stored content: such a snapshot must be rebuilt, not loaded.
    if ((snapshot.tokenizerVersion ?? 1) !== TOKENIZER_VERSION) {
      throw new Error(`Index snapshot was built with tokenizer v${snapshot.tokenizerVersion ?? 1}; rebuild required`);
    }
    if (!Array.isArray(snapshot.documents) || !Array.isArray(snapshot.postings)) {
      throw new Error('Invalid index snapshot: documents and postings must be arrays');
    }

    const docRecords = new Map<DocId, StoredMessageRecord>();
    const messageIdToDocId = new Map<string, DocId>();
    let maxDocId = -1;
    let totalTokens = 0;
    for (const doc of snapshot.documents) {
      if (!doc || !Number.isInteger(doc.docId) || doc.docId < 0 || typeof doc.id !== 'string'
        || typeof doc.channelId !== 'string' || typeof doc.authorId !== 'string'
        || typeof doc.content !== 'string' || !Number.isFinite(doc.tokenLength)
        || docRecords.has(doc.docId) || messageIdToDocId.has(doc.id)) {
        throw new Error('Invalid index snapshot: malformed document record');
      }
      docRecords.set(doc.docId, doc);
      messageIdToDocId.set(doc.id, doc.docId);
      if (doc.docId > maxDocId) maxDocId = doc.docId;
      totalTokens += doc.tokenLength;
    }

    const termDict = new Map<string, PostingList>();
    for (const post of snapshot.postings) {
      const docIds = post ? toTypedArray(post.docIds, Uint32Array) : null;
      const tfs = post ? toTypedArray(post.termFreqs, Uint8Array) : null;
      if (!post || typeof post.term !== 'string' || !docIds || !tfs || docIds.length !== tfs.length) {
        throw new Error('Invalid index snapshot: malformed posting list');
      }
      // Keep live entries only; df is recomputed from them.
      const liveIds: number[] = [];
      const liveTfs: number[] = [];
      for (let i = 0; i < docIds.length; i++) {
        if (docRecords.has(docIds[i])) {
          liveIds.push(docIds[i]);
          liveTfs.push(tfs[i]);
        }
      }
      if (liveIds.length > 0) {
        termDict.set(post.term, {
          term: post.term,
          df: liveIds.length,
          length: liveIds.length,
          docIds: new Uint32Array(liveIds),
          termFreqs: new Uint8Array(liveTfs),
        });
      }
    }

    const snapNext = Number.isInteger(snapshot.nextDocId) ? snapshot.nextDocId! : 0;
    const nextDocId = Math.max(snapNext, maxDocId + 1);

    this.clear();
    this.ensureCapacity(nextDocId);
    this.docRecords = docRecords;
    this.messageIdToDocId = messageIdToDocId;
    this.termDict = termDict;
    this.docCount = docRecords.size;
    this.totalTokens = totalTokens;
    this.nextDocId = nextDocId;
    for (const doc of docRecords.values()) {
      this.docLengths[doc.docId] = Math.min(doc.tokenLength, 65535);
      this.addToFilterMaps(doc);
    }
  }

  public clear(): void {
    this.docRecords.clear();
    this.messageIdToDocId.clear();
    this.termDict.clear();
    this.channelDocs.clear();
    this.authorDocs.clear();
    this.docCount = 0;
    this.totalTokens = 0;
    this.nextDocId = 0;
    this.docLengths.fill(0);
  }
}
