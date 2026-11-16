/*
 * Phase 1 hunt repro tests for the search-retrieval area (prefix SRCH).
 * Every case here is expected to be RED until the matching finding is fixed.
 * No catastrophic regex is ever executed here; ReDoS timings live in a child-process harness.
 */

import { RestAPI } from '@webpack/common';
import { compileRegexSafely, fetchDiscordMessagesApi, fetchRecentMessages, fetchSurroundingMessages, filterMessagesLocally } from '../discord/messages';
import { detectPatternFromQuery, searchDiscordMessages } from '../discord/search';
import { runMessageSearch } from '../discord/searchPipeline';
import { STRUCTURED_PATTERNS } from '../storage/regex';
import { HybridRetrievalEngine } from '../storage/retrieval';
import { StoredMessageRecord } from '../storage/index/types';
import { ChannelType, CurrentScopeContext, DiscordMessage } from '../types';
import { assert } from './assert';

const DM = '100000000000000001';
const GUILD = '500000000000000005';
const GUILD_CH = '600000000000000006';

function dmScope(): CurrentScopeContext {
  return {
    channelId: DM,
    channelName: '@alice',
    channelType: ChannelType.DM,
    isDM: true,
    isGroupDM: false,
    isGuild: false,
    mutualGroupDMs: [],
    explicitMutualGroupDMIds: [],
    scopeMode: 'channel',
    selectedChannelIds: [DM],
    includeMutualGroupDMs: false,
  } as CurrentScopeContext;
}

function guildScope(): CurrentScopeContext {
  return {
    channelId: GUILD_CH,
    channelName: 'general',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: GUILD,
    accessibleGuildChannels: [{ id: GUILD_CH, name: 'general' }],
  } as CurrentScopeContext;
}

const msg = (id: string, channelId: string, content: string, timestamp: string, extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id,
  channel_id: channelId,
  author: { id: '700000000000000007', username: 'fixture' },
  content,
  timestamp,
  attachments: [],
  embeds: [],
  mentions: [],
  ...extra,
});

type Get = (args: { url: string; query: Record<string, string> }) => unknown;

async function withGet<T>(get: Get, run: () => Promise<T>): Promise<T> {
  const original = RestAPI.get;
  try {
    (RestAPI as any).get = async (args: any) => ({ body: get(args) });
    return await run();
  } finally {
    RestAPI.get = original;
  }
}

const isSearch = (url: string) => url.endsWith('/messages/search');

/** SRCH-01: isRegexSafe accepted catastrophic patterns (compile-only check, never executed here). */
async function srch01RedosScreenBypass(): Promise<string | null> {
  const catastrophic = [
    '(\\w|\\d)+$',
    '/(a|A)+$/i',
    '([a-z]|[a-c])+$',
    '(\\w|[0-9])+$',
    '(a+){1,9}b',
    '(a+)?(a+)?(a+)?(a+)?(a+)?(a+)?(a+)?(a+)?b',
    'a*[a-z]*a*[a-z]*a*[a-z]*b',
    '\\w+\\s*\\w+!',
    '\\w+-?\\w+-?\\w+-?\\w+!',
    '\\w+a\\w+!',
    '/(α|Α)+$/i',
    '[α-ω]+[α-χ]*[α-ω]+!',
  ];
  const detectorQueries = ['6-digit', '4 to 8 digits', 'at least 5 digits', 'up to 6 digits', '2fa code', '4-digit pin', 'phone numbers', 'emails', 'hex colors', 'ip address', 'numbers'];
  const mustPass = [
    ...Object.values(STRUCTURED_PATTERNS),
    ...detectorQueries.map((query) => detectPatternFromQuery(query).pattern as string),
    '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
    'https?://\\S+',
    '\\$\\d+(?:\\.\\d{2})?',
    '(\\d{3}-){2}\\d{4}',
    '(foo|bar)+',
    '\\w+@\\w+\\.com',
    '\\d+\\s+\\d+',
    '.*invoice.*',
    '/hello/i',
  ];
  const accepted = catastrophic.filter((p) => compileRegexSafely(p) !== null);
  const rejected = mustPass.filter((p) => compileRegexSafely(p) === null).map(String);
  const long = 'a'.repeat(20_000);
  const capped = filterMessagesLocally([msg('100000000000000099', DM, `${long} tailneedle`, new Date().toISOString())], { pattern: 'tailneedle' });
  const problems: string[] = [];
  if (accepted.length) problems.push(`accepted catastrophic patterns: ${accepted.join('  ')}`);
  if (rejected.length) problems.push(`rejected safe patterns: ${rejected.join('  ')}`);
  if (capped.length) problems.push('regex text was not capped (matched a token past 20k chars)');
  return problems.length ? problems.join('; ') : null;
}

