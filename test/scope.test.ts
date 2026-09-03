/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canReadChannel, isChannelAllowedInScope, restrictScopeForUserPrompt } from '../discord/scope';
import { ChannelType, CurrentScopeContext, DiscordChannel, DiscordMessage } from '../types';
import { assert } from './assert';

function runTests() {
  console.log('--- Running Vencord AI Assistant Test Suite ---');

  assert(!canReadChannel(null, { id: 'x', type: ChannelType.GUILD_TEXT }), 'Missing permission discovery must fail closed');
  assert(!canReadChannel({ can: () => { throw new Error('unavailable'); } }, { id: 'x', type: ChannelType.GUILD_TEXT }), 'Permission errors must fail closed');

  // Test 1: Guild context boundary - Server-wide mode
  const guildContextServer: CurrentScopeContext = {
    channelId: '1001',
    channelName: 'general',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: 'guild_999',
    guildName: 'Test Guild',
    scopeMode: 'server',
    accessibleGuildChannels: [
      { id: '1001', name: 'general' },
      { id: '1002', name: 'dev-chat' },
      { id: '1003', name: 'memes' },
    ],
  };

  assert(
    isChannelAllowedInScope('1001', guildContextServer) === true,
    'Active guild channel should be allowed in server mode'
  );
  assert(
    isChannelAllowedInScope('1002', guildContextServer) === true,
    'Accessible sister guild channel should be allowed in server mode'
  );
  assert(
    isChannelAllowedInScope('9999', guildContextServer) === false,
    'Inaccessible / external channel should be blocked in server mode'
  );

  // Test 1b: Default Guild context boundary - Single Channel mode
  const guildContextDefault: CurrentScopeContext = {
    ...guildContextServer,
    scopeMode: 'channel',
    selectedChannelIds: ['1001'],
  };

  assert(
    isChannelAllowedInScope('1001', guildContextDefault) === true,
    'Active guild channel must be allowed in default channel mode'
  );
  assert(
    isChannelAllowedInScope('1002', guildContextDefault) === false,
    'Sister guild channel must be blocked in default channel mode'
  );
  assert(
    isChannelAllowedInScope('9999', guildContextDefault) === false,
    'External channel must be blocked in default channel mode'
  );

  // Test 1c: Custom Guild context boundary - Custom Channel mode
  const guildContextCustom: CurrentScopeContext = {
    ...guildContextServer,
    scopeMode: 'custom',
    selectedChannelIds: ['1001', '1003'],
  };

  assert(
    isChannelAllowedInScope('1001', guildContextCustom) === true,
    'Active channel in custom scope must be allowed'
  );
  assert(
    isChannelAllowedInScope('1003', guildContextCustom) === true,
    'Selected sister channel in custom scope must be allowed'
  );
  assert(
    isChannelAllowedInScope('1002', guildContextCustom) === false,
    'Unselected sister channel in custom scope must be blocked'
  );

  // Test 2: DM Context with mutual group DMs
  const dmContext: CurrentScopeContext = {
    channelId: 'dm_alice',
    channelName: '@Alice',
    channelType: ChannelType.DM,
    isDM: true,
    isGroupDM: false,
    isGuild: false,
    otherUser: { id: 'usr_alice', username: 'alice' },
    mutualGroupDMs: [
      { id: 'gdm_project', name: 'Project Alpha', recipientNames: ['alice', 'bob'] },
      { id: 'gdm_gaming', name: 'Game Night', recipientNames: ['alice', 'charlie'] },
    ],
  };

  assert(
    isChannelAllowedInScope('dm_alice', dmContext) === true,
    'Active DM should be allowed'
  );
  assert(
    isChannelAllowedInScope('gdm_project', dmContext) === false,
    'Mutual group DM must be blocked until explicitly requested'
  );
  const explicitDmContext = restrictScopeForUserPrompt(dmContext, 'Search the Project Alpha group DM for the launch notes.');
  assert(
    isChannelAllowedInScope('gdm_project', explicitDmContext) === true,
    'A specifically named mutual group DM should be allowed for this run'
  );
  assert(
    isChannelAllowedInScope('gdm_gaming', explicitDmContext) === false,
    'Other mutual group DMs must remain blocked'
  );
  assert(
    isChannelAllowedInScope('dm_bob', dmContext) === false,
    'Unrelated DM with Bob must be blocked'
  );
  assert(
    isChannelAllowedInScope('gdm_unrelated', dmContext) === false,
    'Non-mutual group DM must be blocked'
  );

  // Test 2b: DM Context with manually enabled mutual group chats
  const enabledMutualDmContext: CurrentScopeContext = {
    ...dmContext,
    includeMutualGroupDMs: true,
  };
  assert(
    isChannelAllowedInScope('gdm_project', enabledMutualDmContext) === true,
    'Mutual group DM must be allowed when manually enabled in scope'
  );
  assert(
    isChannelAllowedInScope('gdm_gaming', enabledMutualDmContext) === true,
    'Second mutual group DM must also be allowed when manually enabled'
  );
  assert(
    isChannelAllowedInScope('dm_bob', enabledMutualDmContext) === false,
    'Unrelated DM must remain blocked even when mutual groups enabled'
  );

  // Test 3: Simulating category bucket flattening logic for Discord ChannelStore
  const categoryBucketData = {
    '0': [
      { channel: { id: 'ch_1', type: ChannelType.GUILD_TEXT, name: 'general' } },
      { channel: { id: 'ch_2', type: ChannelType.GUILD_TEXT, name: 'announcements' } },
    ],
    '1': [
      { channel: { id: 'ch_3', type: ChannelType.GUILD_TEXT, name: 'dev' } },
    ],
  };

  const rawList = Object.values(categoryBucketData);
  const flattenedList: any[] = [];
  for (const entry of rawList) {
    if (Array.isArray(entry)) {
      flattenedList.push(...entry);
    } else {
      flattenedList.push(entry);
    }
  }

  const extractedChannels = flattenedList
    .map((item) => item?.channel ?? item)
    .filter((ch): ch is DiscordChannel => Boolean(ch && ch.id));

  assert(extractedChannels.length === 3, 'Should extract all 3 channels from category buckets');
  assert(extractedChannels[0].name === 'general', 'First channel should be general');
  assert(extractedChannels[2].name === 'dev', 'Third channel should be dev');

  // Test 4: Discord URL regex matching for message jump links
  const testDiscordWebUrl = 'https://discord.com/channels/123456/789012/345678';
  const matchWeb = testDiscordWebUrl.match(/discord\.com\/channels\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
  assert(matchWeb !== null && matchWeb[1] === '123456' && matchWeb[2] === '789012' && matchWeb[3] === '345678', 'Should extract guild, channel, message IDs from web URL');

  const testDiscordUri = 'discord://message/789012/345678';
  const matchUri = testDiscordUri.match(/discord:\/\/message\/([^\/]+)\/([^\/]+)/);
  assert(matchUri !== null && matchUri[1] === '789012' && matchUri[2] === '345678', 'Should extract channel and message IDs from custom URI');

  // Test 5: Citation guildId resolution logic
  const mockMsg: DiscordMessage = {
    id: 'msg_99',
    channel_id: 'ch_1',
    author: { id: 'usr_1', username: 'Test' },
    content: 'Hello',
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
  };

  const resolvedGuildId = mockMsg.guild_id || guildContextServer.guildId;
  assert(resolvedGuildId === 'guild_999', 'Resolved guildId should fall back to active guildContext');

  console.log('✅ All Tests Passed Successfully!');
}

runTests();
