import { renderDiagnosticLogEntry, serializeLogArgument } from '../diagnostics';
import { AIAssistantAgent } from '../llm/agent';
import { ChatService, getChatService } from '../services/chatService';
import { ChannelType, CurrentScopeContext, PluginSettings } from '../types';
import { assert } from './assert';

const settings: PluginSettings = {
  providerPreset: 'custom',
  baseUrl: 'http://localhost/v1',
  apiKey: '',
  model: 'initial-model',
  temperature: 0.2,
  maxTokens: 256,
  systemPrompt: '',
  enableVision: false,
  maxContextMessages: 10,
  searchLimitPerQuery: 25,
  maxSearchIterations: 4,
};

const scope: CurrentScopeContext = {
  channelId: 'regression-channel',
  channelName: 'regression',
  channelType: ChannelType.GUILD_TEXT,
  isDM: false,
  isGroupDM: false,
  isGuild: true,
  guildId: 'regression-guild',
  scopeMode: 'channel',
  accessibleGuildChannels: [{ id: 'regression-channel', name: 'regression' }],
};

export async function runRegressionFixTests(): Promise<void> {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert(serializeLogArgument(circular) === '[object Object]', 'Circular diagnostic arguments must not crash logging');

  const hostile = {
    toJSON: () => { throw new Error('no JSON'); },
    toString: () => { throw new Error('no string'); },
  };
  assert(serializeLogArgument(hostile) === '[Unserializable]', 'Hostile diagnostic arguments need a safe fallback');
  const hostileError = new Error('fallback message');
  Object.defineProperty(hostileError, 'stack', { get: () => { throw new Error('no stack'); } });
  assert(serializeLogArgument(hostileError) === 'Error: fallback message', 'Throwing Error getters must not crash logging');
  const renderedLog = renderDiagnosticLogEntry({
    time: '<img src=x onerror=alert(1)>',
    level: 'error',
    message: '<script>alert(1)</script> & "quoted"',
  });
  assert(!renderedLog.includes('<script>') && !renderedLog.includes('<img'), 'Diagnostic fallback HTML must escape log content');
  assert(renderedLog.includes('&lt;script&gt;') && renderedLog.includes('&amp;'), 'Escaped diagnostics must preserve readable content');

  let completionCall = 0;
  let toolMessages: Array<{ tool_call_id?: string; content: unknown }> = [];
  const agent = new AIAssistantAgent(settings, {
    client: {
      complete: async (request: any) => {
        completionCall++;
        if (completionCall === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'rejected', type: 'function', function: { name: 'get_current_context', arguments: '{}' } },
              { id: 'fulfilled', type: 'function', function: { name: 'get_current_context', arguments: '{}' } },
            ],
          };
        }
        if (completionCall === 2) {
          toolMessages = request.messages.filter((message: any) => message.role === 'tool');
          return { content: 'Evidence gathered.' };
        }
        return { content: 'Final answer.' };
      },
    },
  });
  const result = await agent.run('Run both tools.', [], {
    onStepAdded: (step) => {
      if (step.type === 'tool_call' && step.id.startsWith('tool_rejected_')) throw new Error('Fixture callback failure');
    },
  }, undefined, undefined, scope);
  assert(result.content === 'Evidence gathered.', 'Agent must answer after a rejected parallel tool execution');
  assert(toolMessages.length === 2, 'Every declared tool call must receive a tool response');
  const rejected = toolMessages.find((message) => message.tool_call_id === 'rejected');
  assert(String(rejected?.content).includes('tool_error'), 'Rejected executions must become structured tool errors');

  let acquiredModel = '';
  const injectedService = new ChatService(settings, {
    lifecycle: {
      acquire: async (runSettings) => {
        acquiredModel = runSettings.model;
        return () => {};
      },
    },
    createAgent: () => ({ run: async () => ({ content: 'done', steps: [], citations: [] }) }),
  });
  const updatedSettings = { ...settings, model: 'updated-model' };
  injectedService.updateSettings(updatedSettings);
  await injectedService.initSession('regression-channel');
  await injectedService.sendMessage('Use the updated settings.', null, scope);
  const service = getChatService(settings);
  assert(getChatService() === service, 'No-argument getter must return the initialized singleton');
  assert(acquiredModel === 'updated-model', 'The chat service must use updated settings for the next run');
  console.log('✅ Diagnostics, parallel tool fallback, and chat settings regressions passed');
}