/**
 * ReDoS screen corpus, compile-only (nothing here is executed). Each must-reject entry records the blow-up measured
 * in a killed child process; each must-pass entry newly accepted by a fix records its worst case on 4,000 chars.
 */
const REDOS_CORPUS: Array<{ id: string; pattern: string; expect: 'reject' | 'pass'; measured: string }> = [
  { id: 'REV-DSC-01', pattern: '(a{1,10}){1,10}b', expect: 'reject', measured: ">10 s on 'a' x40" },
  { id: 'REV-DSC-01', pattern: 'a{0,1000}a{0,1000}a{0,1000}b', expect: 'reject', measured: ">10 s on 'a' x1000" },
  { id: 'REV-DSC-01', pattern: '\\w{1,500}\\w{1,500}\\w{1,500}!', expect: 'reject', measured: ">10 s on 'a' x1500" },
  { id: 'REV-DSC-01', pattern: '(\\w{1,9}\\s?){1,9}$', expect: 'reject', measured: ">10 s on 'a' x60 + '!'" },
  { id: 'REV-DSC-01', pattern: '\\w{0,100}\\w{0,100}\\w{0,100}!', expect: 'reject', measured: "6.1 s on 'a' x4000" },
  { id: 'REV-DSC-01', pattern: '(\\d{3}-){2}\\d{4}', expect: 'pass', measured: 'fixed width, passed before' },
  { id: 'REV-DSC-01', pattern: '(\\d{1,3}\\.){3}\\d{1,3}', expect: 'pass', measured: 'separated by \\., passed before' },
  { id: 'REV-DSC-01', pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}', expect: 'pass', measured: 'separated by \\., passed before' },
  { id: 'REV-DSC-01', pattern: '\\+?\\d{1,3}[ -]?\\d{3}[ -]?\\d{4}', expect: 'pass', measured: 'passed before' },
  { id: 'REV-DSC-01', pattern: '[A-Z]{2,5}-\\d{1,6}', expect: 'pass', measured: 'passed before' },
  { id: 'REV-DSC-01', pattern: 'https?://(www\\.)?\\S+', expect: 'pass', measured: 'passed before' },
  { id: 'REV-DSC-01', pattern: '\\d{1,2}:\\d{2}', expect: 'pass', measured: 'passed before' },
  { id: 'REV-DSC-02', pattern: '(\\d+\\.){3}\\d+', expect: 'pass', measured: "8.6 ms on ('1' x1000 + '.') x3 + 'x' x997" },
  { id: 'REV-DSC-02', pattern: '(\\w+ ){2}\\w+', expect: 'pass', measured: "11.8 ms on 'a' x2000 + ' ' + 'a' x1999" },
  { id: 'REV-DSC-02', pattern: '(?:\\s*\\w+){2}', expect: 'pass', measured: "10.7 ms on ' ' x3998 + 'a!'" },
  { id: 'REV-DSC-02', pattern: '(?:\\w+ ){5}\\w+!', expect: 'pass', measured: "7.1 ms on 'a' x4000" },
  { id: 'REV-DSC-02', pattern: '(?:\\w+\\.){9}x', expect: 'pass', measured: "6.2 ms on 'a' x4000" },
  { id: 'REV-DSC-02', pattern: '(?:\\s*\\w+){2}!', expect: 'reject', measured: "7.8 s on 'a' x4000" },
  { id: 'REV-DSC-02', pattern: '(?:\\s*\\w+){19}', expect: 'reject', measured: "719 ms on ('a' x18 + '!') x210" },
  { id: 'REV-DSC-02', pattern: '(\\w+\\s?){2}!', expect: 'reject', measured: ">10 s on 'a' x4000" },
  { id: 'REV-DSC-02', pattern: 'a.*b.*c', expect: 'reject', measured: "3.6 s on 'ab' x2000 (kept rejected: polynomial)" },
  { id: 'REV-DSC-02', pattern: 'foo.*bar.*baz', expect: 'reject', measured: "323 ms on 'foobar' x666 (kept rejected: polynomial)" },
  { id: 'REV-DSC-02', pattern: '.*a.*b', expect: 'reject', measured: "8.5 s on 'a' x4000 (kept rejected: polynomial)" },
  { id: 'RPT6-2d', pattern: '[aα-ω]+[bα-ω]+[cα-ω]+!', expect: 'reject', measured: "1.0 s on 'α' x300, >10 s on 'α' x1000" },
  { id: 'RPT6-2d', pattern: '[a\\u03b1-\\u03c9]+[b\\u03b1-\\u03c9]+[c\\u03b1-\\u03c9]+!', expect: 'reject', measured: "1.1 s on 'α' x300" },
  { id: 'RPT6-2d', pattern: '[aα-ω]+[bβ-ψ]+!', expect: 'reject', measured: "8.8 s on 'β' x4000" },
  { id: 'RPT6-2d', pattern: '[a\\x80-\\xff]+[b\\s]+!', expect: 'reject', measured: ">10 s on U+00A0 x4000" },
  { id: 'RPT6-2d', pattern: '/[aΑ-Ω]+[bα-ω]+!/i', expect: 'reject', measured: ">10 s on 'α' x4000" },
  { id: 'RPT6-2d', pattern: '[α-ω]+ [α-ω]+!', expect: 'pass', measured: 'separated by a space, passed before' },
  { id: 'RPT6-2d', pattern: '/\\p{L}+@\\p{L}+/u', expect: 'pass', measured: 'separated by @, passed before' },
  { id: 'RPT6-2d', pattern: '[a-zà-ÿ]+\\d+', expect: 'pass', measured: 'disjoint classes, passed before' },
  { id: 'REV3-01', pattern: '^(a(b|bc)|c)+$', expect: 'reject', measured: "17.5 s on 'abc' x28 + '!'" },
  { id: 'REV3-01', pattern: '(a(b|bc)|c)+!', expect: 'reject', measured: "13.2 s on 'abc' x26" },
  { id: 'REV3-01', pattern: '(?:x(?:y|yz)|z)*!', expect: 'reject', measured: 'same shape as above' },
  { id: 'REV3-01', pattern: '(foo|bar)+', expect: 'pass', measured: 'distinct branches, passed before' },
  { id: 'REV3-01', pattern: '(?:(?:jan|feb) \\d{1,2}),?', expect: 'pass', measured: 'alternation not repeated, passed before' },
  { id: 'REV3-02', pattern: '(a+)\\1*\\1*\\1*\\1*b', expect: 'reject', measured: "39.2 s on 'a' x200" },
  { id: 'REV3-02', pattern: '(a)\\1+\\1+!', expect: 'reject', measured: 'quantified backreferences overlap' },
  { id: 'REV3-02', pattern: '(?<x>a)\\k<x>*\\k<x>*!', expect: 'reject', measured: 'named form of the same shape' },
  { id: 'REV3-02', pattern: '(\\w)\\1', expect: 'pass', measured: 'unquantified backreference, passed before' },
  { id: 'REV3-03', pattern: '/[\\p{sc=Thai}a]*[\\p{sc=Thai}b]*[\\p{sc=Thai}c]*[\\p{sc=Thai}d]*[\\p{sc=Thai}e]*!/u', expect: 'reject', measured: "1.5 s on Thai x90" },
  { id: 'REV3-03', pattern: '/[\\P{L}a]+[\\P{L}b]+!/u', expect: 'reject', measured: 'negated property classes share every non-letter' },
  { id: 'REV3-03', pattern: '/[\\p{L}]+@[\\p{L}]+/u', expect: 'pass', measured: 'separated by @' },
];

