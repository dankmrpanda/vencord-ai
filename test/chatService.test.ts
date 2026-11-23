/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatService, getChatService } from '../services/chatService';
import { getSessionById, getStoredActiveSessionId } from '../storage/chatHistory';
import { ChannelType, CurrentScopeContext, PluginSettings } from '../types';
import { assert } from './assert';

const testSettings: PluginSettings = {
  providerPreset: 'custom',
  baseUrl: 'http://localhost:8000/v1',
  apiKey: 'test-key',
  model: 'test-model',
  temperature: 0.2,
  maxTokens: 256,
  systemPrompt: 'Be concise.',
  enableVision: false,
  maxContextMessages: 10,
  searchLimitPerQuery: 25,
  maxSearchIterations: 4,
};

export async function runChatServiceTests(): Promise<void> {
  console.log('🧪 Starting ChatService & Background Persistence Tests...');

  const service = new ChatService(testSettings);

  // 1. Initial Session Creation & Id Persistence
  const session1 = await service.initSession('test_channel_1');
  assert(Boolean(session1.id), 'Session must have an ID');
  assert(session1.channelId === 'test_channel_1', 'Session must be assigned to test_channel_1');
  assert(service.getActiveSession()?.id === session1.id, 'Active session must be set in service');
  assert(getStoredActiveSessionId() === session1.id, 'Active session ID must be saved to storage key');

  // 2. Switching & New Sessions
  const fresh = service.newSession('test_channel_2');
  assert(fresh.id !== session1.id, 'New session must have distinct ID');
  assert(service.getActiveSession()?.id === fresh.id, 'Active session should be updated to fresh session');
  assert(getStoredActiveSessionId() === fresh.id, 'Stored active session ID must match new session');

  service.switchSession(session1);
  assert(service.getActiveSession()?.id === session1.id, 'Switching session must restore session1');

  // 3. Listener notifications on updates
  let notificationCount = 0;
  const unsubscribe = service.subscribe(() => {
    notificationCount++;
  });

  service.newSession('chan_notify');
  assert(notificationCount > 0, 'Subscribers must be notified on session creation');

  unsubscribe();
  const countBefore = notificationCount;
  service.newSession('chan_notify_2');
  assert(notificationCount === countBefore, 'Unsubscribed listener must not receive further notifications');

  const events: string[] = [];
  let failRun = false;
  let failLoad = false;
  let cancelDuringLoad = false;
  let customRunHandler: ((_prompt: string, _history: any, callbacks: any, signal?: AbortSignal) => Promise<{ content: string; steps: any[]; citations: any[] }>) | null = null;
  const runScope: CurrentScopeContext = {
    channelId: 'chan_notify_2',
    channelName: 'chan_notify_2',
    channelType: ChannelType.DM,
    isDM: true,
    isGroupDM: false,
    isGuild: false,
  };
  const injectedService = new ChatService(testSettings, {
    lifecycle: {
      acquire: async (_settings, signal) => {
        events.push('load');
        assert(signal instanceof AbortSignal, 'Chat passes cancellation through model acquisition');
        if (failLoad) throw new Error('Fixture load failure');
        if (cancelDuringLoad) injectedService.stopGenerating();
        return () => { events.push('release'); };
      },
    },
    createAgent: () => ({
      run: async (prompt, history, callbacks, signal) => {
        if (customRunHandler) return customRunHandler(prompt, history, callbacks, signal);
        events.push('run');
        if (failRun) throw new Error('Fixture agent failure');
        return { content: 'Fixture reply', steps: [], citations: [] };
      },
    }),
  });
  await injectedService.initSession('chan_notify_2');
  await injectedService.sendMessage('Fixture message', null, runScope);
  assert(events.join(',') === 'load,run,release', 'Chat loads before running and releases after the full reply');
  events.length = 0;
  failRun = true;
  await injectedService.sendMessage('Fixture failure', null, runScope);
  assert(events.join(',') === 'load,run,release', 'Failed replies still release their model lease');
  assert(injectedService.getActiveSession()!.messages.at(-1)!.isError === true, 'Failed replies are marked as errors');
  assert(!injectedService.getActiveSession()!.messages.at(-3)!.isError, 'Successful replies are not marked as errors');
  failRun = false;
  events.length = 0;
  failLoad = true;
  await injectedService.sendMessage('Fixture load failure', null, runScope);
  assert(events.join(',') === 'load', 'A failed load prevents sending inference requests');
  assert(!injectedService.isGenerating(), 'A failed load clears the generating state');
  failLoad = false;
  events.length = 0;
  cancelDuringLoad = true;
  await injectedService.sendMessage('Fixture cancelled load', null, runScope);
  assert(events.join(',') === 'load,release', 'Cancelling while loading skips inference and releases the model');
  const lastMessage = injectedService.getActiveSession()!.messages.at(-1)!;
  assert(!lastMessage.isStreaming && !lastMessage.content.includes('Error'), 'Cancelled loads stop streaming without an error message');

  cancelDuringLoad = false;
  events.length = 0;
  const pendingSave = injectedService.sendMessage('Cancel before model loading.', null, runScope);
  injectedService.stopGenerating();
  await pendingSave;
  assert(events.length === 0, 'Cancellation during persistence prevents loading or inference');
  assert(!injectedService.getActiveSession()!.messages.at(-1)!.isStreaming, 'Early cancellation clears the streaming placeholder');

  const messageCount = injectedService.getActiveSession()!.messages.length;
  await Promise.all([
    injectedService.sendMessage('First pending send.', null, runScope),
    injectedService.sendMessage('Duplicate pending send.', null, runScope),
  ]);
  assert(injectedService.getActiveSession()!.messages.length === messageCount + 2, 'Rapid submissions share the synchronous generation guard');

  events.length = 0;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  customRunHandler = async (_prompt, _history, callbacks, signal) => {
    entered();
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
    callbacks?.onToken?.('late token');
    return { content: 'late result', steps: [], citations: [] };
  };
  const activeRun = injectedService.sendMessage('Cancel active generation.', null, runScope);
  await running;
  injectedService.stopGenerating();
  await activeRun;
  assert(events.join(',') === 'load,release', 'Cancelling active inference releases its lease');
  const cancelledReply = injectedService.getActiveSession()!.messages.at(-1)!;
  assert(!cancelledReply.isStreaming && !cancelledReply.content.includes('late'), 'Cancelled inference cannot overwrite the reply with late tokens or results');

  console.log('✅ ChatService & Background Persistence Tests Passed!');
}

if (typeof require !== 'undefined' && require.main === module) {
  runChatServiceTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
