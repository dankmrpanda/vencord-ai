/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatSession } from '../types';

const DB_NAME = 'VencordAIChatHistory';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not supported'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('channelId', 'channelId', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// LocalStorage fallback in case IndexedDB is unavailable
const LS_PREFIX = 'vencord_ai_session_';

export async function saveSession(session: ChatSession): Promise<void> {
  session.updatedAt = Date.now();

  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(session);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${LS_PREFIX}${session.id}`, JSON.stringify(session));
      }
    } catch (lsErr) {
      console.error('[VencordAI] Failed to save session to storage:', lsErr);
    }
  }
}

export async function getSessionsForChannel(channelId: string): Promise<ChatSession[]> {
  try {
    const db = await openDB();
    const dbResults = await new Promise<ChatSession[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('channelId');
      const req = index.getAll(channelId);

      req.onsuccess = () => {
        const results: ChatSession[] = req.result || [];
        results.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(results);
      };

      req.onerror = () => resolve([]);
    });
    if (dbResults.length > 0) return dbResults;
  } catch (err) {
    // IDB error, fallback to LocalStorage
  }

  // LocalStorage fallback
  const results: ChatSession[] = [];
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LS_PREFIX)) {
          try {
            const item: ChatSession = JSON.parse(localStorage.getItem(key) || '{}');
            if (item.channelId === channelId) {
              results.push(item);
            }
          } catch {}
        }
      }
    }
  } catch {}
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(sessionId);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {}

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${LS_PREFIX}${sessionId}`);
    }
  } catch {}
}

export function createNewSession(channelId: string, title?: string): ChatSession {
  return {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    channelId,
    title: title || 'New Conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}
