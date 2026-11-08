import { modelLifecycle } from '../llm/modelLifecycle';
import { getChatService } from '../services/chatService';
import { startAssistantRuntime, stopAssistantRuntime } from '../services/runtimeLifecycle';
import { PluginSettings } from '../types';
import { assert } from './assert';

export async function runRuntimeLifecycleTests(): Promise<void> {
  const settings: PluginSettings = {
    providerPreset: 'custom', baseUrl: 'http://fixture/v1', apiKey: '', model: 'fixture',
    temperature: 0, maxTokens: 10, systemPrompt: '', enableVision: false,
    maxContextMessages: 10, searchLimitPerQuery: 10, maxSearchIterations: 3,
  };
  const service = getChatService(settings);
  const originalStop = service.stopGenerating;
  const originalStart = modelLifecycle.start;
  const originalShutdown = modelLifecycle.shutdown;
  const events: string[] = [];
  service.stopGenerating = () => { events.push('cancel'); };
  modelLifecycle.start = () => { events.push('start'); };
  modelLifecycle.shutdown = async (keepalive) => { events.push(keepalive ? 'exit-unload' : 'unload'); };
  try {
    const target = new EventTarget();
    startAssistantRuntime(target);
    startAssistantRuntime(target);
    events.length = 0;
    target.dispatchEvent(new Event('visibilitychange'));
    assert(events.length === 0, 'Hiding the app leaves active requests and idle cleanup running');
    target.dispatchEvent(new Event('pagehide'));
    assert(events.join(',') === 'cancel,exit-unload', 'Page exit cancels inference before dispatching keepalive unloads, with no duplicate listeners');
    events.length = 0;
    await stopAssistantRuntime();
    assert(events.join(',') === 'cancel,unload', 'Disabling the plugin cancels inference and awaits cleanup');
    events.length = 0;
    target.dispatchEvent(new Event('pagehide'));
    assert(events.length === 0, 'Plugin stop removes its exit listener');
    startAssistantRuntime(target);
    events.length = 0;
    const replacement = new EventTarget();
    startAssistantRuntime(replacement);
    events.length = 0;
    target.dispatchEvent(new Event('pagehide'));
    assert(events.length === 0, 'Restarting removes the previous window listener');
    replacement.dispatchEvent(new Event('pagehide'));
    assert(events.join(',') === 'cancel,exit-unload', 'Restarting restores exit cleanup');
  } finally {
    await stopAssistantRuntime();
    service.stopGenerating = originalStop;
    modelLifecycle.start = originalStart;
    modelLifecycle.shutdown = originalShutdown;
  }
  console.log('✅ App exit, plugin disable, and restart cleanup wiring fixtures passed');
}
