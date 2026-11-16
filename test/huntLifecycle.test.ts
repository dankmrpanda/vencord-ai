/*
 * Regression tests for the approved model-lifecycle fixes (prefix LIFE): LIFE-01, LIFE-02, LIFE-04, LIFE-07.
 * Each case restores fetch and the mocked timers.
 */

import { setImmediate as settle } from 'node:timers/promises';
import { mock } from 'node:test';
import { MODEL_IDLE_TIMEOUT_MS, ModelLifecycle } from '../llm/modelLifecycle';
import { normalizeBaseUrl, resolveModelIdentifier } from '../llm/modelSettings';
import { PluginSettings } from '../types';
import { assert } from './assert';

const RETRY_MS = 30_000;

function fixtureSettings(overrides: Partial<PluginSettings>): PluginSettings {
  return {
    providerPreset: 'omlx', baseUrl: 'http://hunt-lifecycle.fixture/v1', apiKey: '',
    model: 'fixture-model', temperature: 0, maxTokens: 10, systemPrompt: '',
    enableVision: false, maxContextMessages: 10, searchLimitPerQuery: 10, maxSearchIterations: 3,
    ...overrides,
  };
}

interface Call { url: string; body: any; auth?: string }

/** Runs a case with a stubbed fetch, fake setTimeout, and a fresh lifecycle; restores globals. */
async function withLifecycle(
  respond: (call: Call) => Response | Promise<Response>,
  run: (lifecycle: ModelLifecycle, calls: Call[], advance: (ms: number) => Promise<void>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  const lifecycle = new ModelLifecycle();
  mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 5; i++) await settle();
  };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {}, auth: headers.Authorization };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    await run(lifecycle, calls, advance);
  } finally {
    await lifecycle.shutdown().catch(() => {});
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
}

const isUnload = (call: Call) => call.url.endsWith('/unload') || call.body.keep_alive === 0;

/** LIFE-01: a failed idle unload must back off and stop after a bounded number of attempts. */
async function life01UnboundedUnloadRetry(): Promise<void> {
  // Realistic trigger: a mistyped model ID; the server rejects both the load and the unload.
  const settings = fixtureSettings({ baseUrl: 'http://life01.fixture/v1', model: 'typo-model' });
  let status = 404;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withLifecycle(() => Response.json({}, { status }), async (lifecycle, calls, advance) => {
      const failed = await lifecycle.acquire(settings).then(() => false, () => true);
      assert(failed, 'precondition: the load fails');
      let elapsed = 0;
      const unloadTimes: number[] = [];
      await advance(MODEL_IDLE_TIMEOUT_MS);
      for (let second = 0; second < 60 * 60; second += 5) {
        const before = calls.filter(isUnload).length;
        await advance(5_000);
        elapsed += 5_000;
        if (calls.filter(isUnload).length > before) unloadTimes.push(elapsed);
      }
      const unloads = calls.filter(isUnload).length;
      assert(unloads === 5, `LIFE-01 failed idle unloads must stop after five attempts (saw ${unloads} in 65 minutes)`);
      const gaps = unloadTimes.map((time, index) => time - (unloadTimes[index - 1] ?? 0));
      assert(gaps.slice(1).join(',') === '60000,120000,240000', `LIFE-01 retries must back off exponentially after the first 30 s retry (gaps ${gaps.join(',')})`);

      // Giving up must not poison the entry: the next run reloads and a recovered server is unloaded once.
      status = 200;
      calls.length = 0;
      const release = await lifecycle.acquire(settings);
      assert(calls.length === 1 && calls[0].url.endsWith('/load'), 'LIFE-01 a run after giving up reloads the model');
      release();
      await advance(MODEL_IDLE_TIMEOUT_MS);
      assert(calls.filter(isUnload).length === 1, 'LIFE-01 a recovered server receives one idle unload');

      // A success resets the backoff: the next failure retries after 30 s again.
      calls.length = 0;
      (await lifecycle.acquire(settings))();
      status = 503;
      await advance(MODEL_IDLE_TIMEOUT_MS);
      status = 200;
      await advance(RETRY_MS);
      assert(calls.filter(isUnload).length === 2, 'LIFE-01 backoff restarts at 30 s after a successful load or unload');
    });
  } finally {
    console.warn = warn;
  }
}

