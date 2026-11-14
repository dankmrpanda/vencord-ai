/*
 * Phase 1 hunt repro tests for the security-scope area (prefix SEC).
 * Each case is a regression test for a SEC finding fixed in this worktree.
 */

import { RestAPI } from '@webpack/common';
import { getMessageDetails } from '../discord/contextTools';
import { formatUntrustedEvidence, sanitizeUntrustedContent, validateChannelPermission } from '../discord/guardrails';
import { getPermittedChannelIdsForScope, isChannelAllowedInScope, restrictScopeForUserPrompt } from '../discord/scope';
import { ChannelType, CurrentScopeContext, DiscordMessage, PluginSettings } from '../types';
import { assert } from './assert';

const ACTIVE_DM = '100000000000000001';
const OTHER_DM = '200000000000000002';

function dmScope(): CurrentScopeContext {
  return {
    channelId: ACTIVE_DM,
    channelName: '@alice',
    channelType: ChannelType.DM,
    isDM: true,
    isGroupDM: false,
    isGuild: false,
    mutualGroupDMs: [],
    explicitMutualGroupDMIds: [],
    accessibleGuildChannels: [],
    scopeMode: 'channel',
    selectedChannelIds: [ACTIVE_DM],
    includeMutualGroupDMs: false,
  } as CurrentScopeContext;
}

/** Resolves a relative REST path the way the browser URL parser (fetch/XHR) does. */
function resolvedApiPath(path: string): string {
  return new URL(`https://discord.com/api/v9${path}`).pathname;
}

async function withRecordedGets<T>(
  respond: (url: string) => unknown,
  run: (urls: string[]) => Promise<T>,
): Promise<T> {
  const originalGet = RestAPI.get;
  const urls: string[] = [];
  try {
    (RestAPI as any).get = async ({ url }: any) => {
      urls.push(url);
      return { body: respond(url) };
    };
    return await run(urls);
  } finally {
    RestAPI.get = originalGet;
  }
}

/** SEC-01: model-supplied message_id is interpolated into the REST path unvalidated. */
async function sec01MessageIdPathTraversal(): Promise<void> {
  const secret = { id: '300000000000000003', channel_id: OTHER_DM, content: 'out-of-scope DM secret', timestamp: new Date().toISOString(), author: { id: '9', username: 'mallory' } };
  await withRecordedGets(
    (url) => (resolvedApiPath(url) === `/api/v9/channels/${OTHER_DM}/messages/${secret.id}` ? secret : { id: '1', channel_id: ACTIVE_DM, content: 'ok', timestamp: new Date().toISOString() }),
    async (urls) => {
      const result = await getMessageDetails(dmScope(), ACTIVE_DM, `../../${OTHER_DM}/messages/${secret.id}`, 0);
      const escaped = urls.filter((url) => !resolvedApiPath(url).startsWith(`/api/v9/channels/${ACTIVE_DM}/`));
      assert(escaped.length === 0, `SEC-01 get_message_details requested a path outside the scoped channel: ${escaped.map(resolvedApiPath).join(', ')}`);
      assert(!(result.ok && result.data?.message?.channel_id === OTHER_DM), 'SEC-01 get_message_details returned a message from an out-of-scope channel');
    },
  );
  await withRecordedGets(
    () => ({ id: 'me', email: 'user@example.com', phone: '+15555550100' }),
    async (urls) => {
      await getMessageDetails(dmScope(), ACTIVE_DM, '../../../users/@me', 0);
      const escaped = urls.filter((url) => !resolvedApiPath(url).startsWith(`/api/v9/channels/${ACTIVE_DM}/`));
      assert(escaped.length === 0, `SEC-01 get_message_details reached a non-channel endpoint: ${escaped.map(resolvedApiPath).join(', ')}`);
    },
  );
  // A well-formed ID whose response belongs to another channel must be rejected, not cited.
  await withRecordedGets(
    () => secret,
    async () => {
      const result = await getMessageDetails(dmScope(), ACTIVE_DM, secret.id, 0);
      assert(!result.ok && !result.data, 'SEC-01 get_message_details accepted a response whose channel_id differs from the requested channel');
    },
  );
  // Reply-chain IDs come from the response and must be validated before they are interpolated.
  await withRecordedGets(
    (url) => resolvedApiPath(url) === `/api/v9/channels/${ACTIVE_DM}/messages/500000000000000005`
      ? { id: '500000000000000005', channel_id: ACTIVE_DM, content: 'reply', timestamp: new Date().toISOString(), message_reference: { message_id: `../../${OTHER_DM}/messages/${secret.id}` } }
      : secret,
    async (urls) => {
      const result = await getMessageDetails(dmScope(), ACTIVE_DM, '500000000000000005', 3);
      const escaped = urls.filter((url) => !resolvedApiPath(url).startsWith(`/api/v9/channels/${ACTIVE_DM}/`));
      assert(escaped.length === 0, `SEC-01 reply-chain reference escaped the scoped channel: ${escaped.map(resolvedApiPath).join(', ')}`);
      assert(result.ok && result.data?.replyChain.length === 0, 'SEC-01 get_message_details must return the scoped message without the invalid reference');
    },
  );
}