function redosCorpusProblems(id: string): string | null {
  const wrong = REDOS_CORPUS
    .filter((entry) => entry.id === id && (compileRegexSafely(entry.pattern) !== null) !== (entry.expect === 'pass'))
    .map((entry) => `${entry.expect === 'reject' ? 'accepted' : 'rejected'} ${entry.pattern}`);
  return wrong.length ? wrong.join('  ') : null;
}

/** REV-DSC-01: the screen only checked overlap for unbounded quantifiers, so bounded ones like {1,500} slipped through. */
async function revDsc01BoundedQuantifierRedos(): Promise<string | null> {
  return redosCorpusProblems('REV-DSC-01');
}

/** REV-DSC-02: a finitely repeated group with an unbounded body was rejected even when a mandatory separator makes it linear. */
async function revDsc02SeparatedRepeatedGroup(): Promise<string | null> {
  return redosCorpusProblems('REV-DSC-02');
}

/** Report section 6 (2d): overlap was judged on a fixed character sample, so classes overlapping only outside it passed. */
async function rpt6SampleCharOverlap(): Promise<string | null> {
  return redosCorpusProblems('RPT6-2d');
}

/** REV3-01..03 (confirmation review): ambiguous nested alternation, quantified backreferences, property-escape classes. */
async function rev3RedosScreenGaps(): Promise<string | null> {
  const problems = ['REV3-01', 'REV3-02', 'REV3-03']
    .map((id) => redosCorpusProblems(id))
    .filter((problem): problem is string => problem !== null);
  return problems.length ? problems.join('  ') : null;
}

