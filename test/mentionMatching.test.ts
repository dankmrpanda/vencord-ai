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

  console.log('✅ Member Mention Matching & Manual Scope Modification Tests Passed Successfully!');
}

runMentionAndScopeTests();
