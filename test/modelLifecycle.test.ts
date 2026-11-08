import { setImmediate as settle } from 'node:timers/promises';
import { mock } from 'node:test';
import { MODEL_IDLE_TIMEOUT_MS, ModelLifecycle } from '../llm/modelLifecycle';
import { PluginSettings } from '../types';
import { assert } from './assert';

const settings: PluginSettings = {
  providerPreset: 'omlx', baseUrl: 'http://localhost:8000/v1/', apiKey: 'fixture-key',
  model: 'fixture model', temperature: 0.7, maxTokens: 256, systemPrompt: '',
  enableVision: false, maxContextMessages: 10, searchLimitPerQuery: 10, maxSearchIterations: 3,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function runModelLifecycleTests(): Promise<void> {
  assert(MODEL_IDLE_TIMEOUT_MS === 5 * 60_000, 'Models stay warm for five minutes of inactivity');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any; headers: any; keepalive?: boolean }> = [];
  let failLoad = false;
  let failUnload = false;
  let loadGate: ReturnType<typeof deferred> | undefined;
  let unloadGate: ReturnType<typeof deferred> | undefined;
  const lifecycles: ModelLifecycle[] = [];
  const create = () => {
    const lifecycle = new ModelLifecycle();
    lifecycles.push(lifecycle);
    return lifecycle;
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    await settle();
  };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers, keepalive: init?.keepalive };
    calls.push(call);
    const unloading = call.url.endsWith('/unload') || call.body.keep_alive === 0;
    if (unloading && unloadGate) await unloadGate.promise;
    if (!unloading && loadGate) await loadGate.promise;
    return new Response(JSON.stringify({ instance_id: 'loaded-instance' }), {
      status: (unloading ? failUnload : failLoad) ? 503 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const lifecycle = create();
    const [release1, release2] = await Promise.all([lifecycle.acquire(settings), lifecycle.acquire(settings)]);
    assert(calls.length === 1, 'Concurrent runs share one load request');
    assert(calls[0].url.endsWith('/v1/models/fixture%20model/load'), 'omlx uses its public model API');
    assert(calls[0].headers.Authorization === 'Bearer fixture-key', 'Model management uses configured authentication');
    release1();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.length === 1, 'An active run prevents idle unloading');
    release2();
    release2();
    await advance(MODEL_IDLE_TIMEOUT_MS - 1);
    assert(calls.length === 1, 'Idle models remain resident until the full five minutes elapse');
    const release3 = await lifecycle.acquire(settings);
    assert(calls.length === 1, 'A warm model is reused without another load request');
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.length === 1, 'A new message cancels pending idle eviction');
    release3();
    await advance(MODEL_IDLE_TIMEOUT_MS - 1);
    assert(calls.length === 1, 'The idle deadline resets after the last run finishes');
    await advance(1);
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 1, 'Only the last release schedules one idle unload');

    calls.length = 0;
    const ollama = await lifecycle.acquire({ ...settings, providerPreset: 'ollama' });
    assert(calls[0].url.endsWith('/api/generate') && calls[0].body.keep_alive === 300, 'Ollama preloads with a finite five-minute server keep-alive');
    ollama();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls[1].body.keep_alive === 0, 'Ollama unloads with keep_alive zero');

    calls.length = 0;
    const lmstudio = await lifecycle.acquire({ ...settings, providerPreset: 'lmstudio' });
    lmstudio();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls[0].url.endsWith('/api/v1/models/load'), 'LM Studio uses native model management');
    assert(calls[1].body.instance_id === 'loaded-instance', 'LM Studio unloads the returned instance');

    calls.length = 0;
    for (const providerPreset of ['openai', 'openrouter', 'groq', 'custom'] as const) {
      (await lifecycle.acquire({ ...settings, providerPreset }))();
    }
    await lifecycle.shutdown();
    assert(calls.length === 0, 'Cloud and custom endpoints receive no lifecycle requests, including on shutdown');

    lifecycle.start();
    failLoad = true;
    const failures = await Promise.allSettled([lifecycle.acquire(settings), lifecycle.acquire(settings)]);
    assert(failures.every((result) => result.status === 'rejected'), 'Load failures propagate to every caller');
    assert(calls.filter((call) => call.url.endsWith('/load')).length === 1, 'Concurrent callers also share a failed load without redundant retries');
    failLoad = false;
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.some((call) => call.url.endsWith('/unload')), 'Failed load responses still schedule cleanup');

    calls.length = 0;
    const beforeUnload = await lifecycle.acquire(settings);
    unloadGate = deferred();
    beforeUnload();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.length === 2, 'Idle unloading has started');
    const nextLoad = lifecycle.acquire(settings);
    await settle();
    assert(calls.length === 2, 'A message arriving during unloading waits before loading');
    unloadGate.resolve();
    const afterUnload = await nextLoad;
    unloadGate = undefined;
    assert(calls[2].url.endsWith('/load'), 'The next message reloads after the previous unload completes');
    const previousModel = settings.model;
    settings.model = 'different-model';
    afterUnload();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    settings.model = previousModel;
    assert(calls[3].url.includes('fixture%20model/unload'), 'Idle cleanup retains its original model snapshot');

    calls.length = 0;
    const retryRelease = await lifecycle.acquire(settings);
    failUnload = true;
    retryRelease();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    failUnload = false;
    await advance(30_000);
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 2, 'Failed idle unloads retain their target and retry after server recovery');

    calls.length = 0;
    loadGate = deferred();
    const cancelled = new AbortController();
    const cancelledLoad = lifecycle.acquire(settings, cancelled.signal).then(() => false, () => true);
    const sharedLoad = lifecycle.acquire(settings);
    await settle();
    cancelled.abort();
    assert(await cancelledLoad, 'Cancellation stops waiting for a slow load immediately');
    assert(calls.length === 1, 'Cancelling one caller does not restart or cancel a shared load');
    loadGate.resolve();
    loadGate = undefined;
    const sharedRelease = await sharedLoad;
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.length === 1, 'The remaining caller keeps the shared model resident');
    sharedRelease();
    await lifecycle.shutdown();
    assert(calls[1].url.endsWith('/unload'), 'Shutdown unloads immediately without waiting for the idle deadline');
    sharedRelease();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 1, 'Late releases after shutdown do not create duplicate unloads');
    assert(await lifecycle.acquire(settings).then(() => false, () => true), 'Shutdown rejects new model use');

    for (const providerPreset of ['omlx', 'ollama', 'lmstudio'] as const) {
      calls.length = 0;
      const exiting = create();
      const release = await exiting.acquire({ ...settings, providerPreset });
      const closing = exiting.shutdown(true);
      assert(calls.length === 2 && calls[1].keepalive === true, `${providerPreset} sends exit cleanup before returning to the event loop`);
      await closing;
      release();
      await advance(MODEL_IDLE_TIMEOUT_MS);
      assert(calls.length === 2, 'Shutdown cancels outstanding idle timers');
    }

    calls.length = 0;
    const slow = create();
    loadGate = deferred();
    const slowLoad = slow.acquire({ ...settings, providerPreset: 'lmstudio' }).then(() => false, () => true);
    await settle();
    const closing = slow.shutdown();
    assert(await slowLoad, 'Shutdown promptly cancels callers waiting for a model');
    loadGate.resolve();
    loadGate = undefined;
    await closing;
    assert(calls[1].body.instance_id === 'loaded-instance', 'Shutdown waits for a late load result and unloads the returned LM Studio instance');

    calls.length = 0;
    slow.start();
    const resumed = await slow.acquire(settings);
    assert(calls.length === 1 && calls[0].url.endsWith('/load'), 'Re-enabling starts a fresh model session');
    resumed();
    await slow.shutdown();

    calls.length = 0;
    const exitingLoad = create();
    loadGate = deferred();
    const abandonedLoad = exitingLoad.acquire(settings).then(() => false, () => true);
    await settle();
    const pageExit = exitingLoad.shutdown(true);
    assert(calls[1]?.url.endsWith('/unload') && calls[1].keepalive, 'Exiting during an omlx load dispatches cleanup immediately');
    assert(await abandonedLoad, 'Page exit cancels the waiting chat');
    loadGate.resolve();
    loadGate = undefined;
    await pageExit;
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 2, 'A late load completion receives a second serialized exit cleanup');

    calls.length = 0;
    const restarting = create();
    const oldRelease = await restarting.acquire(settings);
    unloadGate = deferred();
    const stopping = restarting.shutdown();
    await settle();
    restarting.start();
    const reloading = restarting.acquire(settings);
    await settle();
    assert(calls.length === 2, 'A quick restart waits for previous shutdown cleanup before loading');
    unloadGate.resolve();
    unloadGate = undefined;
    await stopping;
    const newRelease = await reloading;
    assert(calls[2].url.endsWith('/load'), 'Restart reloads even while an old cancelled caller still holds a lease');
    oldRelease();
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.filter((call) => call.url.endsWith('/unload')).length === 1, 'Late old releases cannot unload a model used after restart');
    newRelease();
    await restarting.shutdown();
  } finally {
    loadGate?.resolve();
    unloadGate?.resolve();
    failLoad = false;
    failUnload = false;
    await Promise.all(lifecycles.map((lifecycle) => lifecycle.shutdown()));
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  console.log('✅ Model warm reuse, five-minute idle eviction, cancellation, retries, and shutdown fixtures passed');
}

if (typeof require !== 'undefined' && require.main === module) {
  void runModelLifecycleTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
