import { ModelLifecycle } from '../llm/modelLifecycle';
import { PluginSettings } from '../types';
import { assert } from './assert';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settings: PluginSettings = {
  providerPreset: 'omlx', baseUrl: 'http://localhost:8000/v1/', apiKey: 'fixture-key',
  model: 'fixture model', temperature: 0.7, maxTokens: 256, systemPrompt: '',
  enableVision: false, maxContextMessages: 10, searchLimitPerQuery: 10, maxSearchIterations: 3,
};

export async function runModelLifecycleTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  let failLoad = false;
  let holdUnload: (() => Promise<void>) | undefined;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
    if (String(url).endsWith('/unload') && holdUnload) await holdUnload();
    return new Response(JSON.stringify({ instance_id: 'loaded-instance' }), {
      status: failLoad && String(url).endsWith('/load') ? 503 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const lifecycle = new ModelLifecycle(15);
    const release1 = await lifecycle.acquire(settings);
    const release2 = await lifecycle.acquire(settings);
    assert(calls.length === 1, 'Concurrent runs share one load request');
    assert(calls[0].url.endsWith('/v1/models/fixture%20model/load'), 'omlx uses its public model API');
    assert(calls[0].headers.Authorization === 'Bearer fixture-key', 'Model management uses configured authentication');
    release1();
    await pause(30);
    assert(calls.length === 1, 'An active run prevents idle unloading');
    release2();
    release2();
    const release3 = await lifecycle.acquire(settings);
    await pause(30);
    assert(!calls.some((call) => call.url.endsWith('/unload')), 'A new message cancels pending idle eviction');
    release3();
    await pause(30);
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 1, 'Only the last release schedules one idle unload');

    calls.length = 0;
    const ollama = await lifecycle.acquire({ ...settings, providerPreset: 'ollama' });
    assert(calls[0].url.endsWith('/api/generate') && calls[0].body.keep_alive === -1, 'Ollama preloads with an empty native generation request');
    ollama();
    await pause(30);
    assert(calls[1].body.keep_alive === 0, 'Ollama unloads with keep_alive zero');

    calls.length = 0;
    const lmstudio = await lifecycle.acquire({ ...settings, providerPreset: 'lmstudio' });
    lmstudio();
    await pause(30);
    assert(calls[0].url.endsWith('/api/v1/models/load'), 'LM Studio uses native model management');
    assert(calls[1].body.instance_id === 'loaded-instance', 'LM Studio unloads the returned instance');

    calls.length = 0;
    for (const providerPreset of ['openai', 'openrouter', 'groq', 'custom'] as const) {
      (await lifecycle.acquire({ ...settings, providerPreset }))();
    }
    await pause(30);
    assert(calls.length === 0, 'Cloud and custom endpoints receive no lifecycle requests');

    failLoad = true;
    let rejected = false;
    try { await lifecycle.acquire(settings); } catch { rejected = true; }
    assert(rejected, 'Load failures propagate to the chat error handler');
    failLoad = false;
    await pause(30);
    assert(calls.some((call) => call.url.endsWith('/unload')), 'Failed load responses still schedule cleanup in case the server loaded the model');

    calls.length = 0;
    const beforeUnload = await lifecycle.acquire(settings);
    let finishUnload!: () => void;
    const unloading = new Promise<void>((resolve) => { finishUnload = resolve; });
    holdUnload = () => unloading;
    beforeUnload();
    await pause(30);
    assert(calls.length === 2, 'Idle unloading has started');
    const nextLoad = lifecycle.acquire(settings);
    await pause(5);
    assert(calls.length === 2, 'A message arriving during unloading waits before loading');
    finishUnload();
    const afterUnload = await nextLoad;
    assert(calls[2].url.endsWith('/load'), 'The next message reloads after the previous unload completes');
    // Mutating the caller settings must not change the target selected for cleanup.
    const previousModel = settings.model;
    settings.model = 'different-model';
    afterUnload();
    await pause(30);
    settings.model = previousModel;
    assert(calls[3].url.includes('fixture%20model/unload'), 'Idle cleanup retains its original model snapshot');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✅ Local model lifecycle, idle leases, and provider API fixtures passed');
}
