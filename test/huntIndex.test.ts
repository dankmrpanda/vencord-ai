/*
 * Regression tests for the approved index/storage fixes (prefix IDX): IDX-02, IDX-03, IDX-04.
 * Cases that patch globals (indexedDB, localStorage) restore them in `finally`.
 */

import { getSessionById, getSessionsForChannel, saveSession } from '../storage/chatHistory';
import { InvertedIndex } from '../storage/index/invertedIndex';
import { extractQueryTokens, tokenizeText } from '../storage/index/tokenizer';
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

/* ------------------------------------------------------------------------ */
/* IDX-08: importSnapshot validates before touching live state, checks the   */
/* version, and survives a JSON round trip (typed arrays -> plain objects).  */
/* ------------------------------------------------------------------------ */
function idx08Source(): InvertedIndex {
  const src = new InvertedIndex(16);
  src.addBatch([msg('s1', 'chan1', 'alpha beta'), msg('s2', 'chan2', 'gamma delta')]);
  return src;
}

async function idx08BadSnapshotLeavesStateIntact(): Promise<void> {
  const snap = idx08Source().exportSnapshot();
  const bad: Array<[string, unknown]> = [
    ['postings missing', { ...snap, postings: undefined }],
    ['version 99', { ...snap, version: 99 }],
    ['negative docId', { ...snap, documents: snap.documents.map((d) => ({ ...d, docId: -1 })) }],
    ['documents not an array', { ...snap, documents: null }],
  ];
  for (const [label, candidate] of bad) {
    const live = new InvertedIndex(16);
    live.addBatch([msg('keep1', 'chan9', 'keepme')]);
    let threw = false;
    try {
      live.importSnapshot(candidate as any);
    } catch {
      threw = true;
    }
    const hits = live.search({ query: 'keepme', channelIds: ['chan9'], limit: 10, boostRecency: 0 }).hits.length;
    const total = live.getStats().totalDocs;
    assert(threw && hits === 1 && total === 1, `IDX-08 importSnapshot(${label}): threw=${threw}, previous doc hits=${hits}, totalDocs=${total} (expected: rejected, previous state intact)`);
  }
  const noMaps = new InvertedIndex(16);
  noMaps.importSnapshot({ ...snap, channelDocMap: undefined, authorDocMap: undefined } as any);
  const ch = noMaps.search({ query: 'alpha', channelIds: ['chan1'], limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  assert(ch.join(',') === 's1', `IDX-08 channel filter after importing a snapshot without channelDocMap returned [${ch.join(',')}] (expected [s1]: maps derived from documents)`);
}

async function idx08JsonRoundTripSnapshot(): Promise<void> {
  const json = JSON.parse(JSON.stringify(idx08Source().exportSnapshot()));
  const dst = new InvertedIndex(16);
  dst.addBatch([msg('keep1', 'chan9', 'keepme')]);
  let threw = false;
  try {
    dst.importSnapshot(json);
  } catch {
    threw = true;
  }
  if (threw) {
    const hits = dst.search({ query: 'keepme', limit: 10, boostRecency: 0 }).hits.length;
    assert(hits === 1, 'IDX-08 importSnapshot rejected a JSON snapshot but cleared the live index');
    return;
  }
  dst.addBatch([msg('newone', 'chan1', 'newone')]);
  const a = dst.search({ query: 'alpha', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  const n = dst.search({ query: 'newone', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  const total = dst.getStats().totalDocs;
  assert(a.join(',') === 's1' && n.join(',') === 'newone' && total === 3, `IDX-08 after importing a JSON-round-tripped snapshot: search('alpha') -> [${a.join(',')}], search('newone') -> [${n.join(',')}], totalDocs=${total} (expected [s1], [newone], 3)`);
}

/* ------------------------------------------------------------------------ */
/* IDX-06: mutating requests apply in issue order, so a CLEAR or DELETE sent */
/* while a multi-chunk ingest is running is not undone by later chunks.      */
/* ------------------------------------------------------------------------ */
function idx06Batch(n: number): DiscordMessage[] {
  return Array.from({ length: n }, (_, i) => msg(`del_${i}`, 'chan1', `filler message number ${i}`));
}

async function idx06MutationsApplyInOrder(): Promise<void> {
  const bridge = new WorkerBridge();
  try {
    await bridge.clear();
    const ingest = bridge.ingestBatch(idx06Batch(1200));
    await bridge.clear();
    await ingest;
    const afterClear = (await bridge.getStats()).totalDocs;
    assert(afterClear === 0, `IDX-06 clear() issued after ingestBatch(1200) left ${afterClear} docs in the index (expected 0: requests should apply in order)`);

    const ingest2 = bridge.ingestBatch(idx06Batch(1200));
    const del = await bridge.deleteMessages(['del_1100']);
    await ingest2;
    const snap = await bridge.createSnapshot();
    const resurrected = snap.documents.some((d) => d.id === 'del_1100');
    assert(del.deletedCount === 1 && !resurrected, `IDX-06 deleteMessages(['del_1100']) issued after ingestBatch returned deletedCount=${del.deletedCount}; still indexed afterwards: ${resurrected} (expected 1, false)`);
  } finally {
    await bridge.clear();
  }
}

/* ------------------------------------------------------------------------ */
/* IDX-09: re-adding an id with changed content (an edit) replaces the old   */
/* text; an identical re-add stays a no-op.                                  */
/* ------------------------------------------------------------------------ */
async function idx09EditedMessageReplacesOld(): Promise<void> {
  const index = new InvertedIndex(16);
  index.addBatch([msg('m1', 'chan1', 'original wording here'), msg('m2', 'chan1', 'wording elsewhere')]);
  const same = index.addBatch([msg('m1', 'chan1', 'original wording here')]);
  assert(same === 0, `IDX-09 identical re-add returned ${same} (expected 0: no-op)`);
  const edited = index.addBatch([msg('m1', 'chan1', 'edited replacement wording')]);
  const repl = index.search({ query: 'replacement', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  const orig = index.search({ query: 'original', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  const wording = index.search({ query: 'wording', limit: 10, boostRecency: 0 }).records.map((r) => r.id).sort();
  const stats = index.getStats();
  assert(edited === 1 && repl.join(',') === 'm1' && orig.length === 0 && wording.join(',') === 'm1,m2' && stats.totalDocs === 2,
    `IDX-09 addBatch with an edited message (same id) returned added=${edited}; search('replacement') -> [${repl.join(',')}], search('original') -> [${orig.join(',')}], search('wording') -> [${wording.join(',')}], totalDocs=${stats.totalDocs} (expected 1, [m1], [], [m1,m2], 2)`);
  // Two copies of one id in the same batch: the later (edited) copy wins.
  index.addBatch([msg('m3', 'chan1', 'first draft'), msg('m3', 'chan1', 'second draft')]);
  const draft = index.search({ query: 'draft', limit: 10, boostRecency: 0 }).records.map((r) => r.content);
  const first = index.search({ query: 'first', limit: 10, boostRecency: 0 }).hits.length;
  assert(draft.join(',') === 'second draft' && first === 0, `IDX-09 in-batch edit: search('draft') -> [${draft.join(',')}], search('first') hits=${first} (expected [second draft], 0)`);
}

/* ------------------------------------------------------------------------ */
/* IDX-12 / IDX-10: tokens are NFC-normalized; emoji and other supplementary */
/* symbols separate words (supplementary letters still do not); snapshots    */
/* built by the old tokenizer are rejected (version bump).                   */
/* ------------------------------------------------------------------------ */
async function idx12UnicodeNormalization(): Promise<void> {
  const index = new InvertedIndex(16);
  index.addBatch([msg('nfd', 'chan1', 'cafe\u0301 opening'), msg('nfc', 'chan1', 'na\u00efve plan')]);
  const nfcQuery = index.search({ query: 'caf\u00e9', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  const nfdQuery = index.search({ query: 'nai\u0308ve', limit: 10, boostRecency: 0 }).records.map((r) => r.id);
  assert(nfcQuery.join(',') === 'nfd' && nfdQuery.join(',') === 'nfc', `IDX-12 NFC query "caf\\u00e9" -> [${nfcQuery.join(',')}] for NFD content, NFD query "nai\\u0308ve" -> [${nfdQuery.join(',')}] for NFC content (expected [nfd], [nfc])`);
  const snap = index.exportSnapshot();
  let rejected = false;
  try {
    new InvertedIndex(16).importSnapshot({ ...snap, tokenizerVersion: undefined });
  } catch {
    rejected = true;
  }
  assert(snap.tokenizerVersion === 2 && rejected, `IDX-12 snapshot tokenizerVersion is ${snap.tokenizerVersion} and a snapshot from the old tokenizer was ${rejected ? 'rejected' : 'accepted'} (expected 2, old rejected)`);
}

async function idx10EmojiSeparatesWords(): Promise<void> {
  const terms = tokenizeText('deploy\u{1F525} broke prod').terms;
  const query = extractQueryTokens('deploy\u{1F525} failed');
  const vs = tokenizeText('\u2764\uFE0F love').terms;
  const extB = tokenizeText('\u{20000}\u{20001} test').terms;
  const index = new InvertedIndex(16);
  index.addBatch([msg('e1', 'chan1', 'deploy\u{1F525} broke prod')]);
  const hits = index.search({ query: 'deploy', limit: 10, boostRecency: 0 }).hits.length;
  assert(terms.join(',') === 'deploy,broke,prod' && query.join(',') === 'deploy,failed' && vs.join(',') === 'love' && hits === 1,
    `IDX-10 tokenizeText('deploy\u{1F525} broke prod') -> [${terms.join(',')}], extractQueryTokens('deploy\u{1F525} failed') -> [${query.join(',')}], tokenizeText('\u2764\uFE0F love') -> [${vs.join(',')}], search('deploy') hits=${hits} (expected [deploy,broke,prod], [deploy,failed], [love], 1)`);
  assert(extB.includes('\u{20000}\u{20001}'), `IDX-10 supplementary-plane letters (CJK Ext. B) must stay word characters (got [${extB.join(',')}])`);
}

/* ------------------------------------------------------------------------ */
/* IDX-13: equal scores are tie-broken by message id (newer snowflake first), */
/* not by internal docId history.                                            */
/* ------------------------------------------------------------------------ */
async function idx13StableTieBreak(): Promise<void> {
  const ids = ['998', '1000', '1001', '1002', '1003', '1004'];
  const a = new InvertedIndex(16);
  a.addBatch(ids.map((id) => msg(id, 'chan1', 'tie word')));
  const b = new InvertedIndex(16);
  b.addBatch([...ids].reverse().map((id) => msg(id, 'chan1', 'tie word')));
  b.deleteMessages(['1003']);
  b.addBatch([msg('1003', 'chan1', 'tie word')]);
  const q = { query: 'tie', limit: 3, boostRecency: 0 };
  const ra = a.search(q).hits.map((h) => h.messageId);
  const rb = b.search(q).hits.map((h) => h.messageId);
  assert(ra.join(',') === '1004,1003,1002' && rb.join(',') === ra.join(','), `IDX-13 equal-score top-3: insertion order A -> [${ra.join(',')}], reversed + re-added B -> [${rb.join(',')}] (expected both [1004,1003,1002]: newer message id first)`);
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['IDX-03 saveSession waits for commit; abort reaches localStorage fallback', idx03SaveSessionWaitsForCommit],
  ['IDX-02 channelIds:[] matches nothing; undefined = no filter', idx02EmptyChannelAllowlistMatchesNothing],
  ['IDX-02 channelIds:[] + authorId matches nothing', idx02EmptyAllowlistPlusAuthorMatchesNothing],
  ['IDX-04 localStorage-fallback sessions merged by id, newest wins', idx04MergesLocalStorageSessions],
  ['IDX-07 ingest exception rejects the request', idx07IngestErrorRejects],
  ['IDX-07 worker error rejects pending requests', idx07WorkerErrorRejectsPending],
  ['IDX-05 MessageDatabase writes settle on abort-only transactions', idx05WritesSettleOnAbort],
  ['IDX-08 invalid or wrong-version snapshot leaves live state intact', idx08BadSnapshotLeavesStateIntact],
  ['IDX-08 JSON round-tripped snapshot imports correctly', idx08JsonRoundTripSnapshot],
  ['IDX-06 CLEAR/DELETE during a chunked ingest apply in order', idx06MutationsApplyInOrder],
  ['IDX-09 edited message (same id) replaces the old text', idx09EditedMessageReplacesOld],
  ['IDX-12 tokens NFC-normalized; snapshot version bumped', idx12UnicodeNormalization],
  ['IDX-10 emoji and variation selectors separate words', idx10EmojiSeparatesWords],
  ['IDX-13 equal scores tie-break by message id', idx13StableTieBreak],
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
