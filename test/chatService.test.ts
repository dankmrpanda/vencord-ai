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

  console.log('✅ ChatService & Background Persistence Tests Passed!');
}

if (typeof require !== 'undefined' && require.main === module) {
  runChatServiceTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