/** SEC-02: group DM names are matched as raw substrings of the prompt, so ordinary words widen DM scope. */
async function sec02GroupDmSubstringMatch(): Promise<void> {
  const base: CurrentScopeContext = {
    ...dmScope(),
    mutualGroupDMs: [
      { id: 'gdm_art', name: 'art', recipientNames: ['Alice', 'Bob'] },
      { id: 'gdm_plans', name: 'Plans', recipientNames: ['Alice', 'Carol'] },
    ],
  };
  const inWord = restrictScopeForUserPrompt(base, 'When does the party start?');
  assert(!isChannelAllowedInScope('gdm_art', inWord), 'SEC-02 group DM "art" was added to scope by the words "party start" (substring match inside other words)');
  const plural = restrictScopeForUserPrompt(base, 'did alice send her airplanschedule yet');
  assert(!isChannelAllowedInScope('gdm_plans', plural), 'SEC-02 group DM "Plans" was added to scope by the token "airplanschedule"');
  const named = restrictScopeForUserPrompt(base, 'What did we decide in the Plans group?');
  assert(isChannelAllowedInScope('gdm_plans', named) && !isChannelAllowedInScope('gdm_art', named), 'SEC-02 a group DM named as a whole word must still be added, and only that one');
  const numeric: CurrentScopeContext = {
    ...base,
    mutualGroupDMs: [{ id: '700000000000000007', name: 'x', recipientNames: ['Alice'] }],
  };
  assert(!isChannelAllowedInScope('700000000000000007', restrictScopeForUserPrompt(numeric, 'see 17000000000000000079')), 'SEC-02 a group DM ID embedded in a longer number widened scope');
  assert(isChannelAllowedInScope('700000000000000007', restrictScopeForUserPrompt(numeric, 'search group 700000000000000007 please')), 'SEC-02 an exact group DM ID must still be accepted');
}

/** SEC-06: the index pre-filter allowlist omits the active channel that validateScopeBoundary always allows. */
async function sec06PermittedIdsOmitActiveChannel(): Promise<void> {
  const scope: CurrentScopeContext = {
    ...dmScope(),
    channelId: 'thread_active',
    channelType: ChannelType.PUBLIC_THREAD,
    isDM: false,
    isGuild: true,
    guildId: 'g1',
    scopeMode: 'server',
    accessibleGuildChannels: [{ id: 'c1', name: 'general' }],
  };
  assert(isChannelAllowedInScope('thread_active', scope), 'active thread is allowed by validateScopeBoundary');
  const permitted = getPermittedChannelIdsForScope(scope);
  assert(permitted.includes('thread_active'), 'SEC-06 getPermittedChannelIdsForScope omits the active channel in server mode');
  // The allowlist must never exceed what validateScopeBoundary permits.
  assert(permitted.every((id) => isChannelAllowedInScope(id, scope)), `SEC-06 allowlist contains a channel the scope boundary rejects: ${permitted.join(',')}`);
  assert(permitted.length === new Set(permitted).size, 'SEC-06 allowlist must not contain duplicates');
}