/** LIFE-02: two entries naming one server model unload it under the other entry's active lease. */
async function life02AliasedEntryUnloadsActiveModel(): Promise<void> {
  const base = fixtureSettings({ baseUrl: 'http://life02.fixture/v1', model: 'shared-model' });
  await withLifecycle(() => Response.json({}), async (lifecycle, calls, advance) => {
    // A run with the old API key finishes, then the user edits the key and starts a long run.
    (await lifecycle.acquire({ ...base, apiKey: 'old-key' }))();
    const active = await lifecycle.acquire({ ...base, apiKey: 'new-key' });
    calls.length = 0;
    await advance(MODEL_IDLE_TIMEOUT_MS);
    const unloads = calls.filter(isUnload);
    active();
    assert(unloads.length === 0, `LIFE-02 the server model must stay resident while a lease is active (saw ${unloads.length} unload: ${unloads.map((c) => c.url).join(', ')})`);
    // The entry that held the lease still unloads the model once it goes idle.
    await advance(MODEL_IDLE_TIMEOUT_MS);
    assert(calls.filter(isUnload).length === 1, `LIFE-02 the model is unloaded once after the last lease goes idle (saw ${calls.filter(isUnload).length})`);
  });
  // Two idle aliases: the first timer leaves the model to the entry that loaded it later.
  await withLifecycle(() => Response.json({}), async (lifecycle, calls, advance) => {
    (await lifecycle.acquire({ ...base, apiKey: 'old-key' }))();
    await advance(60_000);
    (await lifecycle.acquire({ ...base, apiKey: 'new-key' }))();
    await advance(MODEL_IDLE_TIMEOUT_MS - 60_000);
    assert(!calls.some(isUnload), 'LIFE-02 the first idle alias must not unload a model the second still holds loaded');
    await advance(60_000);
    assert(calls.filter(isUnload).length === 1, `LIFE-02 the last idle alias unloads the model once (saw ${calls.filter(isUnload).length})`);
  });
  // LM Studio unloads by instance id; its id behaviour for repeated loads is unverified, so cover both.
  const lmstudio = fixtureSettings({ providerPreset: 'lmstudio', baseUrl: 'http://life02-lms.fixture/v1', model: 'shared-model' });
  // Same instance id for both loads: the idle entry must not unload the instance under the active lease.
  await withLifecycle((call) => Response.json(call.url.endsWith('/load') ? { instance_id: 'inst-shared' } : {}), async (lifecycle, calls, advance) => {
    (await lifecycle.acquire({ ...lmstudio, apiKey: 'old-key' }))();
    const active = await lifecycle.acquire({ ...lmstudio, apiKey: 'new-key' });
    await advance(MODEL_IDLE_TIMEOUT_MS);
    const unloads = calls.filter(isUnload).length;
    active();
    assert(unloads === 0, `LIFE-02 an LM Studio instance shared with an active lease must stay loaded (saw ${unloads} unload)`);
    await advance(MODEL_IDLE_TIMEOUT_MS);
    const unloaded = calls.filter(isUnload).map((c) => c.body.instance_id);
    assert(unloaded.join(',') === 'inst-shared', `LIFE-02 the shared LM Studio instance is unloaded once after the last lease (unloaded: ${unloaded.join(',')})`);
  });
  // Different instance ids: the idle entry unloads only its own instance.
  let instance = 0;
  await withLifecycle((call) => Response.json(call.url.endsWith('/load') ? { instance_id: `inst-${++instance}` } : {}), async (lifecycle, calls, advance) => {
    (await lifecycle.acquire({ ...lmstudio, apiKey: 'old-key' }))();
    const active = await lifecycle.acquire({ ...lmstudio, apiKey: 'new-key' });
    await advance(MODEL_IDLE_TIMEOUT_MS);
    const unloaded = calls.filter(isUnload).map((c) => c.body.instance_id);
    active();
    assert(unloaded.join(',') === 'inst-1', `LIFE-02 an idle LM Studio entry unloads only its own instance, leaving inst-2 (unloaded: ${unloaded.join(',')})`);
  });
}

