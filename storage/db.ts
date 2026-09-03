/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DiscordMessage } from '../types';
import { ChannelSyncState, IndexSnapshot } from './index/types';

const DB_NAME = 'VencordAIMessageDB';
const DB_VERSION = 1;

export const STORES = {
  MESSAGES: 'messages',
  SNAPSHOTS: 'snapshots',
  SYNC_STATE: 'sync_state',
} as const;

export class MessageDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryFallbackMessages: Map<string, DiscordMessage> = new Map();
  private memoryFallbackSnapshot: IndexSnapshot | null = null;
  private memoryFallbackSync: Map<string, ChannelSyncState> = new Map();

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains(STORES.MESSAGES)) {
          const msgStore = db.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
          msgStore.createIndex('channelId', 'channel_id', { unique: false });
          msgStore.createIndex('authorId', 'author.id', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
          msgStore.createIndex('guildId', 'guild_id', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
          db.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.SYNC_STATE)) {
          db.createObjectStore(STORES.SYNC_STATE, { keyPath: 'channelId' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return this.dbPromise;
  }

  /**
   * Persists a batch of Discord messages into IndexedDB with chunked transactions.
   */
  public async saveMessages(messages: DiscordMessage[]): Promise<void> {
    if (!messages || messages.length === 0) return;

    try {
      const db = await this.openDB();
      const chunkSize = 2000;

      for (let i = 0; i < messages.length; i += chunkSize) {
        const slice = messages.slice(i, i + chunkSize);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORES.MESSAGES, 'readwrite');
          const store = tx.objectStore(STORES.MESSAGES);
          for (const msg of slice) {
            store.put(msg);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
    } catch {
      // Memory fallback
      for (const msg of messages) {
        this.memoryFallbackMessages.set(msg.id, msg);
      }
    }
  }

  /**
   * Retrieves messages for a specific channel.
   */
  public async getMessagesForChannel(channelId: string, limit = 1000): Promise<DiscordMessage[]> {
    try {
      const db = await this.openDB();
      return new Promise<DiscordMessage[]>((resolve) => {
        const tx = db.transaction(STORES.MESSAGES, 'readonly');
        const store = tx.objectStore(STORES.MESSAGES);
        const index = store.index('channelId');
        const req = index.getAll(channelId, limit);

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch {
      return Array.from(this.memoryFallbackMessages.values())
        .filter((m) => m.channel_id === channelId)
        .slice(0, limit);
    }
  }

  /**
   * Retrieves a single message by ID.
   */
  public async getMessage(messageId: string): Promise<DiscordMessage | null> {
    try {
      const db = await this.openDB();
      return new Promise<DiscordMessage | null>((resolve) => {
        const tx = db.transaction(STORES.MESSAGES, 'readonly');
        const store = tx.objectStore(STORES.MESSAGES);
        const req = store.get(messageId);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return this.memoryFallbackMessages.get(messageId) || null;
    }
  }

  /**
   * Deletes a batch of messages by ID.
   */
  public async deleteMessages(messageIds: string[]): Promise<void> {
    if (!messageIds || messageIds.length === 0) return;

    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORES.MESSAGES, 'readwrite');
        const store = tx.objectStore(STORES.MESSAGES);
        for (const id of messageIds) {
          store.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      for (const id of messageIds) {
        this.memoryFallbackMessages.delete(id);
      }
    }
  }

  /**
   * Persists the compiled inverted index snapshot into IndexedDB.
   */
  public async saveIndexSnapshot(snapshot: IndexSnapshot): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORES.SNAPSHOTS, 'readwrite');
        const store = tx.objectStore(STORES.SNAPSHOTS);
        const record = { id: 'current_snapshot', snapshot, savedAt: Date.now() };
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.memoryFallbackSnapshot = snapshot;
    }
  }

  /**
   * Loads the latest index snapshot from IndexedDB.
   */
  public async loadIndexSnapshot(): Promise<IndexSnapshot | null> {
    try {
      const db = await this.openDB();
      return new Promise<IndexSnapshot | null>((resolve) => {
        const tx = db.transaction(STORES.SNAPSHOTS, 'readonly');
        const store = tx.objectStore(STORES.SNAPSHOTS);
        const req = store.get('current_snapshot');
        req.onsuccess = () => resolve(req.result?.snapshot || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return this.memoryFallbackSnapshot;
    }
  }

  /**
   * Updates channel sync boundaries.
   */
  public async setChannelSyncState(state: ChannelSyncState): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORES.SYNC_STATE, 'readwrite');
        const store = tx.objectStore(STORES.SYNC_STATE);
        const req = store.put(state);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.memoryFallbackSync.set(state.channelId, state);
    }
  }

  public async getChannelSyncState(channelId: string): Promise<ChannelSyncState | null> {
    try {
      const db = await this.openDB();
      return new Promise<ChannelSyncState | null>((resolve) => {
        const tx = db.transaction(STORES.SYNC_STATE, 'readonly');
        const store = tx.objectStore(STORES.SYNC_STATE);
        const req = store.get(channelId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return this.memoryFallbackSync.get(channelId) || null;
    }
  }

  public async getAllChannelSyncStates(): Promise<ChannelSyncState[]> {
    try {
      const db = await this.openDB();
      return new Promise<ChannelSyncState[]>((resolve) => {
        const tx = db.transaction(STORES.SYNC_STATE, 'readonly');
        const store = tx.objectStore(STORES.SYNC_STATE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch {
      return Array.from(this.memoryFallbackSync.values());
    }
  }

  public async clearAll(): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORES.MESSAGES, STORES.SNAPSHOTS, STORES.SYNC_STATE], 'readwrite');
        tx.objectStore(STORES.MESSAGES).clear();
        tx.objectStore(STORES.SNAPSHOTS).clear();
        tx.objectStore(STORES.SYNC_STATE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.memoryFallbackMessages.clear();
      this.memoryFallbackSnapshot = null;
      this.memoryFallbackSync.clear();
    }
  }
}

export const messageDb = new MessageDatabase();