/** SRCH-02: has='sticker' has no local implementation, so local scan returns every message. */
async function srch02StickerFilterPassesEverything(): Promise<string | null> {
  const plain = msg('110000000000000011', DM, 'no sticker here', new Date().toISOString());
  const unit = filterMessagesLocally([plain], { has: 'sticker' });
  const result = await withGet(
    ({ url }) => (isSearch(url) ? { total_results: 0, messages: [] } : [plain]),
    () => runMessageSearch({ has: 'sticker', limit: 10, scanLimit: 10 }, dmScope()),
  );
  const returned = result.data?.messages.map((m) => m.id) || [];
  const problems: string[] = [];
  if (unit.length || returned.length) {
    problems.push(`filterMessagesLocally kept ${unit.length}, pipeline returned ${JSON.stringify(returned)} for a sticker-less message (expected none)`);
  }
  const withItems = msg('110000000000000012', DM, 'sticker', new Date().toISOString(), { sticker_items: [{ id: '1', name: 'wave', format_type: 1 }] } as any);
  const withLegacy = msg('110000000000000013', DM, 'sticker', new Date().toISOString(), { stickers: [{ id: '2', name: 'hi' }] } as any);
  const kept = filterMessagesLocally([withItems, withLegacy], { has: 'sticker' }).map((m) => m.id);
  if (kept.length !== 2) problems.push(`sticker messages kept ${JSON.stringify(kept)} (expected both)`);
  const remoteSticker = { ...withItems, id: '110000000000000014', hit: true } as DiscordMessage;
  const pipeline = await withGet(
    ({ url }) => (isSearch(url) ? { total_results: 1, messages: [[remoteSticker]] } : [withItems, plain]),
    () => runMessageSearch({ has: 'sticker', limit: 10, scanLimit: 10 }, dmScope()),
  );
  const pipelineIds = (pipeline.data?.messages.map((m) => m.id) || []).sort();
  if (JSON.stringify(pipelineIds) !== JSON.stringify([withItems.id, remoteSticker.id])) {
    problems.push(`pipeline has=sticker returned ${JSON.stringify(pipelineIds)} (expected the remote and local sticker messages only)`);
  }
  const unknown = filterMessagesLocally([withItems, plain], { has: 'poll' as any });
  if (unknown.length) problems.push(`unknown has='poll' kept ${unknown.length} message(s) (expected fail closed)`);
  return problems.length ? problems.join('; ') : null;
}

