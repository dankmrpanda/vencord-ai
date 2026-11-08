import { RestAPI } from './mocks/vencord';
import { AIAssistantAgent } from '../llm/agent';
import { ChannelType, CurrentScopeContext, DiscordMessage, PluginSettings } from '../types';
import { assert } from './assert';

const settings: PluginSettings = {
  providerPreset: 'custom',
  baseUrl: 'http://localhost/v1',
  apiKey: '',
  model: 'fixture',
  temperature: 0.2,
  maxTokens: 256,
  systemPrompt: '',
  enableVision: false,
  maxContextMessages: 10,
  searchLimitPerQuery: 25,
  maxSearchIterations: 4,
};

const scope: CurrentScopeContext = {
  channelId: 'launch-channel',
  channelName: 'launch',
  channelType: ChannelType.GUILD_TEXT,
  isDM: false,
  isGroupDM: false,
  isGuild: true,
  guildId: 'launch-guild',
  scopeMode: 'channel',
  accessibleGuildChannels: [{ id: 'launch-channel', name: 'launch' }],
};

const message = (id: string, content: string): DiscordMessage => ({
  id,
  channel_id: scope.channelId,
  author: { id: 'author', username: 'author' },
  content,
  timestamp: '2026-11-08T12:00:00.000Z',
  attachments: [],
  embeds: [],
  mentions: [],
});

export async function runMessageLaunchTests(): Promise<void> {
  const originalGet = RestAPI.get;
  const requests: string[] = [];
  const target = message('100', 'The deployment is postponed until tomorrow.');
  const neighbor = message('99', 'We are waiting for the database migration.');
  RestAPI.get = (async (request: any) => {
    requests.push(request.url);
    if (request.url.endsWith('/messages/100')) return { body: target };
    assert(request.query?.around === '100', 'Launch context must be centered on the selected message');
    return { body: [neighbor, target] };
  }) as typeof RestAPI.get;
  try {
    const agent = new AIAssistantAgent(settings);
    let modelCalls = 0;
    (agent as any).client.complete = async (request: any) => {
      modelCalls++;
      const evidence = request.messages.filter((entry: any) => entry.role === 'tool');
      assert(evidence.some((entry: any) => entry.content.includes(target.content)), 'Selected message content must reach the model even when it never calls a tool');
      assert(evidence.some((entry: any) => entry.content.includes(neighbor.content)), 'Surrounding context must reach the model before its first answer');
      assert(evidence.every((entry: any) => JSON.parse(entry.content).untrustedData), 'Prefetched Discord content must remain untrusted data');
      return { content: 'The deployment is waiting on the database migration.' };
    };
    const result = await agent.run('Explain this message and its surrounding context.', [], undefined, undefined, {
      targetChannelId: scope.channelId,
      targetMessageId: target.id,
      mode: 'message',
      initialPrompt: 'Explain this message and its surrounding context.',
    }, scope);
    assert(modelCalls === 2, 'Launch must work when the model answers directly and then finalizes');
    assert(requests.length === 2, 'Launch must fetch bounded message details and surrounding context');
    assert(result.citations.some((citation) => citation.messageId === target.id), 'Selected message must be cited');
    assert(result.citations.some((citation) => citation.messageId === neighbor.id), 'Surrounding messages must be cited');

    // Validate the complete assistant/tool transcript sent to compatible providers.
    const launch = {
      targetChannelId: scope.channelId,
      targetMessageId: target.id,
      mode: 'message' as const,
      initialPrompt: 'Explain this message.',
    };
    const deniedAgent = new AIAssistantAgent(settings);
    (deniedAgent as any).client.complete = async (request: any) => {
      const toolResults = request.messages.filter((entry: any) => entry.role === 'tool');
      assert(toolResults.length === 2, 'Every launch read must have a matching tool response');
      const declarations = request.messages.flatMap((entry: any) => entry.tool_calls || []);
      assert(toolResults.every((entry: any) => declarations.some((call: any) => call.id === entry.tool_call_id)), 'Launch tool responses must match declared call IDs');
      assert(toolResults.every((entry: any) => JSON.parse(entry.content).code === 'scope_denied'), 'Launch reads outside the active DM must fail closed');
      return { content: 'That message is outside the permitted scope.' };
    };
    requests.length = 0;
    const denied = await deniedAgent.run(launch.initialPrompt, [], undefined, undefined, launch, {
      ...scope,
      channelId: 'active-dm',
      channelType: ChannelType.DM,
      isGuild: false,
      isDM: true,
      guildId: undefined,
      accessibleGuildChannels: undefined,
    });
    assert(requests.length === 0 && denied.citations.length === 0, 'Denied launches must neither fetch nor cite Discord data');

    const failedAgent = new AIAssistantAgent(settings);
    RestAPI.get = (async (request: any) => {
      if (request.url.endsWith('/messages/100')) throw new Error('Message is unavailable.');
      return { body: [] };
    }) as typeof RestAPI.get;
    (failedAgent as any).client.complete = async (request: any) => {
      const toolResults = request.messages.filter((entry: any) => entry.role === 'tool');
      assert(toolResults.some((entry: any) => JSON.parse(entry.content).code === 'tool_error'), 'Failed launch reads must reach the model as structured errors');
      assert(toolResults.some((entry: any) => JSON.parse(entry.content).code === 'empty_results'), 'Missing surrounding context must be reported honestly');
      return { content: 'The message could not be retrieved.' };
    };
    const failed = await failedAgent.run(launch.initialPrompt, [], undefined, undefined, launch, scope);
    assert(failed.citations.length === 0, 'Failed reads must not invent citations');

    const ordinaryAgent = new AIAssistantAgent(settings);
    (ordinaryAgent as any).client.complete = async (request: any) => {
      assert(!request.messages.some((entry: any) => entry.role === 'tool'), 'Ordinary chat must not inherit a previous launch target');
      return { content: 'Hello.' };
    };
    RestAPI.get = (async () => { throw new Error('Unexpected automatic Discord read'); }) as typeof RestAPI.get;
    await ordinaryAgent.run('Hello.', [], undefined, undefined, undefined, scope);

    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await ordinaryAgent.run(launch.initialPrompt, [], undefined, controller.signal, launch, scope);
    } catch {
      cancelled = true;
    }
    assert(cancelled, 'Cancelled launches must stop before fetching context or calling the model');
    console.log('✅ Message context-menu launch regressions passed');
  } finally {
    RestAPI.get = originalGet;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runMessageLaunchTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
