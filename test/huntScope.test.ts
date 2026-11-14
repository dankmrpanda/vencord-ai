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

const CASES: Array<[string, () => Promise<void>]> = [
  ['SEC-01 message_id path traversal', sec01MessageIdPathTraversal],
  ['SEC-02 group DM substring match', sec02GroupDmSubstringMatch],
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