const CREDENTIALED_URL = 'http://hunt-user:hunt-secret-pw@creds-host.fixture:9123/v1';
const CREDENTIAL_PARTS = ['hunt-user', 'hunt-secret-pw', 'creds-host', '9123'];

function leakedParts(message: string): string[] {
  return CREDENTIAL_PARTS.filter((part) => message.includes(part));
}

/** LIFE-04: a baseUrl with user:pass@ must be rejected with a message that echoes no part of it. */
async function life04CredentialsInErrorMessage(): Promise<void> {
  await withLifecycle(() => Response.json({ data: [{ id: 'life04-model' }] }), async (_lifecycle, calls) => {
    const settings = fixtureSettings({ baseUrl: CREDENTIALED_URL, model: 'org/life04-model' });
    const message = await resolveModelIdentifier(settings).then(() => '', (error) => String(error?.message ?? error));
    assert(message !== '', 'LIFE-04 resolution with a credentialed base URL must fail');
    assert(leakedParts(message).length === 0, `LIFE-04 resolver errors must not echo the base URL (leaked: ${leakedParts(message).join(', ')})`);
    assert(calls.length === 0, 'LIFE-04 no request may be sent to a credentialed base URL');
  });
}

/** LIFE-04b: the same rejection on the lifecycle load path (no-slash omlx model, so no resolution). */
async function life04bCredentialsInLoadError(): Promise<void> {
  await withLifecycle(() => Response.json({}), async (lifecycle, calls) => {
    for (const providerPreset of ['omlx', 'ollama', 'lmstudio'] as const) {
      const settings = fixtureSettings({ providerPreset, baseUrl: CREDENTIALED_URL, model: 'life04b-model' });
      const message = await lifecycle.acquire(settings).then(() => '', (error) => String(error?.message ?? error));
      assert(message !== '', `LIFE-04b ${providerPreset} acquire with a credentialed base URL must fail`);
      assert(leakedParts(message).length === 0, `LIFE-04b ${providerPreset} acquire errors must not echo the base URL (leaked: ${leakedParts(message).join(', ')})`);
    }
    assert(calls.length === 0, 'LIFE-04b no request may be sent to a credentialed base URL');
  });
}

