/*
 * Regression tests for chat history persistence (IDX-03, IDX-04, REV-DSC-05).
 * Cases that patch globals (indexedDB, localStorage) restore them in `finally`.
 */

import { getSessionById, getSessionsForChannel, saveSession } from '../storage/chatHistory';
import { ChatSession } from '../types';
import { assert } from './assert';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type TxOutcome = 'complete' | 'abortAfterSuccess';

function installFakeIndexedDB(opts: { outcome: TxOutcome; getAllResult?: unknown[] }): () => void {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const makeReq = (): any => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  const makeTx = (): any => {
    const tx: any = { error: null, oncomplete: null, onerror: null, onabort: null };
    const reqs: any[] = [];
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        for (const r of reqs) r.onsuccess?.({ target: r });
        if (opts.outcome === 'complete') {
          tx.oncomplete?.({ target: tx });
        } else {
          tx.error = { name: 'QuotaExceededError', message: 'quota exceeded at commit' };
          tx.onabort?.({ target: tx });
        }
      }, 0);
    };
    const track = (result?: unknown) => {
      const r = makeReq();
      r.result = result;
      reqs.push(r);
      schedule();
      return r;
    };
    const store = {
      put: () => track(undefined),
      delete: () => track(undefined),
      get: (id: string) => track((opts.getAllResult as any[] | undefined)?.find((entry) => entry?.id === id)),
      getAll: () => track(opts.getAllResult ?? []),
      clear: () => track(undefined),
      index: () => ({
        getAll: () => track(opts.getAllResult ?? []),
        openCursor: () => track(null),
      }),
    };
    tx.objectStore = () => store;
    return tx;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => makeTx(),
    close: () => {},
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: {
      open: () => {
        const req = makeReq();
        setTimeout(() => {
          req.result = db;
          req.onsuccess?.({ target: req });
        }, 0);
        return req;
      },
    },
  });

  return () => {
    if (prev) Object.defineProperty(globalThis, 'indexedDB', prev);
    else delete (globalThis as any).indexedDB;
  };
}

function installFakeLocalStorage(initial: Record<string, string> = {}): { data: Map<string, string>; restore: () => void } {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map<string, string>(Object.entries(initial));
  const ls = {
    get length() { return data.size; },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: ls });
  return {
    data,
    restore: () => {
      if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
      else delete (globalThis as any).localStorage;
    },
  };
}

function session(id: string, channelId: string, updatedAt: number): ChatSession {
  return { id, channelId, title: id, createdAt: updatedAt, updatedAt, messages: [] };
}

async function idx03SaveSessionWaitsForCommit(): Promise<void> {
  {
    const restoreIdb = installFakeIndexedDB({ outcome: 'abortAfterSuccess' });
    const ls = installFakeLocalStorage();
    try {
      let rejected = false;
      const s = session('session_quota', 'chan1', 1);
      const out = await withTimeout(saveSession(s).catch(() => { rejected = true; }), 500);
      const fallbackWritten = ls.data.has('vencord_ai_session_session_quota');
      assert(out !== 'TIMEOUT', 'IDX-03 saveSession hung');
      assert(rejected || fallbackWritten, 'IDX-03 saveSession resolved although IDB aborted and fallback was not written');
    } finally {
      ls.restore();
      restoreIdb();
    }
  }
  {
    const restoreIdb = installFakeIndexedDB({ outcome: 'complete' });
    const ls = installFakeLocalStorage();
    try {
      const out = await withTimeout(saveSession(session('session_ok', 'chan1', 1)).then(() => 'RESOLVED', () => 'REJECTED'), 500);
      assert(out === 'RESOLVED', `IDX-03 saveSession on a committed transaction must resolve (got ${out})`);
      assert(!ls.data.has('vencord_ai_session_session_ok'), 'IDX-03 saveSession wrote the localStorage fallback although IDB committed');
    } finally {
      ls.restore();
      restoreIdb();
    }
  }
}

async function idx04MergesLocalStorageSessions(): Promise<void> {
  const idbOnly = session('session_idb', 'chan1', 1000);
  const idbStale = session('session_both_ls_newer', 'chan1', 1500);
  const idbFresh = { ...session('session_both_idb_newer', 'chan1', 3000), title: 'idb copy' };
  const lsOnly = session('session_ls', 'chan1', 2000);
  const lsNewer = { ...session('session_both_ls_newer', 'chan1', 2500), title: 'ls copy' };
  const lsStale = { ...session('session_both_idb_newer', 'chan1', 500), title: 'stale ls copy' };
  const otherChannel = session('session_other', 'chan2', 9000);
  const restoreIdb = installFakeIndexedDB({ outcome: 'complete', getAllResult: [idbOnly, idbStale, idbFresh] });
  const ls = installFakeLocalStorage({
    vencord_ai_session_session_ls: JSON.stringify(lsOnly),
    vencord_ai_session_session_both_ls_newer: JSON.stringify(lsNewer),
    vencord_ai_session_session_both_idb_newer: JSON.stringify(lsStale),
    vencord_ai_session_session_other: JSON.stringify(otherChannel),
  });
  try {
    const list = await getSessionsForChannel('chan1');
    const ids = list.map((s) => s.id);
    const expected = ['session_both_idb_newer', 'session_both_ls_newer', 'session_ls', 'session_idb'];
    assert(ids.join(',') === expected.join(','), `IDX-04 getSessionsForChannel returned [${ids.join(',')}]`);
    const byId = new Map(list.map((s) => [s.id, s]));
    assert(byId.get('session_both_ls_newer')?.title === 'ls copy', 'IDX-04 the newer localStorage copy must win over an older IDB copy');
    assert(byId.get('session_both_idb_newer')?.title === 'idb copy', 'IDX-04 the newer IDB copy must win over a stale localStorage copy');
    const restored = await getSessionById('session_both_ls_newer');
    assert(restored?.title === 'ls copy', `REV-DSC-05 getSessionById returned ${restored?.title} over newer localStorage copy`);
    const kept = await getSessionById('session_both_idb_newer');
    assert(kept?.title === 'idb copy', `REV-DSC-05 getSessionById returned ${kept?.title} over newer IDB copy`);
  } finally {
    ls.restore();
    restoreIdb();
  }
}

export async function runChatHistoryTests(): Promise<void> {
  await idx03SaveSessionWaitsForCommit();
  await idx04MergesLocalStorageSessions();
  console.log('✅ Chat history storage regression tests passed');
}
