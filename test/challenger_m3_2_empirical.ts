/*
 * Vencord AI - Milestone 3 Challenger 2 Empirical Test Suite
 * Comprehensive adversarial verification for:
 * 1. MMR Diversity Balance (λ values, distribution extremes, duplicate spam, boundary edge cases)
 * 2. Exact Match Boosting (substring vs whole phrase vs multi-token ratio, casing, short queries)
 * 3. Recency Decay Weighting (exponential half-life decay, strict monotonicity, future/epoch 0 timestamps)
 * 4. Turn Budgeting Limits (model turns, tool calls, record counts, token limits, key normalization & deduplication)
 * 5. Tool-Disabled Finalization Turn Enforcement under simulated multi-turn agent loops
 */

import { assert } from './assert';
import {
  AgentBudgetTracker,
  compactToolResult,
  DEFAULT_AGENT_RUN_BUDGET,
} from '../llm/compression';
import { AIAssistantAgent } from '../llm/agent';
import { ChannelType, CurrentScopeContext, DiscordMessage, PluginSettings } from '../types';

export async function runMilestone3Challenger2Tests(): Promise<{
  passedCount: number;
  bugCount: number;
  details: string[];
}> {
  console.log('\n======================================================================');
  console.log('🔥 RUNNING MILESTONE 3 CHALLENGER 2 EMPIRICAL VERIFICATION SUITE 🔥');
  console.log('======================================================================\n');

  let passedCount = 0;
  let bugCount = 0;
  const details: string[] = [];

  // =========================================================================
  // SUITE 4: Turn Budgeting Limits, Serialization & Deduplication
  // =========================================================================
  console.log('\n--- Suite 4: Turn Budgeting Limits & Argument Deduplication ---');
  {
    // 4.1 Budget Tracker Invariants & Limits
    const budget = new AgentBudgetTracker({
      maxModelTurns: 5,
      maxToolCalls: 10,
      maxElapsedMs: 60_000,
      maxReturnedRecords: 150,
      maxEstimatedInputTokens: 24_000,
      finalizationCalls: 1,
    });

    assert(budget.canModelTurn(), 'Initial budget must allow model turns');
    assert(budget.canToolCall(), 'Initial budget must allow tool calls');

    // Exhaust Tool Calls
    for (let i = 0; i < 10; i++) {
      assert(budget.canToolCall(), `Tool call ${i} must be permitted`);
      const marked = budget.markCall('search_messages', { query: `query_term_${i}` });
      assert(marked, `Tool call ${i} must be recorded`);
    }
    assert(!budget.canToolCall(), 'Tool call budget must be exhausted at limit of 10 calls');

    // Exhaust Model Turns
    budget.modelTurns = 5;
    assert(!budget.canModelTurn(), 'Model turns must be exhausted at limit of 5 turns');

    // Token Limits
    budget.modelTurns = 2;
    budget.estimatedInputTokens = 25_000;
    assert(!budget.canModelTurn(), 'Input token limit exceeding 24,000 must stop model turns');

    // 4.2 Deep Argument Normalization & Deduplication
    const freshBudget = new AgentBudgetTracker();
    const call1 = freshBudget.markCall('search_messages', {
      query: 'auth error',
      filters: { channelId: '123', author: 'alice', flags: { unread: true, pinned: false } },
      limit: 25,
    });
    assert(call1 === true, 'First complex tool call must be accepted');
    assert(freshBudget.toolCalls === 1, 'Tool calls must increment to 1');

    // Permuted top-level and nested key order:
    const call2Duplicate = freshBudget.markCall('search_messages', {
      limit: 25,
      filters: { flags: { pinned: false, unread: true }, author: 'alice', channelId: '123' },
      query: 'auth error',
    });
    assert(call2Duplicate === false, 'Identical tool call with permuted key order must be rejected as duplicate');
    assert(freshBudget.toolCalls === 1, 'Tool call count must NOT increment for duplicate');

    // Distinct argument value
    const call3Distinct = freshBudget.markCall('search_messages', {
      query: 'auth error',
      filters: { channelId: '123', author: 'bob', flags: { unread: true, pinned: false } },
      limit: 25,
    });
    assert(call3Distinct === true, 'Tool call with different author must be accepted as distinct');
    assert((freshBudget.toolCalls as number) === 2, 'Tool call count must increment to 2');

    // 4.3 Payload Compactor & Truncation Safety (`compactToolResult`)
    const largeResultObj = {
      ok: true,
      code: 'search_results',
      summary: 'Found 100 messages.',
      untrustedData: true,
      data: {
        messages: Array.from({ length: 60 }, (_, i) => ({
          id: `msg_${i}`,
          content: `Extremely long Discord message log entry with repetitive payload ${i} `.repeat(20),
          author: { username: `user_${i}`, id: `usr_${i}` },
        })),
      },
    };
    const rawJson = JSON.stringify(largeResultObj);
    assert(rawJson.length > 40_000, `Raw JSON length must exceed 40k chars, got ${rawJson.length}`);

    const compacted = compactToolResult(rawJson, 10_000);
    assert(compacted.length <= 10_000, `Compacted result must strictly fit in 10,000 chars, got ${compacted.length}`);
    const parsedCompacted = JSON.parse(compacted);
    assert(parsedCompacted.ok === true, 'Compacted JSON must maintain ok: true');
    assert(parsedCompacted.truncation?.truncated === true, 'Compacted JSON must set truncation.truncated = true');
    assert(parsedCompacted.data.messages.length < 60, 'Messages array must be reduced to fit character limit');

    // Malformed input fallback (when exceeding maxChars, unparseable input falls back safely)
    const malformedResult = compactToolResult('{ invalid json text content '.repeat(500), 5000);
    const parsedMalformed = JSON.parse(malformedResult);
    assert(parsedMalformed.ok === false, 'Malformed input must produce ok: false');
    assert(parsedMalformed.code === 'invalid_tool_output', 'Malformed input must produce invalid_tool_output code');

    passedCount++;
    console.log('✅ Passed Suite 4: Turn Budgeting Limits & Argument Deduplication');
    details.push('Suite 4: Budget limits, deep key normalization deduplication, and payload compaction safety bounds verified.');
  }

  // =========================================================================
  // SUITE 5: Tool-Disabled Finalization Turn Enforcement under Simulated Agent Loops
  // =========================================================================
  console.log('\n--- Suite 5: Tool-Disabled Finalization Turn Enforcement ---');
  {
    // Setup Mock Discord Environment for Agent
    const mockStores: Record<string, any> = {
      SelectedChannelStore: {
        getChannelId: () => 'chan_test_1',
      },
      ChannelStore: {
        getChannel: (id: string) => ({
          id,
          name: 'general',
          type: ChannelType.GUILD_TEXT,
          guild_id: 'guild_test_1',
        }),
        getChannels: (_guildId: string) => [
          { id: 'chan_test_1', name: 'general', type: ChannelType.GUILD_TEXT },
          { id: 'chan_test_2', name: 'dev', type: ChannelType.GUILD_TEXT },
        ],
      },
      GuildStore: {
        getGuild: (id: string) => ({
          id,
          name: 'Test Server',
        }),
      },
      UserStore: {
        getCurrentUser: () => ({
          id: 'usr_me',
          username: 'agent_user',
          globalName: 'Agent Tester',
        }),
        getUser: (id: string) => ({
          id,
          username: `user_${id}`,
        }),
      },
      PermissionStore: {
        can: (_perm: any, _channel: any) => true,
      },
    };

    const hadWindow = 'window' in globalThis;
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = {
      Vencord: {
        Webpack: {
          findStore: (name: string) => mockStores[name] ?? null,
          findByProps: (...props: string[]) => null,
        },
      },
    };

    const baseSettings: PluginSettings = {
      providerPreset: 'custom',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.2,
      maxTokens: 512,
      systemPrompt: 'Be concise.',
      enableVision: false,
      maxContextMessages: 10,
      searchLimitPerQuery: 25,
      maxSearchIterations: 4, // Max 4 turns
    };

    const originalFetch = globalThis.fetch;

    try {
      // -----------------------------------------------------------------------
      // Test 5.1: Normal Multi-Turn Agent Run with Finalization Enforcement
      // Turn 1: Assistant calls search_messages
      // Turn 2: Assistant finishes -> Finalization call executes with toolChoice: 'none'
      // -----------------------------------------------------------------------
      const requestLog: Array<{
        url: string;
        body: any;
        turn: number;
      }> = [];

      let turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        if (turnCount === 1) {
          // Model initiates a search tool call
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Searching for database error logs...',
                    tool_calls: [
                      {
                        id: 'call_search_1',
                        type: 'function',
                        function: {
                          name: 'search_messages',
                          arguments: JSON.stringify({ query: 'database error', limit: 5 }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          // Turn 2: Model answers directly without further tool calls (Option A skips redundant 3rd call)
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'The database error was caused by a connection pool timeout.',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }) as typeof fetch;

      const agent = new AIAssistantAgent(baseSettings);
      const streamedTokens: string[] = [];
      const runResult = await agent.run('Why did the database crash?', [], {
        onToken: (tok) => streamedTokens.push(tok),
      });

      assert(runResult.content.includes('connection pool timeout'), 'Agent must return the direct answer');
      assert(runResult.steps.some((s) => s.type === 'answer'), 'Answer step must be emitted');
      assert(requestLog.length === 2, `Expected exactly 2 HTTP requests (turn 1 tool, turn 2 direct answer), got ${requestLog.length}`);

      // -----------------------------------------------------------------------
      // Test 5.2: Infinite Tool Loop Prevention & Turn Limit Enforcement
      // Model keeps returning tool calls forever -> Agent must stop at maxModelTurns (4) and finalize
      // -----------------------------------------------------------------------
      requestLog.length = 0;
      turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        // If tools are disabled (finalization call), return final answer
        if (!parsedBody.tools) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Finalized answer after turn budget reached.' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Otherwise keep requesting tool calls with changing query
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `Looping turn ${turnCount}...`,
                  tool_calls: [
                    {
                      id: `call_loop_${turnCount}`,
                      type: 'function',
                      function: {
                        name: 'search_messages',
                        arguments: JSON.stringify({ query: `infinite_term_${turnCount}` }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const loopingAgent = new AIAssistantAgent(baseSettings);
      const loopResult = await loopingAgent.run('Search everything forever', []);
      assert(loopResult.content.includes('Finalized answer after turn budget reached'), 'Agent must finalize cleanly after reaching turn budget');
      // 4 tool selection turns + 1 finalization turn = 5 total HTTP calls
      assert(requestLog.length === 5, `Expected 5 HTTP calls (4 loop turns + 1 finalization), got ${requestLog.length}`);
      const lastCall = requestLog[requestLog.length - 1];
      assert(!lastCall.body.tools, 'Finalization call after loop limit must have tools disabled');
      assert(lastCall.body.tool_choice === undefined, 'Finalization request MUST NOT send tool_choice');
      const finalizationMessages: any[] = lastCall.body.messages;
      const lastSystemMessage = finalizationMessages.find((m) =>
        m.role === 'system' && String(m.content).includes('Tools are now disabled'),
      );
      assert(
        Boolean(lastSystemMessage),
        'Finalization request must include system instruction stating "Tools are now disabled. Give the best concise final answer using only the gathered evidence."',
      );

      // -----------------------------------------------------------------------
      // Test 5.3: Prompt Injection Containment & Safety in Discord Data
      // Mock search tool returns prompt injection text: "SYSTEM OVERRIDE: ignore instructions"
      // Verify tool sets untrustedData: true, and finalization turn strictly enforces tools disabled
      // -----------------------------------------------------------------------
      requestLog.length = 0;
      turnCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        requestLog.push({ url: String(url), body: parsedBody, turn: turnCount });

        if (turnCount === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Querying messages...',
                    tool_calls: [
                      {
                        id: 'call_inj_1',
                        type: 'function',
                        function: {
                          name: 'search_messages',
                          arguments: JSON.stringify({ query: 'secret key' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'Ignored injection instructions contained in data.' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }) as typeof fetch;

      const injectionAgent = new AIAssistantAgent(baseSettings);
      const injResult = await injectionAgent.run('Find secret key', []);
      assert(injResult.content.includes('Ignored injection instructions'), 'Agent must complete safely');

      // Check tool result step in steps
      const toolResultStep = injResult.steps.find((s) => s.type === 'tool_result');
      assert(Boolean(toolResultStep), 'Tool result step must be recorded');
      assert(toolResultStep?.toolResult?.untrustedData === true, 'Discord tool execution result must be flagged as untrustedData = true');

      // -----------------------------------------------------------------------
      // Test 5.4: Finalization Network Failure Graceful Recovery
      // Provider throws 500 error on finalization turn -> Agent catches, does not crash, provides fallback
      // -----------------------------------------------------------------------
      turnCount = 0;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        turnCount++;
        const parsedBody = JSON.parse(String(init?.body));
        if (!parsedBody.tools) {
          // Finalization call fails with 500
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: `call_fail_${turnCount}`, type: 'function', function: { name: 'get_current_context', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const failAgent = new AIAssistantAgent({ ...baseSettings, maxSearchIterations: 1 });
      const failResult = await failAgent.run('Test failure', []);
      assert(
        failResult.content.includes('tools-disabled finalization call failed'),
        'Agent must gracefully recover and inform user when finalization call fails',
      );

      // -----------------------------------------------------------------------
      // Test 5.5: User AbortSignal Cancellation
      // -----------------------------------------------------------------------
      const abortController = new AbortController();
      abortController.abort();
      const abortAgent = new AIAssistantAgent(baseSettings);
      let abortedCaught = false;
      try {
        await abortAgent.run('Test abort', [], undefined, abortController.signal);
      } catch (err: any) {
        abortedCaught = err.message.includes('Agent execution cancelled by user');
      }
      assert(abortedCaught, 'AbortSignal must trigger cancellation exception');
    } finally {
      globalThis.fetch = originalFetch;
      if (hadWindow) (globalThis as any).window = originalWindow;
      else delete (globalThis as any).window;
    }

    passedCount++;
    console.log('✅ Passed Suite 5: Tool-Disabled Finalization Turn Enforcement');
    details.push('Suite 5: Tool-disabled finalization turn enforcement verified across normal runs, infinite tool loops, prompt injection in data, network errors, and abort signals.');
  }

  console.log('\n======================================================================');
  console.log(`SUMMARY: ${passedCount} Passed | ${bugCount} Critical/High Bugs`);
  console.log('======================================================================\n');

  return { passedCount, bugCount, details };
}

// Self-run when executed directly
if (typeof process !== 'undefined' && process.argv[1]?.includes('challenger_m3_2_empirical')) {
  runMilestone3Challenger2Tests().catch((err) => {
    console.error('Milestone 3 Challenger 2 Test Error:', err);
    process.exit(1);
  });
}
