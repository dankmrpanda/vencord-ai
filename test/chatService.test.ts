/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatService, getChatService } from '../services/chatService';
import { AIAssistantAgent } from '../llm/agent';
import { modelLifecycle } from '../llm/modelLifecycle';
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

  const originalAcquire = modelLifecycle.acquire;
  const originalRun = AIAssistantAgent.prototype.run;
  const events: string[] = [];
  let failRun = false;
  let failLoad = false;
  let cancelDuringLoad = false;
  modelLifecycle.acquire = async (_settings, signal) => {
    events.push('load');
    assert(signal instanceof AbortSignal, 'Chat passes cancellation through model acquisition');
    if (failLoad) throw new Error('Fixture load failure');
    if (cancelDuringLoad) service.stopGenerating();
    return () => { events.push('release'); };
  };
  AIAssistantAgent.prototype.run = async () => {
    events.push('run');
    if (failRun) throw new Error('Fixture agent failure');
    return { content: 'Fixture reply', steps: [], citations: [] };
  };
  try {
    await service.sendMessage('Fixture message');
    assert(events.join(',') === 'load,run,release', 'Chat loads before running and releases after the full reply');
    events.length = 0;
    failRun = true;
    await service.sendMessage('Fixture failure');
    assert(events.join(',') === 'load,run,release', 'Failed replies still release their model lease');
    failRun = false;
    events.length = 0;
    failLoad = true;
    await service.sendMessage('Fixture load failure');
    assert(events.join(',') === 'load', 'A failed load prevents sending inference requests');
    assert(!service.isGenerating(), 'A failed load clears the generating state');
    failLoad = false;
    events.length = 0;
    cancelDuringLoad = true;
    await service.sendMessage('Fixture cancelled load');
    assert(events.join(',') === 'load,release', 'Cancelling while loading skips inference and releases the model');
    const lastMessage = service.getActiveSession()!.messages.at(-1)!;
    assert(!lastMessage.isStreaming && !lastMessage.content.includes('Error'), 'Cancelled loads stop streaming without an error message');

    cancelDuringLoad = false;
    events.length = 0;
    const pendingSave = service.sendMessage('Cancel before model loading.');
    service.stopGenerating();
    await pendingSave;
    assert(events.length === 0, 'Cancellation during persistence prevents loading or inference');
    assert(!service.getActiveSession()!.messages.at(-1)!.isStreaming, 'Early cancellation clears the streaming placeholder');

    const messageCount = service.getActiveSession()!.messages.length;
    await Promise.all([service.sendMessage('First pending send.'), service.sendMessage('Duplicate pending send.')]);
    assert(service.getActiveSession()!.messages.length === messageCount + 2, 'Rapid submissions share the synchronous generation guard');

    events.length = 0;
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    AIAssistantAgent.prototype.run = async (_prompt, _history, callbacks, signal) => {
      entered();
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      callbacks?.onToken?.('late token');
      return { content: 'late result', steps: [], citations: [] };
    };
    const activeRun = service.sendMessage('Cancel active generation.');
    await running;
    service.stopGenerating();
    await activeRun;
    assert(events.join(',') === 'load,release', 'Cancelling active inference releases its lease');
    const cancelledReply = service.getActiveSession()!.messages.at(-1)!;
    assert(!cancelledReply.isStreaming && !cancelledReply.content.includes('late'), 'Cancelled inference cannot overwrite the reply with late tokens or results');
  } finally {
    modelLifecycle.acquire = originalAcquire;
    AIAssistantAgent.prototype.run = originalRun;
  }

  console.log('✅ ChatService & Background Persistence Tests Passed!');
}

if (typeof require !== 'undefined' && require.main === module) {
  runChatServiceTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
