/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../../types';
import { InvertedIndex } from './invertedIndex';
import { handleWorkerMessage } from './indexWorker';
import {
  IndexSearchQuery,
  IndexSnapshot,
  IndexStats,
  ScoredIndexHit,
  StoredMessageRecord,
  WorkerRequest,
  WorkerResponse,
} from './types';

export class WorkerBridge {
  private worker: Worker | null = null;
  private fallbackIndex: InvertedIndex | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: any) => void;
      onProgress?: (indexed: number, total: number) => void;
    }
  >();
  private reqCounter = 0;

  public async init(): Promise<void> {
    if (typeof Worker !== 'undefined') {
      try {
        // In browser / Electron mod runtime with bundler URL support
        this.worker = new Worker(new URL('./indexWorker', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
        this.worker.onerror = (err) => console.error('[VencordAI] IndexWorker error:', err);
        return;
      } catch {
        console.warn('[VencordAI] Web Worker initialization failed, using in-process engine.');
      }
    }
    this.fallbackIndex = new InvertedIndex();
  }

  private post(request: WorkerRequest, onProgress?: (indexed: number, total: number) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject, onProgress });

      if (this.worker) {
        this.worker.postMessage(request);
      } else {
        // In-process fallback
        handleWorkerMessage(request, (res) => this.onMessage(res));
      }
    });
  }

  private onMessage(response: WorkerResponse): void {
    const handler = this.pendingRequests.get(response.id);
    if (!handler) return;

    if (response.type === 'INGEST_PROGRESS') {
      handler.onProgress?.(response.indexed, response.total);
      return;
    }

    if (response.type === 'ERROR') {
      handler.reject(new Error(response.error));
      this.pendingRequests.delete(response.id);
      return;
    }

    handler.resolve(response);
    this.pendingRequests.delete(response.id);
  }

  public async ingestBatch(
    messages: DiscordMessage[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ indexedCount: number; totalDocs: number; durationMs: number }> {
    const id = `req_${++this.reqCounter}`;
    const res = await this.post({ id, type: 'INGEST_BATCH', messages }, onProgress);
    return res;
  }

  public async deleteMessages(messageIds: string[]): Promise<{ deletedCount: number }> {
    const id = `req_${++this.reqCounter}`;
    const res = await this.post({ id, type: 'DELETE_MESSAGES', messageIds });
    return res;
  }

  public async search(
    query: IndexSearchQuery,
  ): Promise<{ hits: ScoredIndexHit[]; records: StoredMessageRecord[]; durationMs: number }> {
    const id = `req_${++this.reqCounter}`;
    const res = await this.post({ id, type: 'SEARCH', query });
    return res;
  }

  public async getStats(): Promise<IndexStats> {
    const id = `req_${++this.reqCounter}`;
    const res = await this.post({ id, type: 'GET_STATS' });
    return res.stats;
  }

  public async createSnapshot(): Promise<IndexSnapshot> {
    const id = `req_${++this.reqCounter}`;
    const res = await this.post({ id, type: 'CREATE_SNAPSHOT' });
    return res.snapshot;
  }

  public async loadSnapshot(snapshot: IndexSnapshot): Promise<void> {
    const id = `req_${++this.reqCounter}`;
    await this.post({ id, type: 'LOAD_SNAPSHOT', snapshot });
  }

  public async clear(): Promise<void> {
    const id = `req_${++this.reqCounter}`;
    await this.post({ id, type: 'CLEAR_INDEX' });
  }
}

export const indexBridge = new WorkerBridge();
