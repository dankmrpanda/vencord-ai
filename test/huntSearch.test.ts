/*
 * Phase 1 hunt repro tests for the search-retrieval area (prefix SRCH).
 * Every case here is expected to be RED until the matching finding is fixed.
 * No catastrophic regex is ever executed here; ReDoS timings live in a child-process harness.
 */

import { RestAPI } from '@webpack/common';
import { compileRegexSafely, fetchRecentMessages, filterMessagesLocally } from '../discord/messages';
import { detectPatternFromQuery } from '../discord/search';
import { runMessageSearch } from '../discord/searchPipeline';
import { STRUCTURED_PATTERNS } from '../storage/regex';
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

/** SRCH-02: has='sticker' has no local implementation, so local scan returns every message. */
async function srch02StickerFilterPassesEverything(): Promise<string | null> {
  const plain = msg('110000000000000011', DM, 'no sticker here', new Date().toISOString());
  const unit = filterMessagesLocally([plain], { has: 'sticker' });
  const result = await withGet(
    ({ url }) => (isSearch(url) ? { total_results: 0, messages: [] } : [plain]),
    () => runMessageSearch({ has: 'sticker', limit: 10, scanLimit: 10 }, dmScope()),
  );
  const returned = result.data?.messages.map((m) => m.id) || [];
  if (unit.length || returned.length) {
    return `filterMessagesLocally kept ${unit.length}, pipeline returned ${JSON.stringify(returned)} for a sticker-less message (expected none)`;
  }
  return null;
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
  return null;
}

/** SRCH-06: non-ASCII and symbol-bearing keywords are mangled before reaching Discord. */
async function srch06QueryMangling(): Promise<string | null> {
  const sent: string[] = [];
  await withGet(
    ({ url, query }) => { if (isSearch(url)) sent.push(String(query.content)); return isSearch(url) ? { total_results: 0, messages: [] } : []; },
    () => runMessageSearch({ query: 'café', guildWide: true, limit: 10, scanLimit: 10 }, guildScope()),
  );
  return sent[0] === 'café' ? null : `query "café" was sent to Discord as content=${JSON.stringify(sent[0])}`;
}

/** SRCH-08: unparseable after/before dates silently drop the bound everywhere. */
async function srch08InvalidDateIgnored(): Promise<string | null> {
  const old = msg('160000000000000016', DM, 'ancient datedneedle', '2019-01-01T12:00:00.000Z');
  const out: string[] = [];
  await withGet(({ url }) => (isSearch(url) ? { total_results: 0, messages: [] } : [old]), async () => {
    for (const afterDate of ['last week', '2024-13-45']) {
      const r = await runMessageSearch({ query: 'datedneedle', afterDate, limit: 10, scanLimit: 10 }, dmScope());
      const ids = r.data?.messages.map((m) => m.id) || [];
      if (r.ok && ids.includes(old.id)) out.push(`afterDate=${JSON.stringify(afterDate)} returned a 2019 message (ok=${r.ok}, code=${r.code})`);
    }
  });
  return out.length ? `${out.join('; ')} (expected invalid_date or no match)` : null;
}

/** SRCH-09: fractional limits reach the Discord API as non-integer strings. */
async function srch09FractionalLimit(): Promise<string | null> {
  const limits: string[] = [];
  const page = Array.from({ length: 100 }, (_, i) => msg(String(170000000000000000n + BigInt(i)), DM, 'x', new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString()));
  const got = await withGet(({ query }) => { limits.push(String(query.limit)); return limits.length === 1 ? page : []; }, () => fetchRecentMessages(DM, 150.5));
  const bad = limits.filter((l) => !/^\d+$/.test(l));
  return bad.length ? `fetchRecentMessages(…, 150.5) sent limit=${JSON.stringify(limits)} (got ${got.length})` : null;
}

const CASES: Array<[string, () => Promise<string | null>]> = [
  ['SRCH-01 ReDoS screen bypass', srch01RedosScreenBypass],
  ['SRCH-02 has=sticker local filter', srch02StickerFilterPassesEverything],
  ['SRCH-04 offset pagination', srch04OffsetPagination],
  ['SRCH-05 keyword hijacked into pattern', srch05KeywordHijackedIntoPattern],
  ['SRCH-06 query mangling', srch06QueryMangling],
  ['SRCH-08 invalid after_date ignored', srch08InvalidDateIgnored],
  ['SRCH-09 fractional limit', srch09FractionalLimit],
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
