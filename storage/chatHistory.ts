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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(session);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    try {
      localStorage.setItem(`${LS_PREFIX}${session.id}`, JSON.stringify(session));
    } catch (lsErr) {
      console.error('[VencordAI] Failed to save session to storage:', lsErr);
    }
  }
}

export async function getSessionsForChannel(channelId: string): Promise<ChatSession[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
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
  } catch (err) {
    // Fallback to LocalStorage
    const results: ChatSession[] = [];
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
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(sessionId);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    localStorage.removeItem(`${LS_PREFIX}${sessionId}`);
  }
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
