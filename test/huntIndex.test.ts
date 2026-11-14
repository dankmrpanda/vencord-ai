/*
 * Regression tests for the approved index/storage fixes (prefix IDX): IDX-02, IDX-03.
 * Cases that patch globals (indexedDB, localStorage) restore them in `finally`.
 */

import { saveSession } from '../storage/chatHistory';
import { InvertedIndex } from '../storage/index/invertedIndex';
import { ChatSession, DiscordMessage } from '../types';
import { assert } from './assert';

function msg(id: string, channelId: string, content: string, authorId = 'u1', extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id,
    channel_id: channelId,
    guild_id: 'g1',
    author: { id: authorId, username: authorId } as DiscordMessage['author'],
    content,
    timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
    ...extra,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------------ */
/* Minimal controllable IndexedDB fake.                                      */
/* Premise (IndexedDB spec, "commit a transaction" / "abort a transaction"):  */
/* when a commit fails (e.g. QuotaExceededError) after every request already  */
/* succeeded, the transaction fires ONLY `abort` (tx.error set); no `error`   */
/* event reaches the transaction because no request is pending.               */
/* ------------------------------------------------------------------------ */
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
      get: () => track(undefined),
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

/* ------------------------------------------------------------------------ */
/* IDX-02: channelIds undefined = no filter; any array is an allowlist, and  */
/* [] matches nothing (fail closed).                                         */
/* ------------------------------------------------------------------------ */
function idx02Index(): InvertedIndex {
  const index = new InvertedIndex(100);
  index.addBatch([
    msg('a1', 'chan_allowed', 'alpha rollout notes', 'mallory'),
    msg('b1', 'chan_private', 'alpha secret plan', 'mallory'),
  ]);
  return index;
}

async function idx02EmptyChannelAllowlistMatchesNothing(): Promise<void> {
  const index = idx02Index();
  const res = index.search({ query: 'alpha', channelIds: [], limit: 10, boostRecency: 0 });
  const channels = res.records.map((r) => r.channelId).sort();
  assert(res.hits.length === 0, `IDX-02 search({query:'alpha', channelIds:[]}) returned ${res.hits.length} hits from [${channels.join(',')}] (expected 0: empty allowlist = match nothing)`);
  const noFilter = index.search({ query: 'alpha', limit: 10, boostRecency: 0 });
  assert(noFilter.hits.length === 2, `IDX-02 channelIds undefined must stay "no filter" (got ${noFilter.hits.length} hits, expected 2)`);
  const one = index.search({ query: 'alpha', channelIds: ['chan_allowed'], limit: 10, boostRecency: 0 });
  assert(one.records.length === 1 && one.records[0].channelId === 'chan_allowed', `IDX-02 non-empty allowlist must filter (got [${one.records.map((r) => r.channelId).join(',')}])`);
}

async function idx02EmptyAllowlistPlusAuthorMatchesNothing(): Promise<void> {
  const index = idx02Index();
  const res = index.search({ channelIds: [], authorId: 'mallory', limit: 10, boostRecency: 0 });
  const channels = res.records.map((r) => r.channelId).sort();
  assert(res.hits.length === 0, `IDX-02 search({channelIds:[], authorId}) returned ${res.hits.length} docs from [${channels.join(',')}] across all channels (expected 0)`);
  const noFilter = index.search({ authorId: 'mallory', limit: 10, boostRecency: 0 });
  assert(noFilter.hits.length === 2, `IDX-02 authorId without channelIds must still return the author's docs (got ${noFilter.hits.length}, expected 2)`);
}

/* ------------------------------------------------------------------------ */
/* IDX-03: saveSession must only report success after the transaction       */
/* commits; a commit-time abort must reach the localStorage fallback.        */
/* ------------------------------------------------------------------------ */
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
      assert(rejected || fallbackWritten, 'IDX-03 saveSession resolved successfully although the IDB transaction aborted (QuotaExceededError at commit) and nothing was written to the localStorage fallback: the session is silently lost');
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

const CASES: Array<[string, () => Promise<void>]> = [
  ['IDX-03 saveSession waits for commit; abort reaches localStorage fallback', idx03SaveSessionWaitsForCommit],
  ['IDX-02 channelIds:[] matches nothing; undefined = no filter', idx02EmptyChannelAllowlistMatchesNothing],
  ['IDX-02 channelIds:[] + authorId matches nothing', idx02EmptyAllowlistPlusAuthorMatchesNothing],
];

export async function runHuntIndexTests(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of CASES) {
    try {
      await run();
      console.log(`✅ huntIndex: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(name);
      console.log(`❌ huntIndex: ${name}: ${message}`);
    }
  }
  assert(failures.length === 0, `huntIndex: ${failures.length} failing case(s)`);
}
