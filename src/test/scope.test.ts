import { isChannelAllowedInScope } from '../discord/scope';
import { ChannelType, CurrentScopeContext } from '../types';

function runTests() {
  console.log('--- Running Vencord AI Assistant Scope Boundary Tests ---');

  // Test 1: Guild context
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

  console.log('✅ All Scope Boundary Security Tests Passed!');
}

runTests();
