# Vencord AI - Developer Context & Architecture

This document is designed to help developer agents (and future models) quickly understand the purpose, architecture, and developer workflows of the `vencord-ai` project.

---

## 📌 Project Overview
`vencord-ai` is a client-side AI assistant plugin for Discord clients modded with Vencord, Vesktop, or Equicord. It integrates directly into the Discord client UI as a right-hand sidebar.
Using a budgeted tool-calling agent loop, the plugin allows users to query Discord history, retrieve message details/pins/threads, inspect scoped image attachments, and perform rate-limited searches while strictly enforcing security and privacy boundaries.

---

## 🛠️ Tech Stack & Key Technologies
- **TypeScript & React**: The plugin UI is built with React 18, matching Discord's native styling and typography (`gg sans`).
- **Webpack Modding (Vencord)**: Uses Vencord's helper utilities (`@utils/types`, `@webpack/common`) to interact with Discord's internal Webpack modules.
- **IndexedDB**: Persistent session and chat history storing using local IndexedDB API.
- **LLM APIs**: Interacts with local (MLX `omlx`, `Ollama`, `LM Studio`) and cloud (OpenAI, OpenRouter, Groq) endpoints.

---

## 🏗️ Core Architecture & File Guide

### 1. Main Entrypoint & UI Mounting
- **[`index.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/index.tsx)**:
  - Registers the `AIAssistant` plugin using `definePlugin()`.
  - Dynamically injects stylesheet styles.
  - Polls and injects the `✨` button into Discord's header bar (`#vencord-ai-header-btn`).
  - Implements the React mounting and error boundary fallback. It resolves React 18's `createRoot` using Discord webpack stores or standard DOM fallback.
  - Handles the keyboard shortcut (`Cmd+Shift+A` or `Ctrl+Shift+A`) and the Escape key.

### 2. Discord API & Store Integrations (`/discord`)
- **[`discord/stores.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/stores.ts)**:
  - Finds internal Discord stores (e.g. `UserStore`, `ChannelStore`, `PermissionStore`, `GuildStore`, `SelectedChannelStore`).
  - Retrieves the active Discord authorization token (`getToken()`) directly from Discord's internal stores to authenticate searches.
- **[`discord/scope.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/scope.ts)**:
  - Evaluates security scoping.
  - Limits queries. For servers, restricts searching to channels the user has permission to view (`PermissionStore`). For DMs, restricts to the current DM unless the user names a specific mutual group DM for that run.
  - A mutual group DM is admitted only when its name or ID appears in the prompt as a whole word (no letter, digit or underscore adjoining it), so "party start" does not unlock a group named "art".
  - `getPermittedChannelIdsForScope` returns the active channel plus the accessible channels in server mode (matching custom mode). An empty channel allowlist matches nothing; it never means "all channels".
- **`discord/guardrails.ts`**:
  - `validateScopeBoundary` and `validateChannelPermission` hold the actual boundary checks that `isChannelAllowedInScope` delegates to. VIEW_CHANNEL counts as granted only when the permission store's `can()` returns a literal `true`; a Promise, object, string or error denies.
  - `sanitizeUntrustedContent` neutralizes chat-template tokens (`<|…|>` ChatML/Llama/harmony, DeepSeek `<｜…｜>`, Gemma turn tags, Qwen/Hermes `<tool_call>`/`<tool_response>`/`<think>`, Llama 2 `[INST]`/`<<SYS>>`, Mistral `[SYSTEM_PROMPT]`/`[TOOL_CALLS]`/`[TOOL_RESULTS]`/`[AVAILABLE_TOOLS]`) and zero-width characters, deleting characters before rewriting tokens so the output is idempotent; `formatUntrustedEvidence` escapes the evidence wrapper's attributes and delimiter.
- **[`discord/search.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/search.ts)**:
  - Handles queries sent to Discord's server-side Search API.
  - Serializes request starts, respects rate limits, and owns cache keys/cursors.
  - A 429 `retry_after` is honoured up to 5 seconds; a longer one fails the remote search so the pipeline falls back instead of stalling. Rate-limit waits end when the run is cancelled; the agent passes its abort signal to `search_messages`, `fetch_recent_messages` and `fetch_surrounding_messages`, so stopping a run also ends their in-flight Discord fetches.
- **`discord/searchPipeline.ts`** normalizes requests, runs at most three variants, scope-filters, deduplicates, reranks, and returns structured pagination.
  - The offset cursor follows the primary (first) Discord search variant only, so pages neither skip nor repeat its hits.
  - Unparseable `date`/`after_date`/`before_date` values return `invalid_date` instead of being ignored. `has: "sticker"` is filtered; unknown `has` values fail closed.
  - Implicit OTP/PIN/IP patterns are inferred only from descriptor phrases (for example "verification code", "pin code", "ip addresses"); bare words such as "ip" or "pin" stay keywords. Accented and non-Latin keywords survive query cleanup.
  - After remote search it tries the `local_index` step and then a bounded scan of recent channel messages. **The local index is never populated in the shipped plugin** (see Storage below), so `local_index` never returns a hit; results come from Discord search and the recent-message scan.
- **`discord/contextTools.ts`** implements the only expanded Discord tools: scoped message details, channel pins, and threads/forum posts.
  - Model-supplied message, reply-chain and thread IDs must be numeric snowflakes before any request, and a fetched message is rejected unless its `channel_id` matches the requested channel.
- **[`discord/messages.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/messages.ts)**:
  - Fetches target messages and retrieves context (conversational turns before and after a specific message).

### 3. AI Agent Loop & Prompts (`/llm`)
- **`llm/modelLifecycle.ts` / `services/runtimeLifecycle.ts`**:
  - Load local models on demand and reuse warm models. Leases cover complete chat/tool runs and connection tests; the last release starts a five-minute idle timeout.
  - Serialize load/unload requests and let cancelled callers stop waiting without cancelling a shared server load.
  - A failed idle unload is retried after 30 s, 60 s, 120 s and 240 s (five attempts in total), then given up: the entry is marked unloaded so the next run reloads normally.
  - A model is not unloaded while another settings entry for the same server model (same base URL and model; for LM Studio, the same instance) is still in use or loaded.
  - The base URL is validated (`normalizeBaseUrl`) before any load, unload or model-list request.
  - Plugin stop cancels generation and starts cleanup. Page exit dispatches keepalive unload requests; cleanup after renderer termination or an unreturned load is best effort.
- **`llm/modelSettings.ts`**:
  - Resolve repository-prefixed omlx identifiers against the server's `/v1/models` list. Preserve exact IDs, require a unique basename match for aliases, and cache successful lookups for five minutes.
  - Lifecycle leases, inference, and connection tests use the same resolved ID. Other providers retain their configured identifiers.
  - `normalizeBaseUrl` trims the value, strips trailing slashes, uses `http://localhost:8000/v1` when empty, and accepts only absolute `http:`/`https:` URLs without a username or password. Its error messages never echo the input. The lifecycle code, the transport and the settings **Test Connection** button all call it before any request (Test Connection also refuses an empty value).
- **`llm/transport.ts` / `llm/capabilities.ts`**:
  - One OpenAI-compatible transport with fragmented SSE handling and conservative capability presets for strict schemas, parallel calls, developer messages, streaming tools, and vision.
  - Provider error messages, from a non-OK response or from an `error` event inside a streamed response, are redacted to one line of at most 200 characters (the configured key, `Bearer` values, key-shaped and long opaque tokens become `***`). A provider 429 `Retry-After` is honoured up to 30 seconds.
- **`llm/toolRegistry.ts`**:
  - One typed registry. Every entry contains a schema, local parser, availability predicate, timeout, execution kind, executor, and literal `readOnly: true` classification.
  - `inspect_image` is offered only when vision is enabled in settings and the provider preset declares vision (OpenAI, OpenRouter). `fetch_recent_messages` applies its `pattern` filter.
- **[`llm/prompts.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/prompts.ts)**:
  - Defines the `DEFAULT_SYSTEM_PROMPT` containing guidelines for historical dates, scope checks, citations, and LLM tools.
  - Defines the schemas consumed by the registry. Retrieved Discord content is explicitly untrusted data and cannot override the built-in safety prompt.
- **[`llm/agent.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/agent.ts)**:
  - Enforces model-turn/tool/elapsed-time/record/token budgets, rejects duplicate normalized calls, validates arguments locally, and performs one tools-disabled finalization call.
  - The elapsed-time budget also applies while waiting on a hung provider call; finalization has its own deadline of min(30 s, `maxElapsedMs`). Before finalization the oldest tool results are shrunk to their summaries until the request fits the input token budget (they stay marked untrusted). A provider error on a later turn, after evidence was gathered, goes to the finalization step instead of failing the run.
  - Every string in every tool result is sanitized (`sanitizeUntrustedContent`) before the model sees it; results keep `JSON.stringify` semantics (dates stay ISO strings) and strings produced by `toJSON` are sanitized too. Channel, thread, server, group-DM and user names in the runtime context are sanitized, collapsed to one line, capped at 100 characters and JSON-quoted as user-chosen labels. The summary of older session turns is sent as sanitized user content, not in the system role.
- **`services/chatService.ts`**:
  - Sessions are per channel. `sendMessage` resolves the scope once, before it picks the session, and the agent runs on exactly that scope (it never re-resolves the channel mid-run). With no open channel or DM the run stops with the error "Open a channel or DM first." before any completion request (the model is still acquired, so a local preset may load it). Sending with a scope for a different channel than the active session starts a fresh session for that channel (or re-tags the active session if it is still empty), so another channel's turns are never sent to the model. A session deleted while it is generating stays deleted.

### 4. Components (`/components`)
- **[`components/SidebarPanel.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/SidebarPanel.tsx)**:
  - The right-hand overlay. Hosts chats, session management, and settings references.
  - Shows and sends into the viewed channel's latest session (or a new one saved on first send); a switch during a run waits until the run ends. Auto-scroll follows a streaming reply while the user is within 80 px of the bottom, otherwise a "↓ Jump to latest" control appears. History, New Chat and delete are disabled while generating.
- **[`components/ChatMessage.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/ChatMessage.tsx)**:
  - Renders user/assistant dialogue, thought steps, expandable tool logs, and attachments.
  - Model-emitted links go through `components/chatLinks.ts`: only `https:` and Discord jump links are allowed, other schemes render as plain text, and external links show their real URL next to the link text.
- **[`components/MessagePreview.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/MessagePreview.tsx)**:
  - Rich Discord citation preview card whose click and jump button call `jumpToMessage` from `discord/stores.ts`.

### 5. Storage (`/storage`)
- **[`storage/chatHistory.ts`](file:///Users/raymond/Documents/projects/vencord-ai/storage/chatHistory.ts)**:
  - Manages chat history sessions, saving sessions per channel in local IndexedDB.
- **`storage/retrieval.ts`, `storage/index/`, `storage/db.ts`** (local message index):
  - A hybrid BM25/regex/semantic engine, Web Worker bridge and IndexedDB message store. **Not wired into production:** nothing outside `test/` calls `ingestBatch`, `loadSnapshot` or the message database, so the index stays empty and the `local_index` search step never returns a hit in the shipped plugin. Wiring it is out of scope for now.
  - `npm run test:benchmark` (`test/retrievalBenchmark.ts`) measures the test-only `InMemoryBM25Index` class in `test/benchmark100k.ts`, not `storage/index`. Its numbers are not evidence about the plugin's search.

---

## 🔒 Security & Privacy Boundaries
Privacy scoping is enforced at the code-level inside [`discord/scope.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/scope.ts) (`restrictScopeForUserPrompt`, `getPermittedChannelIdsForScope`, `isChannelAllowedInScope`) and [`discord/guardrails.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/guardrails.ts) (`validateScopeBoundary`, `validateChannelPermission`):
1. **Server Channels**: Can only query channels the active user is allowed to access. Permission is granted only when the permission store returns a literal `true`. The server-mode allowlist is the active channel plus the accessible channels; an empty allowlist matches nothing.
2. **DMs**: The active 1-on-1 DM is the default and the model cannot widen it automatically. A mutual group DM must be named in the prompt (its name or ID as a whole word) or supplied by a validated contextual launch.
3. If an LLM calls a tool on a channel outside these boundaries, `isChannelAllowedInScope` returns `false`, causing the tool call to fail or return an error boundary response. Message IDs supplied by the model must be numeric snowflakes, and a fetched message must belong to the requested channel.
4. Permission-store discovery and permission checks fail closed. Guild-wide search candidates are post-filtered against the accessible-channel allowlist before citation or model exposure.
5. There are no Discord mutation endpoints or tools in this plugin.
6. **Untrusted content**: every string in every tool result is sanitized before the model sees it; Discord-authored names in the runtime context are sanitized and quoted; the older-history summary is user content, not system. Model-emitted links may only be `https:` or Discord jump links, and external links show their real URL.
7. **Credentials**: the base URL must be an absolute http(s) URL without embedded credentials and is validated before any request (lifecycle, transport, Test Connection). Provider error messages are redacted before display or storage.

---

## 🧪 Developer Commands
- **Typecheck & Build**:
  ```bash
  npm run typecheck
  # Runs: tsc --project tsconfig.dev.json --noEmit
  ```
- **Run Unit Tests**:
  ```bash
  npm run test
  # Runs every suite registered in test/run.ts (including the 100k benchmark run)
  ```
  Suites use the throwing `assert` from `test/assert.ts`, so a failed assertion fails the run. The bug-hunt suites (`scopePermission`, `huntScope`, `huntLifecycle`, `huntIndex`, `huntAgent`, `huntSearch`, `huntUi`) and `challenger_m2_review` are registered in `test/run.ts` alongside the older suites.
- **Retrieval benchmark** (test-only index, see Storage):
  ```bash
  npm run test:benchmark
  ```

## Provider behavior

OpenAI enables strict schemas, parallel tool declarations, developer messages, and vision. Other presets opt into only explicitly known features; custom/unknown endpoints use conservative system-message and generic streaming compatibility. Every provider response is still locally validated.

## Search bounds

`limit` defaults from `searchLimitPerQuery` and caps at 50. `scan_limit` defaults to 100 and caps at 500. Exact dates are expanded at local midnight (including daylight-saving transitions), while message timestamps remain ISO; a date that does not parse returns `invalid_date`. Guild-wide and channel-only cache keys are distinct. The offset cursor follows the primary Discord search variant.
