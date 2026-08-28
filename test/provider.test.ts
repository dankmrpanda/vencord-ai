import { getProviderCapabilities } from '../llm/capabilities';
import { consumeChatCompletionStream, OpenAICompatibleTransport } from '../llm/transport';
import { PluginSettings, ProviderPreset, ToolDefinition } from '../types';
import { assert } from './assert';

const presets: ProviderPreset[] = ['openai', 'openrouter', 'groq', 'omlx', 'ollama', 'lmstudio', 'custom'];
presets.forEach((preset) => {
  const capabilities = getProviderCapabilities(preset);
  assert(typeof capabilities.strictSchemas === 'boolean', `${preset} strict-schema capability must be explicit`);
  assert(typeof capabilities.parallelToolCalls === 'boolean', `${preset} parallel-tool capability must be explicit`);
});
assert(!getProviderCapabilities('unknown').strictSchemas, 'Unknown providers must use conservative capabilities');

const frames = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"list_threads","arguments":"{}"}},{"index":0,"id":"call_1","function":{"name":"search_","arguments":"{\\"query\\":\\"alpha"}}]}}]}\n',
  '\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search_messages","arguments":" beta\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
];
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    const joined = frames.join('');
    [joined.slice(0, 19), joined.slice(19, 67), joined.slice(67)].forEach((fragment) => controller.enqueue(encoder.encode(fragment)));
    controller.close();
  },
});
const fixtureTool: ToolDefinition = {
  type: 'function',
  function: { name: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} } },
};

export async function runProviderTests(): Promise<void> {
  const result = await consumeChatCompletionStream(stream);
  assert(result.toolCalls?.[0]?.function.name === 'search_messages', 'Repeated full tool names must not duplicate accumulated fragments');
  assert(result.toolCalls?.[0]?.function.arguments === '{"query":"alpha beta"}', 'Fragmented tool arguments must be reassembled');
  assert(result.toolCalls?.[1]?.function.name === 'list_threads', 'Out-of-order tool deltas must materialize in numeric index order');
  const originalFetch = globalThis.fetch;
  const payloads: Array<{ url: string; payload: any; preset: ProviderPreset }> = [];
  try {
    for (const preset of presets) {
      const settings: PluginSettings = {
        providerPreset: preset,
        baseUrl: `https://${preset}.fixture/v1`,
        apiKey: '',
        model: 'fixture',
        temperature: 0.7,
        maxTokens: 256,
        systemPrompt: '',
        enableVision: false,
        maxContextMessages: 10,
        searchLimitPerQuery: 25,
        maxSearchIterations: 6,
      };
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        payloads.push({ url: String(url), payload: JSON.parse(String(init?.body)), preset });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;
      const transport = new OpenAICompatibleTransport(settings, getProviderCapabilities(preset));
      const completion = await transport.complete({
        messages: [{ role: 'developer', content: 'fixture' }],
        tools: [fixtureTool],
        stream: false,
      });
      assert(completion.content === 'ok', `${preset} contract fixture should normalize a completion`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(payloads.length === presets.length, 'Every provider preset must have an offline transport fixture');
  assert(payloads.find((item) => item.preset === 'openai')?.payload.tools[0].function.strict === true, 'OpenAI strict schemas should be capability-gated on');
  assert(payloads.find((item) => item.preset === 'custom')?.payload.tools[0].function.strict === undefined, 'Unknown/custom strict schemas should remain off');
  assert(payloads.find((item) => item.preset === 'custom')?.payload.messages[0].role === 'system', 'Unsupported developer messages should fall back to system');
  console.log('✅ Provider capability, contract, and fragmented-stream fixtures passed');
}
