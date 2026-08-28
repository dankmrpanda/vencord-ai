import { RestAPI } from '@webpack/common';
import { runMessageSearch } from '../discord/searchPipeline';
import { fetchRecentMessages, filterMessagesLocally } from '../discord/messages';
import { ChannelType, CurrentScopeContext, DiscordMessage } from '../types';
import { assert } from './assert';

const message = (id: string, channelId: string, content: string): DiscordMessage => ({
  id,
  channel_id: channelId,
  guild_id: 'guild',
  author: { id: 'author', username: 'author' },
  content,
  timestamp: new Date(Date.UTC(2026, 0, 1) + Number(id) * 1000).toISOString(),
  attachments: [],
  embeds: [],
  mentions: [],
  hit: true,
});

const guildScope: CurrentScopeContext = {
  channelId: 'allowed',
  channelName: 'allowed',
  channelType: ChannelType.GUILD_TEXT,
  isDM: false,
  isGroupDM: false,
  isGuild: true,
  guildId: 'guild',
  accessibleGuildChannels: [{ id: 'allowed', name: 'allowed' }],
};

export async function runSearchPipelineTests(): Promise<void> {
  const originalGet = RestAPI.get;
  try {
    RestAPI.get = async ({ query }: any) => {
      if (query.content === 'alpha') {
        return { body: { total_results: 2, messages: [
          [message('2', 'allowed', 'alpha beta exact phrase')],
          [message('3', 'forbidden', 'alpha beta exact phrase forbidden')],
        ] } };
      }
      return { body: { total_results: 1, messages: [[message('1', 'allowed', 'alpha only weak match')]] } };
    };
    const result = await runMessageSearch({ query: 'find alpha beta', guildWide: true, limit: 1, scanLimit: 100 }, guildScope);
    assert(result.data?.messages[0]?.id === '2', 'Bounded relaxed variants must return the best-ranked combined candidate');
    assert(result.data?.messages.every((item) => item.channel_id === 'allowed'), 'Every guild-wide result must belong to permitted scope');

    const dmScope: CurrentScopeContext = {
      channelId: 'active-dm',
      channelName: 'active',
      channelType: ChannelType.DM,
      isDM: true,
      isGroupDM: false,
      isGuild: false,
      mutualGroupDMs: [{ id: 'mutual-group', name: 'group', recipientNames: [] }],
    };
    const empty = await runMessageSearch({ limit: 10, scanLimit: 100 }, dmScope);
    assert(empty.code === 'empty_results', 'Empty searches must return a structured empty result');
    assert(empty.scope?.channelIds[0] === 'active-dm', 'DM search must remain in the active DM by default');

    RestAPI.get = async ({ query }: any) => {
      const start = query.before ? 900 : 1000;
      const count = query.before ? 50 : 100;
      return { body: Array.from({ length: count }, (_, index) => message(
        String(start + index),
        'active-dm',
        query.before && index === 0 ? 'older code 482910' : 'ordinary history',
      )) };
    };
    const messages = await fetchRecentMessages('active-dm', 150);
    const matches = filterMessagesLocally(messages, { pattern: '\\b\\d{6}\\b' });
    assert(matches.some((item) => item.content.includes('482910')), 'Bounded regex scans must continue beyond the most recent 100 messages');
  } finally {
    RestAPI.get = originalGet;
  }
  console.log('✅ Search pipeline relevance, pagination, scope, and empty-result fixtures passed');
}