/** SEC-08: an emptied channel allowlist reached the index as [] and was read as "no channel filter". */
async function sec08IndexAllowlistEmptiedFailsOpen(): Promise<string | null> {
  const record = (id: string, channelId: string): StoredMessageRecord => ({
    docId: Number(id.slice(-3)) as any, id, channelId, guildId: GUILD, authorId: '700000000000000007', authorName: 'fixture',
    timestamp: Date.UTC(2025, 0, 1), content: 'allowneedle', tokenLength: 1, flags: 0,
  });
  const THREAD = '610000000000000061';
  const OTHER = '620000000000000062';
  const docs = [record('180000000000000001', THREAD), record('180000000000000002', GUILD_CH), record('180000000000000003', OTHER)];
  const sent: Array<string[] | undefined> = [];
  // Models the index before its own fix: an empty or missing channelIds list applies no channel filter.
  const bridge: any = {
    search: async (q: { channelIds?: string[] }) => {
      sent.push(q.channelIds);
      const rows = q.channelIds?.length ? docs.filter((d) => q.channelIds!.includes(d.channelId)) : docs;
      return { hits: rows.map((d, i) => ({ docId: d.docId, messageId: d.id, score: 1 - i * 0.1, bm25Score: 1 - i * 0.1, exactBonus: 0, recencyBonus: 0 })), records: rows };
    },
    createSnapshot: async () => ({ documents: docs }),
  };
  const engine = new HybridRetrievalEngine(bridge);
  const scope = (mode: 'channel' | 'server' | 'custom', selected?: string[]): CurrentScopeContext => ({
    ...guildScope(), channelId: THREAD, scopeMode: mode, selectedChannelIds: selected,
  } as CurrentScopeContext);
  const problems: string[] = [];
  const check = async (label: string, run: () => Promise<{ hits: Array<{ channelId?: string; record?: StoredMessageRecord }> }>, allowed: string[]) => {
    sent.length = 0;
    const res = await run();
    const channels = res.hits.map((h: any) => h.record?.channelId ?? h.channelId);
    const leaked = channels.filter((c) => !allowed.includes(c));
    if (leaked.length) problems.push(`${label}: returned hits from ${JSON.stringify(leaked)}`);
    if (sent.some((ids) => ids !== undefined && ids.length === 0)) problems.push(`${label}: index received channelIds=[]`);
  };
  await check('server mode, unpermitted channelIds', () => engine.search({ query: 'allowneedle', channelIds: [OTHER] }, scope('server')), []);
  await check('server mode, sentinel channelIds', () => engine.search({ query: 'allowneedle', channelIds: ['__FORBIDDEN_SCOPE_BLOCKED__'] }, scope('server')), []);
  await check('server mode, active thread only', () => engine.search({ query: 'allowneedle', channelIds: [THREAD] }, scope('server')), [THREAD]);
  await check('custom mode, unpermitted channelIds', () => engine.search({ query: 'allowneedle', channelIds: [OTHER] }, scope('custom', [GUILD_CH])), []);
  await check('channel mode, no channelIds', () => engine.search({ query: 'allowneedle' }, scope('channel')), [THREAD]);
  await check('no scope, empty channelIds, pattern-only snapshot', () => engine.search({ pattern: 'allowneedle', channelIds: [] }), []);
  return problems.length ? problems.join('; ') : null;
}

/** SRCH-04: nextOffset pagination skips and repeats results, and stops early when limit > 25. */
async function srch04OffsetPagination(): Promise<string | null> {
  const corpus: DiscordMessage[] = [];
  // Discord relevance order = corpus order; timestamps deliberately not monotonic.
  for (let i = 0; i < 40; i++) {
    const ts = new Date(Date.UTC(2025, 0, 1) + ((i * 17) % 40) * 3600_000).toISOString();
    corpus.push(msg(String(130000000000000000n + BigInt(i)), DM, `pagerneedle item ${i}`, ts, { hit: true }));
  }
  const page = (query: Record<string, string>) => {
    const offset = Number(query.offset || 0);
    return { total_results: corpus.length, messages: corpus.slice(offset, offset + 25).map((m) => [m]) };
  };
  const problems: string[] = [];
  await withGet(({ url, query }) => (isSearch(url) ? page(query) : []), async () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    for (let n = 0; n < 6 && offset !== undefined; n++) {
      const r = await runMessageSearch({ query: 'pagerneedle', sortBy: 'relevance', offset, limit: 10, scanLimit: 10 }, dmScope());
      seen.push(...(r.data?.messages.map((m) => m.id) || []));
      offset = r.pagination?.nextOffset;
    }
    const unique = new Set(seen);
    if (seen.length !== unique.size || unique.size !== corpus.length) {
      problems.push(`limit=10: paged ${seen.length} ids, ${seen.length - unique.size} duplicates, ${corpus.length - unique.size} of ${corpus.length} never shown`);
    }
    const big = await runMessageSearch({ query: 'pagerneedle2', limit: 50, scanLimit: 50 }, dmScope());
    if (big.pagination?.nextOffset === undefined) {
      problems.push(`limit=50: Discord returned 25 of total_results=${corpus.length} but nextOffset is undefined`);
    }
  });
  return problems.length ? problems.join('; ') : null;
}

/** REV-DSC-03: a failed remote search on a later page was reported as "no matches", ending pagination silently. */
async function revDsc03FailedLaterPage(): Promise<string | null> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await withGet(({ url }) => {
      if (isSearch(url)) throw { status: 429, body: { retry_after: 30 } };
      return [];
    }, async () => {
      const r = await runMessageSearch({ query: 'pagefailneedle', sortBy: 'relevance', offset: 25, limit: 10, scanLimit: 10 }, dmScope());
      return r.ok === false && r.code !== 'empty_results' && /retry/i.test(r.summary)
        ? null
        : `offset 25 with a failing remote search returned ok=${r.ok} code=${r.code} summary="${r.summary}"`;
    });
  } finally {
    console.warn = warn;
  }
}

