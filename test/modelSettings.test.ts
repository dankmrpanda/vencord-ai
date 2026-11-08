import { OpenAICompatibleTransport } from '../llm/transport';
import { getProviderCapabilities } from '../llm/capabilities';
import { ModelLifecycle } from '../llm/modelLifecycle';
import { resolveModelIdentifier } from '../llm/modelSettings';
import { PluginSettings } from '../types';
import { assert } from './assert';

export async function runModelSettingsTests(): Promise<void> {
  const settings: PluginSettings = {
    providerPreset: 'omlx', baseUrl: 'http://model-names.fixture/v1', apiKey: '',
    model: 'mlx-community/Qwen2.5-32B-Instruct-4bit', temperature: 0, maxTokens: 10,
    systemPrompt: '', enableVision: false, maxContextMessages: 10,
    searchLimitPerQuery: 10, maxSearchIterations: 3,
  };
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; model?: string }> = [];
  const lifecycle = new ModelLifecycle();
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: path, model: body.model });
    if (path.endsWith('/models')) {
      return Response.json({ data: [{ id: 'Qwen2.5-32B-Instruct-4bit' }] });
    }
    if (path.includes('mlx-community%2F') || body.model?.includes('/')) {
      return Response.json({ detail: 'Not Found' }, { status: 404 });
    }
    return Response.json({ choices: [{ message: { content: 'connected' } }] });
  }) as typeof fetch;
  try {
    const release = await lifecycle.acquire(settings);
    const canonicalRelease = await lifecycle.acquire({ ...settings, model: 'Qwen2.5-32B-Instruct-4bit' });
    assert(calls.filter((call) => call.url.endsWith('/load')).length === 1, 'Repository names and canonical IDs share one model lease');
    const transport = new OpenAICompatibleTransport(settings, getProviderCapabilities('omlx'));
    const completion = await transport.complete({ messages: [{ role: 'user', content: 'fixture' }], stream: false });
    assert(completion.content === 'connected', 'Prefixed saved settings must reach inference without a model-load 404');
    release();
    canonicalRelease();
    await lifecycle.shutdown();
    assert(calls.some((call) => call.url.endsWith('/models/Qwen2.5-32B-Instruct-4bit/load')), 'Load uses the ID advertised by the server');
    assert(calls.some((call) => call.model === 'Qwen2.5-32B-Instruct-4bit'), 'Inference uses the same resolved model ID');
    assert(calls.some((call) => call.url.endsWith('/models/Qwen2.5-32B-Instruct-4bit/unload')), 'Unload retains the resolved model ID');
    assert(calls.filter((call) => call.url.endsWith('/models')).length === 1, 'Loading and inference share one model-list lookup');
    assert(settings.model.startsWith('mlx-community/'), 'Resolution does not mutate caller settings');

    let listed: string[] = ['org/Exact-Model', 'a/Ambiguous-Model', 'b/Ambiguous-Model'];
    let status = 200;
    let listings = 0;
    globalThis.fetch = (async () => {
      listings++;
      return Response.json({ data: listed.map((id) => ({ id })) }, { status });
    }) as typeof fetch;
    const resolverSettings = { ...settings, baseUrl: 'http://resolver-cases.fixture/v1', model: 'org/Exact-Model' };
    assert(await resolveModelIdentifier(resolverSettings) === 'org/Exact-Model', 'An exact server ID wins over basename matching');
    assert(await resolveModelIdentifier({ ...resolverSettings, model: 'other/Ambiguous-Model' }).then(() => false, () => true), 'Ambiguous basenames are rejected without selecting another model');
    assert(await resolveModelIdentifier({ ...resolverSettings, model: 'org/Missing-Model' }).then(() => false, () => true), 'Missing models produce an actionable error instead of attempting a load');
    status = 503;
    const retrySettings = { ...resolverSettings, model: 'org/Recovered-Model' };
    assert(await resolveModelIdentifier(retrySettings).then(() => false, () => true), 'Model-list failures propagate without loading');
    status = 200;
    listed = ['Recovered-Model'];
    assert(await resolveModelIdentifier(retrySettings) === 'Recovered-Model', 'Failed lookups are not cached after server recovery');
    const before = listings;
    for (const providerPreset of ['ollama', 'lmstudio', 'openai', 'custom'] as const) {
      assert(await resolveModelIdentifier({ ...resolverSettings, providerPreset }) === 'org/Exact-Model', 'Other providers retain their repository identifiers');
    }
    assert(listings === before, 'Other providers never perform an omlx discovery request');
  } finally {
    await lifecycle.shutdown();
    globalThis.fetch = originalFetch;
  }
  console.log('✅ omlx repository-name resolution through load, inference, and unload passed');
}

if (typeof require !== 'undefined' && require.main === module) {
  void runModelSettingsTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