/** SEC-07: the sanitizer's denylist misses current chat-template control tokens. */
async function sec07SanitizerTokenCoverage(): Promise<void> {
  const samples = [
    '<|start_header_id|>system<|end_header_id|>',
    '<|eot_id|>',
    '<start_of_turn>user',
    '<|start|>system<|message|>',
    '<|endoftext|>',
    '<|end|>',
  ];
  const survived = samples.filter((sample) => sanitizeUntrustedContent(`x ${sample} y`).includes(sample));
  assert(survived.length === 0, `SEC-07 sanitizeUntrustedContent left control tokens intact: ${survived.join(' ')}`);
  assert(!/[​﻿⁠]/.test(sanitizeUntrustedContent('a​b﻿c⁠d')), 'SEC-07 zero-width characters survive sanitization');
  // Invisible characters are removed before tokens are rewritten, so they cannot be used to split a token.
  assert(!sanitizeUntrustedContent('<|im_​start|>system').includes('<|im_start|>'), 'SEC-07 a zero-width split reassembled a control token');
  // The sanitizer is applied to every model-facing string, so ordinary values must pass through unchanged.
  const ordinary = [
    '123456789012345678',
    'https://cdn.discordapp.com/attachments/1/2/a_b.png?ex=1&is=2&hm=3',
    '2026-01-01T00:00:00.000Z',
    'Ünïcødé 名前 \u{1F468}‍\u{1F469}‍\u{1F467} x<y && y>z',
    'use <s>strike</s> sparingly',
  ];
  const changed = ordinary.filter((value) => sanitizeUntrustedContent(value) !== value);
  assert(changed.length === 0, `SEC-07 sanitizer altered ordinary values: ${changed.join(' | ')}`);
  const once = sanitizeUntrustedContent(`${samples.join(' ')} [INST] # system`);
  assert(sanitizeUntrustedContent(once) === once, 'SEC-07 sanitizer must be idempotent');
  for (const odd of [42, {}, [], undefined, null, Symbol('x')]) {
    assert(sanitizeUntrustedContent(odd as any) === '', `SEC-07 sanitizer must return '' for non-string input ${String(odd)}`);
  }
}

/** SEC-12: validateChannelPermission treats any truthy non-boolean (e.g. a Promise) as permission granted. */
async function sec12PermissionTruthyShapes(): Promise<void> {
  const channel = { id: 'c_private', type: ChannelType.GUILD_TEXT, guild_id: 'g1' } as any;
  const shapes: Array<[string, any]> = [
    ['async can() -> false (Promise)', { can: async () => false }],
    ['can() -> {}', { can: () => ({}) }],
    ['can() -> "false"', { can: () => 'false' }],
  ];
  const granted = shapes.filter(([, store]) => validateChannelPermission(channel, store)).map(([name]) => name);
  assert(granted.length === 0, `SEC-12 validateChannelPermission granted VIEW_CHANNEL for: ${granted.join('; ')}`);
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['SEC-01 message_id path traversal', sec01MessageIdPathTraversal],
  ['SEC-02 group DM substring match', sec02GroupDmSubstringMatch],
  ['SEC-06 permitted IDs omit active channel', sec06PermittedIdsOmitActiveChannel],
  ['SEC-07 sanitizer token coverage', sec07SanitizerTokenCoverage],
  ['SEC-12 permission truthy shapes', sec12PermissionTruthyShapes],
];

export async function runHuntScopeTests(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of CASES) {
    try {
      await run();
      console.log(`✅ huntScope: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      console.log(`❌ huntScope: ${name}: ${message}`);
    }
  }
  assert(failures.length === 0, `huntScope: ${failures.length} failing case(s)`);
}
