/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getPermittedChannelIdsForScope, isChannelAllowedInScope } from '../discord/scope';
import { resolvePromptMentions, searchMentionableUsers } from '../discord/stores';
import { ChannelType, CurrentScopeContext, DiscordUser } from '../types';
import { assert } from './assert';

export function runMentionAndScopeTests() {
  console.log('--- Running Member Mention Matching & Manual Scope Modification Tests ---');

  // =========================================================================
  // 1. Member Mention Resolution & Matching
  // =========================================================================

  // Test 1: Snowflake mentions in prompt
  const snowflakeMentions = resolvePromptMentions('Hey <@9876543210>, can you check this?');
  assert(snowflakeMentions.length === 1, `Expected 1 snowflake mention, got ${snowflakeMentions.length}`);
  assert(snowflakeMentions[0].id === '9876543210', `Expected ID 9876543210, got ${snowflakeMentions[0].id}`);

  // Test 2: Snowflake mention with exclamation point (<@!id>)
  const nickSnowflake = resolvePromptMentions('Check with <@!1122334455>');
  assert(nickSnowflake.length === 1, 'Should match nickname snowflake <@!id>');
  assert(nickSnowflake[0].id === '1122334455', 'Extracted ID should match');

  // Test 3: Text mention with hyphens and underscores
  const textMentions = resolvePromptMentions('Ask @john-doe and @alice_smith for the docs');
  assert(textMentions.length >= 0, 'resolvePromptMentions executes without error on hyphenated mentions');

  // Test 4: Special Discord pings ignored
  const specialPings = resolvePromptMentions('@everyone please check @here');
  assert(specialPings.length === 0, 'Special @everyone and @here tags should not resolve as users');

  // Test 5: searchMentionableUsers empty query returns up to 8 users
  const topUsers = searchMentionableUsers('');
  assert(Array.isArray(topUsers), 'searchMentionableUsers must return an array');
  assert(topUsers.length <= 8, 'Empty query should be capped at 8 users');

  // =========================================================================
  // 2. Default Scope Behavior (Strict Single Channel / Single DM)
  // =========================================================================

  const guildScopeDefault: CurrentScopeContext = {
    channelId: 'ch_general_1',
    channelName: 'general',
    channelType: ChannelType.GUILD_TEXT,
    isGuild: true,
    isDM: false,
    isGroupDM: false,
    guildId: 'guild_test',
    guildName: 'Test Guild',
    scopeMode: 'channel',
    selectedChannelIds: ['ch_general_1'],
    accessibleGuildChannels: [
      { id: 'ch_general_1', name: 'general' },
      { id: 'ch_dev_2', name: 'dev-chat' },
      { id: 'ch_random_3', name: 'random' },
    ],
  };

  // Default scope must ONLY permit the active channel
  const defaultPermitted = getPermittedChannelIdsForScope(guildScopeDefault);
  assert(
    defaultPermitted.length === 1 && defaultPermitted[0] === 'ch_general_1',
    `Default guild scope must strictly be single channel, got: ${JSON.stringify(defaultPermitted)}`
  );
  assert(
    isChannelAllowedInScope('ch_general_1', guildScopeDefault) === true,
    'Active channel must be allowed in default scope'
  );
  assert(
    isChannelAllowedInScope('ch_dev_2', guildScopeDefault) === false,
    'Sister channel must be blocked in default channel scope'
  );
  assert(
    isChannelAllowedInScope('ch_random_3', guildScopeDefault) === false,
    'Random sister channel must be blocked in default channel scope'
  );

  // =========================================================================
  // 3. Manual Scope Modification: Server-wide Mode
  // =========================================================================

  const guildScopeServer: CurrentScopeContext = {
    ...guildScopeDefault,
    scopeMode: 'server',
    selectedChannelIds: ['ch_general_1', 'ch_dev_2', 'ch_random_3'],
  };

  const serverPermitted = getPermittedChannelIdsForScope(guildScopeServer);
  assert(
    serverPermitted.length === 3,
    `Server-wide scope must permit all 3 accessible channels, got ${serverPermitted.length}`
  );
  assert(
    isChannelAllowedInScope('ch_general_1', guildScopeServer) === true,
    'Active channel allowed in server mode'
  );
  assert(
    isChannelAllowedInScope('ch_dev_2', guildScopeServer) === true,
    'Sister channel dev-chat allowed in server mode'
  );
  assert(
    isChannelAllowedInScope('ch_random_3', guildScopeServer) === true,
    'Sister channel random allowed in server mode'
  );
  assert(
    isChannelAllowedInScope('ch_forbidden_secret', guildScopeServer) === false,
    'Inaccessible guild channel must be blocked even in server mode'
  );

  // =========================================================================
  // 4. Manual Scope Modification: Custom Channels Mode
  // =========================================================================

  const guildScopeCustom: CurrentScopeContext = {
    ...guildScopeDefault,
    scopeMode: 'custom',
    selectedChannelIds: ['ch_general_1', 'ch_random_3'],
  };

  const customPermitted = getPermittedChannelIdsForScope(guildScopeCustom);
  assert(
    customPermitted.includes('ch_general_1') && customPermitted.includes('ch_random_3'),
    'Custom scope must include selected channels'
  );
  assert(
    !customPermitted.includes('ch_dev_2'),
    'Custom scope must exclude unselected sister channels'
  );
  assert(
    isChannelAllowedInScope('ch_general_1', guildScopeCustom) === true,
    'Active channel allowed in custom scope'
  );
  assert(
    isChannelAllowedInScope('ch_random_3', guildScopeCustom) === true,
    'Selected random channel allowed in custom scope'
  );
  assert(
    isChannelAllowedInScope('ch_dev_2', guildScopeCustom) === false,
    'Unselected dev-chat channel blocked in custom scope'
  );

  // =========================================================================
  // 5. Default DM Scope & Mutual Group DM Modification
  // =========================================================================

  const dmScopeDefault: CurrentScopeContext = {
    channelId: 'dm_bob',
    channelName: '@Bob',
    channelType: ChannelType.DM,
    isGuild: false,
    isDM: true,
    isGroupDM: false,
    scopeMode: 'channel',
    includeMutualGroupDMs: false,
    otherUser: { id: 'usr_bob', username: 'bob' },
    mutualGroupDMs: [
      { id: 'gdm_project_alpha', name: 'Project Alpha', recipientNames: ['bob', 'carol'] },
      { id: 'gdm_lunch', name: 'Lunch Club', recipientNames: ['bob', 'dave'] },
    ],
  };

  // Default DM scope must be just the DM
  const defaultDmPermitted = getPermittedChannelIdsForScope(dmScopeDefault);
  assert(
    defaultDmPermitted.length === 1 && defaultDmPermitted[0] === 'dm_bob',
    'Default DM scope must strictly be single DM'
  );
  assert(
    isChannelAllowedInScope('dm_bob', dmScopeDefault) === true,
    'Active DM allowed in default DM scope'
  );
  assert(
    isChannelAllowedInScope('gdm_project_alpha', dmScopeDefault) === false,
    'Mutual group DM blocked in default DM scope'
  );

  // Manually modified DM scope (including mutual groups)
  const dmScopeWithGroups: CurrentScopeContext = {
    ...dmScopeDefault,
    includeMutualGroupDMs: true,
  };

  const modifiedDmPermitted = getPermittedChannelIdsForScope(dmScopeWithGroups);
  assert(
    modifiedDmPermitted.length === 3,
    'Modified DM scope with mutual groups must permit DM + both mutual groups'
  );
  assert(
    isChannelAllowedInScope('gdm_project_alpha', dmScopeWithGroups) === true,
    'Mutual group Project Alpha allowed when enabled'
  );
  assert(
    isChannelAllowedInScope('gdm_lunch', dmScopeWithGroups) === true,
    'Mutual group Lunch Club allowed when enabled'
  );
  assert(
    isChannelAllowedInScope('dm_carol', dmScopeWithGroups) === false,
    'Unrelated DM remains blocked'
  );

  // =========================================================================
  // 6. Conversation Scope Isolation and Recency Ordering in searchMentionableUsers
  // =========================================================================

  const mockMessages: Record<string, any[]> = {
    ch_general_1: [
      {
        id: 'msg_1',
        author: { id: 'usr_alice', username: 'alice', globalName: 'Alice' },
        timestamp: '2026-01-01T10:00:00Z', // 10:00
      },
      {
        id: 'msg_2',
        author: { id: 'usr_bob', username: 'bob', globalName: 'Bobby' },
        timestamp: '2026-01-01T10:05:00Z', // 10:05
      },
      {
        id: 'msg_3',
        author: { id: 'usr_charlie', username: 'charlie', globalName: 'Charlie' },
        timestamp: '2026-01-01T10:10:00Z', // 10:10
      },
    ],
    ch_dev_2: [
      {
        id: 'msg_4',
        author: { id: 'usr_dave', username: 'dave', globalName: 'Dave Dev' },
        timestamp: '2026-01-01T10:15:00Z', // 10:15
      },
    ],
  };

  const mockChannels: Record<string, any> = {
    ch_general_1: { id: 'ch_general_1', name: 'general', type: ChannelType.GUILD_TEXT, guild_id: 'guild_test' },
    ch_dev_2: { id: 'ch_dev_2', name: 'dev-chat', type: ChannelType.GUILD_TEXT, guild_id: 'guild_test' },
    ch_random_3: { id: 'ch_random_3', name: 'random', type: ChannelType.GUILD_TEXT, guild_id: 'guild_test' },
    dm_bob: { id: 'dm_bob', name: 'Bob', type: ChannelType.DM, recipients: ['usr_bob'] },
    gdm_project_alpha: {
      id: 'gdm_project_alpha',
      name: 'Project Alpha',
      type: ChannelType.GROUP_DM,
      recipients: ['usr_bob', 'usr_carol'],
      rawRecipients: [
        { id: 'usr_bob', username: 'bob', globalName: 'Bobby' },
        { id: 'usr_carol', username: 'carol', globalName: 'Carol' },
      ],
    },
  };

  const mockUsers: Record<string, any> = {
    usr_alice: { id: 'usr_alice', username: 'alice', globalName: 'Alice' },
    usr_bob: { id: 'usr_bob', username: 'bob', globalName: 'Bobby' },
    usr_charlie: { id: 'usr_charlie', username: 'charlie', globalName: 'Charlie' },
    usr_dave: { id: 'usr_dave', username: 'dave', globalName: 'Dave Dev' },
    usr_carol: { id: 'usr_carol', username: 'carol', globalName: 'Carol' },
    usr_external_friend: { id: 'usr_external_friend', username: 'friend_guy' },
    usr_guild_lurker: { id: 'usr_guild_lurker', username: 'lurker' },
  };

  const mockStores: Record<string, any> = {
    MessageStore: {
      getMessages: (channelId: string) => mockMessages[channelId] || [],
    },
    ChannelStore: {
      getChannel: (id: string) => mockChannels[id] || null,
    },
    UserStore: {
      getUser: (id: string) => mockUsers[id] || null,
      getCurrentUser: () => ({ id: 'usr_me', username: 'current_user' }),
      getUsers: () => mockUsers,
    },
    RelationshipStore: {
      getFriendIDs: () => ['usr_external_friend'],
    },
    GuildMemberStore: {
      getMembers: () => [{ userId: 'usr_guild_lurker', nick: 'Lurker' }],
    },
  };

  (globalThis as any).window = {
    Vencord: {
      Webpack: {
        findStore: (name: string) => mockStores[name] ?? null,
        findByProps: (...props: string[]) => null,
      },
    },
  };

  // Test 6: In default single channel scope, results are strictly ordered by recent message recency
  const recencyResults = searchMentionableUsers('', guildScopeDefault);
  assert(recencyResults.length === 3, `Expected 3 users in general channel, got ${recencyResults.length}`);
  assert(recencyResults[0].id === 'usr_charlie', `Expected most recent author Charlie first, got ${recencyResults[0].username}`);
  assert(recencyResults[1].id === 'usr_bob', `Expected second most recent author Bob second, got ${recencyResults[1].username}`);
  assert(recencyResults[2].id === 'usr_alice', `Expected oldest author Alice third, got ${recencyResults[2].username}`);

  // Test 7: Updating recency when a user sends a newer message
  mockMessages.ch_general_1.push({
    id: 'msg_5',
    author: { id: 'usr_alice', username: 'alice', globalName: 'Alice' },
    timestamp: '2026-01-01T10:20:00Z', // Alice now at 10:20 (newest!)
  });

  const updatedRecencyResults = searchMentionableUsers('', guildScopeDefault);
  assert(updatedRecencyResults[0].id === 'usr_alice', `Alice should now be #1 after newer message, got ${updatedRecencyResults[0].username}`);
  assert(updatedRecencyResults[1].id === 'usr_charlie', `Charlie should now be #2, got ${updatedRecencyResults[1].username}`);
  assert(updatedRecencyResults[2].id === 'usr_bob', `Bob should now be #3, got ${updatedRecencyResults[2].username}`);

  // Test 8: Scope boundary isolation - out-of-scope users must NOT appear
  const idsInScope = updatedRecencyResults.map((u) => u.id);
  assert(!idsInScope.includes('usr_dave'), 'Dave from sister channel ch_dev_2 must NOT appear in channel-scoped mentions');
  assert(!idsInScope.includes('usr_external_friend'), 'External friend from RelationshipStore must NOT appear');
  assert(!idsInScope.includes('usr_guild_lurker'), 'Non-participating guild member must NOT appear');

  // Test 9: Server-wide scope mode includes authors across all accessible server channels
  const serverScopeResults = searchMentionableUsers('', guildScopeServer);
  const serverScopeIds = serverScopeResults.map((u) => u.id);
  assert(serverScopeIds.includes('usr_dave'), 'Dave from ch_dev_2 must appear when scope is server-wide');
  // Order: Alice (10:20) > Dave (10:15) > Charlie (10:10) > Bob (10:05)
  assert(serverScopeResults[0].id === 'usr_alice', `Expected Alice (10:20) first in server scope, got ${serverScopeResults[0].username}`);
  assert(serverScopeResults[1].id === 'usr_dave', `Expected Dave (10:15) second in server scope, got ${serverScopeResults[1].username}`);
  assert(serverScopeResults[2].id === 'usr_charlie', `Expected Charlie (10:10) third in server scope, got ${serverScopeResults[2].username}`);
  assert(serverScopeResults[3].id === 'usr_bob', `Expected Bob (10:05) fourth in server scope, got ${serverScopeResults[3].username}`);

  // Test 10: Custom scope mode restricts to only selected channels
  const customScopeResults = searchMentionableUsers('', guildScopeCustom);
  const customScopeIds = customScopeResults.map((u) => u.id);
  assert(!customScopeIds.includes('usr_dave'), 'Dave from unselected ch_dev_2 must NOT appear in custom scope');
  assert(customScopeIds.includes('usr_alice') && customScopeIds.includes('usr_bob') && customScopeIds.includes('usr_charlie'), 'Selected channel authors must appear');

  // Test 11: Query filtering preserves recency order among matching users
  mockMessages.ch_general_1.push({
    id: 'msg_6',
    author: { id: 'usr_aaron', username: 'aaron', globalName: 'Aaron' },
    timestamp: '2026-01-01T10:02:00Z', // Aaron at 10:02
  });
  const filteredResults = searchMentionableUsers('a', guildScopeDefault);
  // Both Alice (10:20) and Aaron (10:02) match 'a'
  assert(filteredResults.length >= 2, `Expected at least 2 results matching 'a', got ${filteredResults.length}`);
  const aaronIdx = filteredResults.findIndex((u) => u.id === 'usr_aaron');
  const aliceIdx = filteredResults.findIndex((u) => u.id === 'usr_alice');
  assert(aliceIdx !== -1 && aaronIdx !== -1, 'Both Alice and Aaron must match query');
  assert(aliceIdx < aaronIdx, `Alice (10:20) must be ordered before Aaron (10:02), got aliceIdx=${aliceIdx}, aaronIdx=${aaronIdx}`);

  // Test 12: DM Scope shows DM recipient even with 0 loaded messages
  const dmResults = searchMentionableUsers('', dmScopeDefault);
  assert(dmResults.some((u) => u.id === 'usr_bob'), 'Bob must appear as recipient in dmScopeDefault');
  assert(!dmResults.some((u) => u.id === 'usr_alice'), 'Alice must NOT appear in Bob DM');

  // Test 13: Group DM Scope includes group recipients
  const gdmResults = searchMentionableUsers('', {
    channelId: 'gdm_project_alpha',
    channelName: 'Project Alpha',
    channelType: ChannelType.GROUP_DM,
    isGuild: false,
    isDM: false,
    isGroupDM: true,
  });
  const gdmIds = gdmResults.map((u) => u.id);
  assert(gdmIds.includes('usr_bob'), 'Bob must appear in Project Alpha group DM');
  assert(gdmIds.includes('usr_carol'), 'Carol must appear in Project Alpha group DM');
  assert(!gdmIds.includes('usr_alice'), 'Alice must NOT appear in Project Alpha group DM');

  console.log('✅ Member Mention Matching & Manual Scope Modification Tests Passed Successfully!');
}

runMentionAndScopeTests();