/** LIFE-07: an empty or scheme-less baseUrl yields a relative URL; in the browser it resolves to the Discord origin with the API key attached. */
async function life07RelativeBaseUrlSendsKey(): Promise<void> {
  const offenders: string[] = [];
  for (const [preset, baseUrl, model] of [
    ['omlx', '', 'life07-model'],
    ['omlx', '127.0.0.1:8000/v1', 'life07-model'],
    ['omlx', '127.0.0.1:8001/v1', 'org/life07-model'],
    ['ollama', '', 'life07-model'],
    ['lmstudio', '/v1', 'life07-model'],
  ] as const) {
    await withLifecycle(() => Response.json({ data: [{ id: 'life07-model' }], instance_id: 'life07-instance' }), async (lifecycle, calls) => {
      await lifecycle.acquire(fixtureSettings({ providerPreset: preset, baseUrl, model, apiKey: 'local-server-key' })).then((r) => r(), () => {});
      for (const call of calls) {
        if (call.auth && !/^https?:\/\//.test(call.url)) offenders.push(`${preset} baseUrl=${JSON.stringify(baseUrl)} -> ${call.url}`);
      }
    });
  }
  assert(offenders.length === 0, `LIFE-07 authenticated lifecycle requests must target an absolute http(s) URL (relative: ${offenders.join('; ')})`);
}

/** LIFE-07: normalizeBaseUrl accepts only absolute http(s) URLs and never echoes rejected input. */
async function life07NormalizeBaseUrlContract(): Promise<void> {
  const accepted: Array<[string | undefined, string]> = [
    ['http://localhost:8000/v1/', 'http://localhost:8000/v1'],
    ['  https://api.example.test/v1//  ', 'https://api.example.test/v1'],
    ['HTTP://127.0.0.1:11434/v1', 'HTTP://127.0.0.1:11434/v1'],
    ['', 'http://localhost:8000/v1'],
    ['   ', 'http://localhost:8000/v1'],
    [undefined, 'http://localhost:8000/v1'],
  ];
  for (const [input, expected] of accepted) {
    const actual = normalizeBaseUrl(input);
    assert(actual === expected, `LIFE-07 normalizeBaseUrl(${JSON.stringify(input)}) should be ${expected} (got ${actual})`);
  }
  const rejected = [
    'rejected-host.fixture:8000/v1', '127.0.0.1:8000/v1', 'localhost:8000/v1', '/v1', 'v1/models',
    'ftp://rejected-host.fixture/v1', 'javascript:rejected-host', 'file:///rejected-host/v1',
    'http://rejected-user@rejected-host.fixture/v1', 'http://:rejected-pass@rejected-host.fixture/v1', CREDENTIALED_URL,
  ];
  for (const input of rejected) {
    let message = '';
    try {
      normalizeBaseUrl(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message !== '', `LIFE-07 normalizeBaseUrl must reject ${JSON.stringify(input)}`);
    const echoed = ['rejected-host', 'rejected-user', 'rejected-pass', ...CREDENTIAL_PARTS].filter((part) => message.includes(part));
    assert(echoed.length === 0, `LIFE-07 rejection text must not echo the input (echoed: ${echoed.join(', ')})`);
  }
}

/** HARD-04: a base URL with a query or fragment was accepted, so `/chat/completions` landed inside the query or fragment. */
async function hard04BaseUrlQueryFragmentRejected(): Promise<void> {
  const accepted: string[] = [];
  for (const input of ['http://localhost:8000/v1?rejected-host=1', 'http://localhost:8000/v1#rejected-host', 'http://localhost:8000/v1?', 'https://api.example.test/v1/?a=rejected-host/']) {
    let message = '';
    try {
      normalizeBaseUrl(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message || message.includes('rejected-host')) accepted.push(`${input} -> ${message || 'accepted'}`);
  }
  assert(accepted.length === 0, `HARD-04 normalizeBaseUrl accepted (or echoed) a query/fragment base URL: ${accepted.join('; ')}`);
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['LIFE-01 unbounded idle-unload retry', life01UnboundedUnloadRetry],
  ['LIFE-02 aliased entry unloads active model', life02AliasedEntryUnloadsActiveModel],
  ['LIFE-04 credentials echoed in fetch error', life04CredentialsInErrorMessage],
  ['LIFE-04b credentials echoed in acquire error', life04bCredentialsInLoadError],
  ['LIFE-07 relative baseUrl sends API key', life07RelativeBaseUrlSendsKey],
  ['LIFE-07 normalizeBaseUrl contract', life07NormalizeBaseUrlContract],
  ['HARD-04 base URL query/fragment rejected', hard04BaseUrlQueryFragmentRejected],
];

export async function runHuntLifecycleTests(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of CASES) {
    try {
      await run();
      console.log(`✅ huntLifecycle: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      console.log(`❌ huntLifecycle: ${name}: ${message}`);
    }
  }
  assert(failures.length === 0, `huntLifecycle: ${failures.length} failing case(s)`);
}
