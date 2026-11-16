/*
 * Benchmark of the PRODUCTION InvertedIndex (storage/index/invertedIndex.ts), unlike
 * test/retrievalBenchmark.ts, which measures the test-only InMemoryBM25Index.
 *
 * Corpus: 100k deterministic synthetic messages (seeded LCG, skewed 5,000-word vocabulary,
 * 5% with a CJK phrase, 50 channels, 300 authors), ingested in 500-message addBatch chunks as
 * storage/index/indexWorker.ts does. Reports ingest throughput, heap + ArrayBuffer delta after GC
 * (needs --expose-gc; `npm run test:benchmark:index` sets it), and query latency over a fixed
 * query set (half with a 3-channel filter, limit 100).
 */

import { InvertedIndex } from '../storage/index/invertedIndex';
import { DiscordMessage } from '../types';

const N = 100_000;
const CHUNK = 500;
const QUERIES = 300;
const WARMUP = 50;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function buildCorpus(): { messages: DiscordMessage[]; words: string[] } {
  const r = rng(7);
  const words = Array.from({ length: 5000 }, (_, i) => 'w' + i.toString(36) + ['ing', 'er', 'ed', ''][i % 4]);
  const cjk = ['深度学习', '服务器错误', 'ラーメン食べたい', '데이터베이스', '部署失败了'];
  const messages = Array.from({ length: N }, (_, i) => {
    const n = 4 + Math.floor(r() * 20);
    const ws = Array.from({ length: n }, () => words[Math.floor(Math.pow(r(), 2) * words.length)]);
    if (r() < 0.05) ws.push(cjk[Math.floor(r() * cjk.length)]);
    return {
      id: '1' + String(i).padStart(17, '0'),
      channel_id: 'c' + (i % 50),
      guild_id: 'g1',
      author: { id: 'u' + (i % 300), username: 'x' },
      content: ws.join(' '),
      timestamp: new Date(1.7e12 + i * 1000).toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    } as unknown as DiscordMessage;
  });
  return { messages, words };
}

function heapBytes(): number {
  (globalThis as { gc?: () => void }).gc?.();
  const mu = process.memoryUsage();
  return mu.heapUsed + mu.arrayBuffers;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function main(): void {
  const { messages, words } = buildCorpus();
  const hasGc = typeof (globalThis as { gc?: () => void }).gc === 'function';

  const heap0 = heapBytes();
  const index = new InvertedIndex();
  const t0 = performance.now();
  for (let i = 0; i < N; i += CHUNK) index.addBatch(messages.slice(i, i + CHUNK));
  const ingestMs = performance.now() - t0;
  const heapMB = (heapBytes() - heap0) / 1048576;
  const stats = index.getStats();

  const qr = rng(1337);
  const queries = Array.from({ length: WARMUP + QUERIES }, (_, q) => ({
    query: `${words[Math.floor(Math.pow(qr(), 2) * words.length)]} ${words[Math.floor(qr() * words.length)]}`,
    channelIds: q % 2 ? ['c1', 'c2', 'c3'] : undefined,
    limit: 100,
  }));
  const lat: number[] = [];
  let hitSum = 0;
  queries.forEach((q, i) => {
    const s = performance.now();
    const res = index.search(q);
    const d = performance.now() - s;
    if (i >= WARMUP) {
      lat.push(d);
      hitSum += res.hits.length;
    }
  });
  lat.sort((a, b) => a - b);
  const mean = lat.reduce((a, b) => a + b, 0) / lat.length;

  const result = {
    docs: stats.totalDocs,
    terms: stats.uniqueTerms,
    avgdl: +stats.avgdl.toFixed(2),
    ingestMs: Math.round(ingestMs),
    msgsPerSec: Math.round(N / (ingestMs / 1000)),
    heapMB: hasGc ? +heapMB.toFixed(1) : null,
    queryMeanMs: +mean.toFixed(3),
    queryP95Ms: +percentile(lat, 0.95).toFixed(3),
    queryP99Ms: +percentile(lat, 0.99).toFixed(3),
    totalHits: hitSum,
  };
  console.log(`[ProductionIndexBenchmark] ${N} msgs in ${CHUNK}-msg batches: ${result.msgsPerSec} msgs/s (${result.ingestMs} ms)`);
  console.log(`[ProductionIndexBenchmark] heap+ArrayBuffer delta after GC: ${hasGc ? `${result.heapMB} MB` : 'n/a (run with --expose-gc)'}`);
  console.log(`[ProductionIndexBenchmark] ${QUERIES} queries: mean ${result.queryMeanMs} ms, p95 ${result.queryP95Ms} ms, p99 ${result.queryP99Ms} ms (total hits ${hitSum})`);
  console.log(JSON.stringify(result));
}

main();