/** SRCH-05: ordinary keywords are hijacked into a regex filter (e.g. "ip"). */
async function srch05KeywordHijackedIntoPattern(): Promise<string | null> {
  const target = msg('140000000000000014', DM, 'my ip ban appeal was denied', new Date().toISOString(), { hit: true });
  const sent: string[] = [];
  const result = await withGet(
    ({ url, query }) => {
      if (isSearch(url)) { sent.push(String(query.content)); return { total_results: 1, messages: [[target]] }; }
      return [];
    },
    () => runMessageSearch({ query: 'ip ban appeal', limit: 10, scanLimit: 10 }, dmScope()),
  );
  const ids = result.data?.messages.map((m) => m.id) || [];
  if (!ids.includes(target.id)) {
    return `query "ip ban appeal" sent content=${JSON.stringify(sent)} and returned ${JSON.stringify(ids)} (expected the matching message; it was dropped by an implicit IPv4 regex)`;
  }
  for (const plain of ['auth error', 'verification level', 'server verification', 'pin this message', 'pins', 'ips']) {
    const detected = detectPatternFromQuery(plain);
    if (detected.pattern) return `plain keywords "${plain}" became pattern ${detected.pattern} (cleanedQuery "${detected.cleanedQuery}")`;
  }
  for (const phrase of ['2fa code', 'otp', 'verification code', 'auth token', 'pin code', 'pin numbers', 'ip addresses', 'ipv4']) {
    if (!detectPatternFromQuery(phrase).pattern) return `descriptor phrase "${phrase}" no longer detected as a pattern`;
  }
  return null;
}

