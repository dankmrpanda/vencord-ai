/*
 * Regression tests for the approved index/storage fixes (prefix IDX): IDX-02, IDX-03, IDX-04.
 * Cases that patch globals (indexedDB, localStorage) restore them in `finally`.
 */

import { getSessionById, getSessionsForChannel, saveSession } from '../storage/chatHistory';
import { InvertedIndex } from '../storage/index/invertedIndex';
import { WorkerBridge } from '../storage/index/workerBridge';
import { MessageDatabase } from '../storage/db';
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

/* ------------------------------------------------------------------------ */
/* IDX-04: getSessionsForChannel merges localStorage-fallback sessions with  */
/* IndexedDB results by id; the newer updatedAt wins.                        */
/* ------------------------------------------------------------------------ */
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
    assert(ids.join(',') === expected.join(','), `IDX-04 getSessionsForChannel returned [${ids.join(',')}] (expected [${expected.join(',')}]: IDB and localStorage-fallback sessions merged by id, newest first)`);
    const byId = new Map(list.map((s) => [s.id, s]));
    assert(byId.get('session_both_ls_newer')?.title === 'ls copy', 'IDX-04 the newer localStorage copy must win over an older IDB copy');
    assert(byId.get('session_both_idb_newer')?.title === 'idb copy', 'IDX-04 the newer IDB copy must win over a stale localStorage copy');
    // REV-DSC-05: the single-session reader (used to restore the active session) applies the same newest-wins rule.
    const restored = await getSessionById('session_both_ls_newer');
    assert(restored?.title === 'ls copy', `REV-DSC-05 getSessionById returned the stale IDB copy (${restored?.title}) over a newer localStorage copy`);
    const kept = await getSessionById('session_both_idb_newer');
    assert(kept?.title === 'idb copy', `REV-DSC-05 getSessionById returned a stale localStorage copy (${kept?.title}) over a newer IDB copy`);
  } finally {
    ls.restore();
    restoreIdb();
  }
}

/* ------------------------------------------------------------------------ */
/* IDX-07: an ingest exception and a worker error must reject the pending    */
/* request instead of leaving it unsettled.                                  */
/* ------------------------------------------------------------------------ */
async function idx07IngestErrorRejects(): Promise<void> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const bridge = new WorkerBridge();
  try {
    const bad = msg('bad_1', 'chan1', 'boom', 'u1', { attachments: [null as any] });
    const out = await withTimeout(bridge.ingestBatch([bad]).then(() => 'RESOLVED', () => 'REJECTED'), 300);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(out === 'REJECTED' && seen.length === 0, `IDX-07 ingestBatch after addBatch threw: ${out} (expected REJECTED; unhandled rejections seen: ${seen.length})`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await bridge.clear();
  }
}

async function idx07WorkerErrorRejectsPending(): Promise<void> {
  const prevWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const prevConsoleError = console.error;
  class FakeWorker {
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    terminated = false;
    postMessage(): void {
      setTimeout(() => this.onerror?.({ message: 'worker crashed' }), 0);
    }
    terminate(): void { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
  console.error = () => {};
  const bridge = new WorkerBridge();
  try {
    await bridge.init();
    const out = await withTimeout(bridge.search({ query: 'alpha' }).then(() => 'RESOLVED', () => 'REJECTED'), 200);
    assert(out === 'REJECTED', `IDX-07 search() ${out === 'TIMEOUT' ? 'still pending 200 ms' : out} after the worker raised an error event (expected REJECTED)`);
    const later = await withTimeout(bridge.getStats().then(() => 'RESOLVED', () => 'REJECTED'), 200);
    assert(later === 'RESOLVED', `IDX-07 a request after the worker error was ${later} (expected RESOLVED via the in-process engine)`);
  } finally {
    console.error = prevConsoleError;
    if (prevWorker) Object.defineProperty(globalThis, 'Worker', prevWorker);
    else delete (globalThis as any).Worker;
  }
}

/* ------------------------------------------------------------------------ */
/* IDX-05: MessageDatabase writes settle (and fall back to memory) when the  */
/* transaction fires only `abort`; a failed open is not cached forever.      */
/* ------------------------------------------------------------------------ */
async function idx05WritesSettleOnAbort(): Promise<void> {
  const restoreIdb = installFakeIndexedDB({ outcome: 'abortAfterSuccess' });
  try {
    const mdb = new MessageDatabase();
    const m = msg('abort_1', 'chan1', 'quota');
    const snap = new InvertedIndex(16).exportSnapshot();
    const ops: Array<[string, () => Promise<void>]> = [
      ['saveMessages', () => mdb.saveMessages([m])],
      ['deleteMessages', () => mdb.deleteMessages(['abort_1'])],
      ['clearAll', () => mdb.clearAll()],
      ['saveIndexSnapshot', () => mdb.saveIndexSnapshot(snap)],
      ['setChannelSyncState', () => mdb.setChannelSyncState({ channelId: 'chan1', messageCount: 1, lastSyncTimestamp: 1 })],
    ];
    const hung: string[] = [];
    for (const [name, run] of ops) {
      const out = await withTimeout(run().then(() => 'SETTLED', () => 'SETTLED'), 300);
      if (out === 'TIMEOUT') hung.push(name);
    }
    assert(hung.length === 0, `IDX-05 never settled after the transaction fired only \`abort\`: [${hung.join(',')}]`);
    const fb = mdb as any;
    assert(fb.memoryFallbackSnapshot === snap, 'IDX-05 saveIndexSnapshot reported success although its transaction aborted (no memory fallback)');
    assert(fb.memoryFallbackSync.has('chan1'), 'IDX-05 setChannelSyncState reported success although its transaction aborted (no memory fallback)');
  } finally {
    restoreIdb();
  }
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  delete (globalThis as any).indexedDB;
  try {
    const mdb = new MessageDatabase();
    await mdb.saveMessages([msg('open_fail', 'chan1', 'x')]);
    assert((mdb as any).dbPromise === null, 'IDX-05 a failed IndexedDB open stays cached, so every later call uses the memory fallback');
  } finally {
    if (prev) Object.defineProperty(globalThis, 'indexedDB', prev);
  }
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['IDX-03 saveSession waits for commit; abort reaches localStorage fallback', idx03SaveSessionWaitsForCommit],
  ['IDX-02 channelIds:[] matches nothing; undefined = no filter', idx02EmptyChannelAllowlistMatchesNothing],
  ['IDX-02 channelIds:[] + authorId matches nothing', idx02EmptyAllowlistPlusAuthorMatchesNothing],
  ['IDX-04 localStorage-fallback sessions merged by id, newest wins', idx04MergesLocalStorageSessions],
  ['IDX-07 ingest exception rejects the request', idx07IngestErrorRejects],
  ['IDX-07 worker error rejects pending requests', idx07WorkerErrorRejectsPending],
  ['IDX-05 MessageDatabase writes settle on abort-only transactions', idx05WritesSettleOnAbort],
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
