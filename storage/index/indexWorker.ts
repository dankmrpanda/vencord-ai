/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../../types';
import { InvertedIndex } from './invertedIndex';
import { WorkerRequest, WorkerResponse } from './types';

const index = new InvertedIndex();

async function handleIngestBatch(
  id: string,
  messages: DiscordMessage[],
  post: (msg: WorkerResponse) => void,
): Promise<void> {
  const startTime = performance.now();
  const chunkSize = 500;
  const total = messages.length;
  let indexed = 0;

  for (let i = 0; i < total; i += chunkSize) {
    const slice = messages.slice(i, i + chunkSize);
    indexed += index.addBatch(slice);

    post({
      id,
      type: 'INGEST_PROGRESS',
      indexed,
      total,
    });

    // Yield control to event loop to allow queries or cancellation
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  post({
    id,
    type: 'INGEST_COMPLETE',
    indexedCount: indexed,
    totalDocs: index.getStats().totalDocs,
    durationMs: performance.now() - startTime,
  });
}

export function handleWorkerMessage(
  request: WorkerRequest,
  post: (response: WorkerResponse) => void,
): void {
  try {
    switch (request.type) {
      case 'INGEST_BATCH': {
        void handleIngestBatch(request.id, request.messages, post);
        break;
      }
      case 'DELETE_MESSAGES': {
        const deletedCount = index.deleteMessages(request.messageIds);
        post({
          id: request.id,
          type: 'DELETE_COMPLETE',
          deletedCount,
        });
        break;
      }
      case 'SEARCH': {
        const start = performance.now();
        const { hits, records } = index.search(request.query);
        post({
          id: request.id,
          type: 'SEARCH_RESULTS',
          hits,
          records,
          durationMs: performance.now() - start,
        });
        break;
      }
      case 'GET_STATS': {
        post({
          id: request.id,
          type: 'STATS',
          stats: index.getStats(),
        });
        break;
      }
      case 'CREATE_SNAPSHOT': {
        post({
          id: request.id,
          type: 'SNAPSHOT_CREATED',
          snapshot: index.exportSnapshot(),
        });
        break;
      }
      case 'LOAD_SNAPSHOT': {
        index.importSnapshot(request.snapshot);
        post({
          id: request.id,
          type: 'LOAD_SNAPSHOT_COMPLETE',
          totalDocs: index.getStats().totalDocs,
        });
        break;
      }
      case 'CLEAR_INDEX': {
        index.clear();
        post({
          id: request.id,
          type: 'CLEAR_COMPLETE',
        });
        break;
      }
      default:
        post({
          id: (request as any).id || 'unknown',
          type: 'ERROR',
          error: `Unhandled worker request type: ${(request as any).type}`,
        });
    }
  } catch (err: any) {
    post({
      id: request.id || 'unknown',
      type: 'ERROR',
      error: err?.message || String(err),
    });
  }
}

// In Web Worker environment, wire directly to self.onmessage
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    handleWorkerMessage(event.data, (res) => (self as any).postMessage(res));
  };
}