/** SRCH-06: non-ASCII and symbol-bearing keywords are mangled before reaching Discord. */
async function srch06QueryMangling(): Promise<string | null> {
  const sent: string[] = [];
  await withGet(
    ({ url, query }) => { if (isSearch(url)) sent.push(String(query.content)); return isSearch(url) ? { total_results: 0, messages: [] } : []; },
    () => runMessageSearch({ query: 'café', guildWide: true, limit: 10, scanLimit: 10 }, guildScope()),
  );
  const problems: string[] = [];
  if (sent[0] !== 'café') problems.push(`query "café" was sent to Discord as content=${JSON.stringify(sent[0])}`);
  const expected: Array<[string, string]> = [['naïve plan', 'naïve plan'], ['東京 meetup', '東京 meetup'], ['Привет мир', 'привет мир']];
  for (const [query, want] of expected) {
    const got = detectPatternFromQuery(query).cleanedQuery;
    if (got !== want) problems.push(`cleanedQuery(${JSON.stringify(query)}) = ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
  }
  return problems.length ? problems.join('; ') : null;
}

/** SRCH-08: unparseable after/before dates silently drop the bound everywhere. */
async function srch08InvalidDateIgnored(): Promise<string | null> {
  const old = msg('160000000000000016', DM, 'ancient datedneedle', '2019-01-01T12:00:00.000Z');
  const out: string[] = [];
  await withGet(({ url }) => (isSearch(url) ? { total_results: 0, messages: [] } : [old]), async () => {
    for (const afterDate of ['last week', '2024-13-45', '2024-02-30']) {
      const r = await runMessageSearch({ query: 'datedneedle', afterDate, limit: 10, scanLimit: 10 }, dmScope());
      const ids = r.data?.messages.map((m) => m.id) || [];
      if (r.ok || r.code !== 'invalid_date') out.push(`afterDate=${JSON.stringify(afterDate)} returned ${JSON.stringify(ids)} (ok=${r.ok}, code=${r.code})`);
    }
  });
  const valid = await withGet(({ url }) => (isSearch(url) ? { total_results: 0, messages: [] } : [old]), () =>
    runMessageSearch({ query: 'datedneedle', afterDate: '2018-12-31', beforeDate: '2019-01-02T00:00:00Z', limit: 10, scanLimit: 10 }, dmScope()));
  if (!valid.ok) out.push(`valid dates were rejected (code=${valid.code})`);
  return out.length ? `${out.join('; ')} (expected invalid_date)` : null;
}

/** SRCH-09: fractional limits and offsets reach the Discord API as non-integer strings. */
async function srch09FractionalLimit(): Promise<string | null> {
  const problems: string[] = [];
  const limits: string[] = [];
  const page = Array.from({ length: 100 }, (_, i) => msg(String(170000000000000000n + BigInt(i)), DM, 'x', new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString()));
  const got = await withGet(({ query }) => { limits.push(String(query.limit)); return limits.length === 1 ? page : []; }, () => fetchRecentMessages(DM, 150.5));
  if (limits.some((l) => !/^\d+$/.test(l))) problems.push(`fetchRecentMessages(…, 150.5) sent limit=${JSON.stringify(limits)} (got ${got.length})`);
  for (const [limit, want] of [[NaN, '50'], [0.4, '1']] as const) {
    const sent: string[] = [];
    await withGet(({ query }) => { sent.push(String(query.limit)); return []; }, () => fetchRecentMessages(DM, limit));
    if (sent[0] !== want) problems.push(`fetchRecentMessages(…, ${limit}) sent limit=${JSON.stringify(sent)} (expected ${want})`);
  }
  const around: string[] = [];
  await withGet(({ query }) => { around.push(String(query.limit)); return []; }, () => fetchSurroundingMessages(DM, '170000000000000000', 7.5));
  if (around[0] !== '7') problems.push(`fetchSurroundingMessages(…, 7.5) sent limit=${JSON.stringify(around)}`);
  for (const offset of [-5, 2.5]) {
    const sent: Array<string | undefined> = [];
    await withGet(({ query }) => { sent.push(query.offset); return { total_results: 0, messages: [] }; },
      () => searchDiscordMessages({ query: `offsetneedle${offset}`, channelId: DM, offset }));
    if (sent[0] !== undefined) problems.push(`offset=${offset} was sent as ${JSON.stringify(sent[0])}`);
  }
  return problems.length ? problems.join('; ') : null;
}

/** SRCH-10: 429 retries had no retry_after cap, ignored cancellation and slept outside the start queue. */
async function srch10RateLimitRetries(): Promise<string | null> {
  const problems: string[] = [];
  const outerSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  const held: Array<() => void> = [];
  let holdFrom = Infinity;
  // Fake timers: record each delay, hold long ones when asked, fire the rest at once.
  (globalThis as any).setTimeout = (handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    events.push(`timer:${ms}`);
    const fire = () => { if (Number(ms) >= 3000) events.push('waited'); handler(...args); };
    if (Number(ms) >= holdFrom) { held.push(fire); return 0; }
    return outerSetTimeout(fire, 0);
  };
  (globalThis as any).fetch = async () => { throw new Error('network disabled in test'); };
  const rateLimited = (retryAfter: unknown) => Object.assign(new Error('429'), { status: 429, body: { retry_after: retryAfter } });
  const tick = (ms: number) => new Promise((resolve) => outerSetTimeout(resolve, ms));
  try {
    let searches = 0;
    const capped = await withGet(({ url }) => { if (!isSearch(url)) return []; searches++; throw rateLimited(60); },
      () => runMessageSearch({ query: 'cappedneedle', limit: 10, scanLimit: 10 }, dmScope()));
    if (searches !== 1) problems.push(`retry_after=60 sent ${searches} search requests (expected 1, no retry)`);
    if (!capped.ok) problems.push(`retry_after=60 did not fall back (code=${capped.code})`);

    events.length = 0;
    await withGet(({ url, query }) => {
      if (!isSearch(url)) return [];
      events.push(`req:${query.content}`);
      if (events.filter((e) => e.startsWith('req:')).length === 1) throw rateLimited(3);
      return { total_results: 0, messages: [] };
    }, () => Promise.all(['queuedneedle', 'queuedother'].map((query) => searchDiscordMessages({ query, channelId: DM }))));
    const afterLimit = events.slice(events.findIndex((e) => e.startsWith('req:')) + 1);
    const nextReq = afterLimit.findIndex((e) => e.startsWith('req:'));
    if (!afterLimit.slice(0, nextReq).includes('waited')) problems.push(`a queued search started before retry_after=3 elapsed (${JSON.stringify(events)})`);

    holdFrom = 2000;
    const controller = new AbortController();
    let sent = 0;
    const pending = withGet(({ url }) => { if (!isSearch(url)) return []; sent++; throw rateLimited(3); },
      () => runMessageSearch({ query: 'abortneedle', limit: 10, scanLimit: 10 }, dmScope(), controller.signal));
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await tick(20);
    controller.abort();
    const settled = await Promise.race([outcome, tick(200).then(() => 'still sleeping')]);
    held.splice(0).forEach((fire) => fire());
    await tick(20);
    if (settled !== 'rejected' || sent !== 1) problems.push(`abort during a 429 retry wait: ${settled}, ${sent} search requests`);
    holdFrom = Infinity;

    events.length = 0;
    let calls = 0;
    const page = await withGet(() => { if (++calls === 1) throw rateLimited('soon'); return [msg('180000000000000018', DM, 'x', new Date().toISOString())]; },
      () => fetchDiscordMessagesApi(DM, { limit: '1' }));
    const retryDelay = events.find((e) => e.startsWith('timer:'));
    if (page.length !== 1 || retryDelay === undefined || !(Number(retryDelay.slice(6)) >= 1000)) problems.push(`retry_after="soon" retried after ${retryDelay} (expected a finite fallback delay)`);
    calls = 0;
    const cappedPage = await withGet(() => { calls++; throw rateLimited(60); }, () => fetchDiscordMessagesApi(DM, { limit: '1' }));
    if (calls !== 1 || cappedPage.length !== 0) problems.push(`messages retry_after=60 sent ${calls} requests (expected 1, no retry)`);
  } finally {
    globalThis.setTimeout = outerSetTimeout;
    globalThis.fetch = originalFetch;
  }
  // Leave the shared start time in the past for later suites that use real timers.
  await withGet(() => ({ total_results: 0, messages: [] }), () => searchDiscordMessages({ query: 'resetneedle', channelId: DM }));
  return problems.length ? problems.join('; ') : null;
}

/** SRCH-12: the search cache never evicted entries. */
async function srch12SearchCacheUnbounded(): Promise<string | null> {
  const hit = msg('190000000000000019', DM, 'cacheneedle', new Date().toISOString(), { hit: true });
  const sent: string[] = [];
  await withGet(({ query }) => { sent.push(String(query.content)); return { total_results: 1, messages: [[hit]] }; }, async () => {
    for (let i = 0; i <= 100; i++) await searchDiscordMessages({ query: `cacheneedle${i}`, channelId: DM });
    sent.length = 0;
    await searchDiscordMessages({ query: 'cacheneedle100', channelId: DM });
    await searchDiscordMessages({ query: 'cacheneedle0', channelId: DM });
  });
  return sent.length === 1 && sent[0] === 'cacheneedle0'
    ? null
    : `after 101 cached queries, re-running the newest and the oldest reached Discord for ${JSON.stringify(sent)} (expected only the oldest, evicted by the size cap)`;
}

const CASES: Array<[string, () => Promise<string | null>]> = [
  ['SRCH-01 ReDoS screen bypass', srch01RedosScreenBypass],
  ['REV-DSC-01 bounded-quantifier ReDoS', revDsc01BoundedQuantifierRedos],
  ['REV-DSC-02 separated repeated group', revDsc02SeparatedRepeatedGroup],
  ['RPT6-2d sample-character overlap', rpt6SampleCharOverlap],
  ['REV3-01..03 ReDoS screen gaps', rev3RedosScreenGaps],
  ['SRCH-02 has=sticker local filter', srch02StickerFilterPassesEverything],
  ['SEC-08 index allowlist emptied fails open', sec08IndexAllowlistEmptiedFailsOpen],
  ['SRCH-04 offset pagination', srch04OffsetPagination],
  ['REV-DSC-03 failed later page is not empty', revDsc03FailedLaterPage],
  ['SRCH-05 keyword hijacked into pattern', srch05KeywordHijackedIntoPattern],
  ['SRCH-06 query mangling', srch06QueryMangling],
  ['SRCH-08 invalid after_date ignored', srch08InvalidDateIgnored],
  ['SRCH-09 fractional limit', srch09FractionalLimit],
  ['SRCH-10 rate-limit retries', srch10RateLimitRetries],
  ['SRCH-12 search cache unbounded', srch12SearchCacheUnbounded],
];

/** Collapses the 1.2 s search throttle and retry sleeps; restored in finally. */
async function withFastTimers<T>(run: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalSetTimeout(handler, typeof ms === 'number' && ms >= 500 ? 0 : ms, ...args);
  try {
    return await run();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

export async function runHuntSearchTests(): Promise<void> {
  await withFastTimers(runCases);
}

async function runCases(): Promise<void> {
  let failures = 0;
  for (const [name, fn] of CASES) {
    try {
      const problem = await fn();
      if (problem) {
        failures++;
        console.log(`❌ ${name}: ${problem}`);
      } else {
        console.log(`✅ ${name}`);
      }
    } catch (err: any) {
      failures++;
      console.log(`❌ ${name}: threw ${err?.message ?? err}`);
    }
  }
  assert(failures === 0, `${failures} search-retrieval hunt case(s) red`);
}
