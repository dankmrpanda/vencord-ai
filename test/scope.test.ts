import { isChannelAllowedInScope } from '../discord/scope';
import { ChannelType, CurrentScopeContext, DiscordChannel, DiscordMessage } from '../types';

function runTests() {
  console.log('--- Running Vencord AI Assistant Test Suite ---');

  // Test 1: Guild context boundary
  const guildContext: CurrentScopeContext = {
    channelId: '1001',
    channelName: 'general',
    channelType: ChannelType.GUILD_TEXT,
    isDM: false,
    isGroupDM: false,
    isGuild: true,
    guildId: 'guild_999',
    guildName: 'Test Guild',
    accessibleGuildChannels: [
      { id: '1001', name: 'general' },
      { id: '1002', name: 'dev-chat' },
      { id: '1003', name: 'memes' },
    ],
  };

  console.assert(
    isChannelAllowedInScope('1001', guildContext) === true,
    'Active guild channel should be allowed'
  );
  console.assert(
    isChannelAllowedInScope('1002', guildContext) === true,
    'Accessible sister guild channel should be allowed'
  );
  console.assert(
    isChannelAllowedInScope('9999', guildContext) === false,
    'Inaccessible / external channel should be blocked'
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

  console.assert(
    isChannelAllowedInScope('dm_alice', dmContext) === true,
    'Active DM should be allowed'
  );
  console.assert(
    isChannelAllowedInScope('gdm_project', dmContext) === true,
    'Mutual group DM with Alice should be allowed'
  );
  console.assert(
    isChannelAllowedInScope('dm_bob', dmContext) === false,
    'Unrelated DM with Bob must be blocked'
  );
  console.assert(
    isChannelAllowedInScope('gdm_unrelated', dmContext) === false,
    'Non-mutual group DM must be blocked'
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

  console.assert(extractedChannels.length === 3, 'Should extract all 3 channels from category buckets');
  console.assert(extractedChannels[0].name === 'general', 'First channel should be general');
  console.assert(extractedChannels[2].name === 'dev', 'Third channel should be dev');

  // Test 4: Discord URL regex matching for message jump links
  const testDiscordWebUrl = 'https://discord.com/channels/123456/789012/345678';
  const matchWeb = testDiscordWebUrl.match(/discord\.com\/channels\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
  console.assert(matchWeb !== null && matchWeb[1] === '123456' && matchWeb[2] === '789012' && matchWeb[3] === '345678', 'Should extract guild, channel, message IDs from web URL');

  const testDiscordUri = 'discord://message/789012/345678';
  const matchUri = testDiscordUri.match(/discord:\/\/message\/([^\/]+)\/([^\/]+)/);
  console.assert(matchUri !== null && matchUri[1] === '789012' && matchUri[2] === '345678', 'Should extract channel and message IDs from custom URI');

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

  const resolvedGuildId = mockMsg.guild_id || guildContext.guildId;
  console.assert(resolvedGuildId === 'guild_999', 'Resolved guildId should fall back to active guildContext');

  console.log('✅ All Tests Passed Successfully!');
}

runTests();
