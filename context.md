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
  - Polls and injects the sparkle button into Discord's header bar (`#vencord-ai-header-btn`). While the panel is open, `body.vai-docked` narrows `#app-mount` by `--vai-sidebar-width` (components/sidebarLayout.ts), so Discord's own modals and menus are never covered. Styles live in components/sidebarCss.ts.
  - Implements the React mounting and error boundary fallback. It resolves React 18's `createRoot` using Discord webpack stores or standard DOM fallback.
  - Handles the keyboard shortcut (`Cmd+Shift+A` or `Ctrl+Shift+A`) and the Escape key.

### 2. Discord API & Store Integrations (`/discord`)
- **[`discord/stores.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/stores.ts)**:
  - Narrow acyclic adapter finding internal Discord stores (`UserStore`, `ChannelStore`, `PermissionStore`, `GuildStore`, `SelectedChannelStore`, `MessageStore`, `GuildMemberStore`, `RelationshipStore`), `getToken()`, and `jumpToMessage()`.
- **`discord/participants.ts`**:
  - Channel-permissioned member discovery (`canGuildMemberAccessChannel`, `searchMentionableUsers`, `resolveInScopeUserByName`) and single-pass prompt `@mention` resolution (`resolvePromptMentions`).
- **`discord/rest.ts`**:
  - Unified read-only Discord HTTP read client (`discordGet`, `discordGetOnce`, `fetchOneMessage`, `isSnowflake`, `throwIfAborted`). Enforces live `assertReadOnlyOperation('GET', path)` before every request, honours 429 `Retry-After` up to 5 seconds while respecting abort signals, validates numeric snowflakes, and verifies returned messages match the requested channel.
- **`discord/media.ts` & `discord/messageFormat.ts`**:
  - Scoped Discord attachment/embed image detection and blob/base64 fetching with `media.discordapp.net` fallback (`discord/media.ts`), plus unified slimmed record serialization and UI citation construction (`discord/messageFormat.ts`).
- **`discord/safeRegex.ts`**:
  - AST-level ReDoS safety screening (`isRegexSafe`, `compileSafeRegex`) and `escapeRegExp` for pattern-based searches and local message filtering.
- **[`discord/scope.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/scope.ts)**:
  - Evaluates security scoping, channel permission validation (`validateScopeBoundary`, `validateChannelPermission`, requiring literal `PermissionStore.can() === true`), and channel/thread/forum/DM/Group DM metadata enrichment.
  - Limits queries. For servers, restricts searching to channels the user has permission to view (`PermissionStore`). For DMs, restricts to the current DM unless the user names a specific mutual group DM for that run.
  - A mutual group DM is admitted only when its ID appears in the prompt as a whole token, or its normalized name appears quoted (ASCII `"…"`/`'…'`, `“…”`, `‘…’`, `«…»`, `「…」`, `『…』`; an apostrophe touching a Latin-script word is never a quote) or directly after `group`, `group dm`, `group chat` or `gc` (longest keyword consumed first, so "summarize this group chat" does not admit a group named "chat"). A bare unquoted name never widens scope. After a keyword a space-delimited name must end at a word boundary ("group art" does not match "group artists"); a Han/kana name may run straight into following CJK text.
  - `getPermittedChannelIdsForScope` returns the active channel plus accessible guild channels in server mode, intersects `explicitMutualGroupDMIds` against current `mutualGroupDMs`, and matches `custom` allowlists. An empty channel allowlist matches nothing; it never means "all channels".
- **`discord/channelSnapshot.ts`**:
  - Builds a zero-latency `buildRecentChannelSnapshot` from Discord's client-side `MessageStore` cache (up to 18 same-channel messages, ~3,200 chars, sanitized and attached ephemerally to the `user` turn—never `system` or saved to history).
- **`discord/guardrails.ts`**:
  - Enforces runtime read-only operation assertions (`MutationSecurityError`, `assertReadOnlyOperation`) and `sanitizeUntrustedContent`, neutralizing chat-template tokens (`<|…|>` ChatML/Llama/harmony, DeepSeek `<｜…｜>`, Gemma turn/thought/call/response tags, Qwen/Hermes `<tool_call>`/`<tool_response>`/`<think>`, Llama 2 `[INST]`/`<<SYS>>`, Mistral `[SYSTEM_PROMPT]`/`[TOOL_CALLS]`/`[TOOL_RESULTS]`/`[AVAILABLE_TOOLS]`) and zero-width/bidi characters idempotently.
- **[`discord/search.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/search.ts)**:
  - Handles queries sent to Discord's server-side Search API.
  - Serializes request starts, respects rate limits, and owns cache keys/cursors.
  - `search_messages` adds `data.context`: for the top 5 hits, the scoped messages around each one (`context_messages` per side, default 3, max 5), reusing Discord's search response context groups when present or fetching one window at a time with a 12 s cap and no message repeated across windows (discord/searchContext.ts). All Discord tools (`search_messages`, `fetch_recent_messages`, `fetch_surrounding_messages`, `get_message_details`, `list_channel_pins`, `list_threads`, `transcribe_voice_message`) return slimmed records (with in-scope mention/channel-name resolution, reactions, polls, inline reply previews, embed fields, and forwarded snapshots); UI citations are still built from the full messages. Compaction drops context windows before any hit.
  - A 429 `retry_after` is honoured up to 5 seconds; a longer one fails the remote search so the pipeline falls back instead of stalling. Rate-limit waits end when the run is cancelled; the agent passes its abort signal to `search_messages`, `fetch_recent_messages` and `fetch_surrounding_messages`, so stopping a run also ends their in-flight Discord fetches.
- **`discord/searchPipeline.ts`** normalizes requests, runs primary search (stopping relaxed variants once primary hits ≥ `max(limit, 5)`), supports `custom` multi-channel search, scope-filters, deduplicates, reranks (including `sort_order: 'asc'` without explicit `sort_by`), and returns structured pagination.
  - The offset cursor follows the primary (first) Discord search variant only, so pages neither skip nor repeat its hits.
  - Unparseable `date`/`after_date`/`before_date` values return `invalid_date` instead of being ignored. `has: "sticker"` is filtered; unknown `has` values fail closed.
  - Implicit OTP/PIN/IP patterns are inferred only from descriptor phrases (for example "verification code", "pin code", "ip addresses"); bare words such as "ip" or "pin" stay keywords. Accented and non-Latin keywords survive query cleanup.
  - After remote search it falls back to a bounded scan of recent channel messages (`local_scan`).
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
- **`llm/provider.ts`**:
  - Unified OpenAI-compatible client (`OpenAICompatibleClient`), capability table (`getProviderCapabilities`, `isLocalPreset`), connection tester (`testProviderConnection`), fragmented SSE stream parser, and `normalizeMessagesForModel` (converting non-initial `system` messages to `user` and merging adjacent `user` turns for Gemma models so Jinja templates never reject mid-conversation system turns).
  - Provider error messages, from a non-OK response or from an `error` event inside a streamed response, are redacted to one line of at most 200 characters (the configured key, `Bearer` values, key-shaped and long opaque tokens become `***`). A provider 429 `Retry-After` is honoured up to 30 seconds.
- **`llm/toolRegistry.ts`**:
  - Single source of truth for all agent tools (`AGENT_TOOLS`, local parsers/validators, availability predicates, timeouts, `ToolCompactionPolicy`, literal `readOnly: true` classification, centralized `untrustedData = true` & `scope_denied` wrapping, and executors).
  - `transcribe_voice_message` is offered only while the VoiceTranscribe plugin's native helper (`VencordNative.pluginHelpers.VoiceTranscribe`) exists and that plugin is enabled. It reads the scoped message itself, accepts only a Discord CDN audio attachment on a message flagged as a voice message (flag 1 << 13), and passes that URL to the helper, which transcribes locally (discord/voiceMessages.ts). A message launch on a voice message runs it before the first model turn.
  - `inspect_image` is offered whenever the Image inspection setting is on, for every preset (whether a model can read images depends on the model, not the preset); the setting is off by default. Supports `channel_id` + `message_id` (fetching a fresh Discord URL) or a Discord CDN `image_url`, normalizing blobs to JPEG/PNG (with `media.discordapp.net` fallback). `fetch_recent_messages` applies `pattern` filtering and `before_message_id` / `after_message_id` pagination.
- **[`llm/prompts.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/prompts.ts)**:
  - Defines `DEFAULT_SYSTEM_PROMPT`, `buildSystemPrompt`, and tailored empty-state quick prompts. Retrieved Discord content is explicitly untrusted data and cannot override the built-in safety prompt.
- **`llm/compression.ts`**:
  - Consolidated context-window & budget module: multilingual token estimation, recursive JSON tool compaction (`compactToolResult` + `fitToolResultsToBudget`), conversation context assembly (`buildConversationContext`), multimodal user-content merging (`mergeUserContents`), and `AgentBudgetTracker` (`DEFAULT_AGENT_RUN_BUDGET`).
- **[`llm/agent.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/agent.ts)**:
  - Accepts optional constructor DI (`AIAssistantAgentDeps`) for testing, enforces model-turn/tool/elapsed-time/record/token budgets (with a tighter 24k input token cap / 9.5k tool compaction cap for local presets `omlx`/`ollama`/`lmstudio`, plus mid-loop compaction), rejects duplicate normalized calls, validates/coerces arguments locally, prefetches `mode: 'message'` (including voice & image when enabled) and `mode: 'thread'`, and skips the redundant tools-disabled finalization call when `model_ready` already produced a clean direct answer (reserving finalization for budget/time/record limits, error recovery, or empty stripped output).
  - Strips `<think>`, `<|thought|>`, `<tool_call>`, and `<|call:` blocks in both streaming and final answers, promotes cited snapshot messages into `citations`, and orders explicitly cited sources first.
  - The elapsed-time budget also applies while waiting on a hung provider call; finalization has its own deadline of min(30 s, `maxElapsedMs`). Before finalization the oldest tool results are shrunk to their summaries until the request fits the input token budget (they stay marked untrusted). A provider error on a later turn, after evidence was gathered, goes to the finalization step instead of failing the run.
  - Every string in every tool result is sanitized (`sanitizeUntrustedContent`) before the model sees it; results keep `JSON.stringify` semantics (dates stay ISO strings) and strings produced by `toJSON` are sanitized too. Channel, thread, server, group-DM and user names in the runtime context are sanitized, collapsed to one line, capped at 100 characters and JSON-quoted as user-chosen labels. The summary of older session turns is sent as sanitized user content, not in the system role.
- **`services/chatService.ts`**:
  - Accepts optional constructor DI (`ChatServiceDeps`). Sessions are per channel. `sendMessage` resolves the scope once, before it picks the session, and the agent runs on exactly that scope (it never re-resolves the channel mid-run). With no open channel or DM the run fails closed with `"Open a channel or DM first."` before acquiring a model lease or invoking the agent, records structured `errorKind` (`components/chatErrors.ts`), and leaves other channels isolated. Sending with a scope for a different channel than the active session starts a fresh session for that channel (or re-tags the active session if it is still empty), so another channel's turns are never sent to the model. A session deleted while it is generating stays deleted.

### 4. Components (`/components`)
- **[`components/SidebarPanel.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/SidebarPanel.tsx)**:
  - The right-hand overlay. Hosts chats, session management, and settings references.
  - Shows and sends into the viewed channel's latest session (or a new one saved on first send); a switch during a run waits until the run ends. Auto-scroll follows a streaming reply while the user is within 80 px of the bottom, otherwise a "Jump to latest" pill appears above the input. History, New Chat and delete are disabled while generating.
- **[`components/ChatMessage.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/ChatMessage.tsx)**:
  - Renders user/assistant dialogue, thought steps, expandable tool logs, and attachments.
  - Model-emitted links go through `components/chatLinks.ts`: only `https:` and Discord jump links are allowed, other schemes render as plain text, and external links show their real URL next to the link text.
- **[`components/MessagePreview.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/MessagePreview.tsx)**:
  - Rich Discord citation preview card whose click and jump button call `jumpToMessage` from `discord/stores.ts`.

### 5. Storage (`/storage`)
- **[`storage/chatHistory.ts`](file:///Users/raymond/Documents/projects/vencord-ai/storage/chatHistory.ts)**:
  - Manages chat history sessions, saving sessions per channel in local IndexedDB (with `localStorage` fallback).

---

## 🔒 Security & Privacy Boundaries
Privacy scoping is enforced at the code-level inside [`discord/scope.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/scope.ts) (`restrictScopeForUserPrompt`, `getPermittedChannelIdsForScope`, `isChannelAllowedInScope`, `validateScopeBoundary`, `validateChannelPermission`), read-only request enforcement (`assertReadOnlyOperation`) lives in [`discord/guardrails.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/guardrails.ts) and [`discord/rest.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/rest.ts):
1. **Server Channels**: Can only query channels the active user is allowed to access. Permission is granted only when the permission store returns a literal `true`. The server-mode allowlist is the active channel plus the accessible channels; an empty allowlist matches nothing.
2. **DMs**: The active 1-on-1 DM is the default and the model cannot widen it automatically. A mutual group DM must be named in the prompt (its ID, or its name quoted or after `group`/`gc`) or supplied by a validated contextual launch.
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
  # Runs every suite registered in test/run.ts
  ```
  Suites use the throwing `assert` from `test/assert.ts`, so a failed assertion fails the run. The consolidated suites (`scopePermission`, `huntScope`, `huntLifecycle`, `chatHistory`, `compression`, `guardrails`, `huntAgent`, `huntSearch`, `huntUi`, etc.) are registered in `test/run.ts`.

## Provider behavior

OpenAI enables strict schemas, parallel tool declarations, developer messages, and vision. Other presets opt into only explicitly known features; custom/unknown endpoints use conservative system-message and generic streaming compatibility. Every provider response is still locally validated.

## Search bounds

`limit` defaults from `searchLimitPerQuery` and caps at 50. `scan_limit` defaults to 100 and caps at 500. Exact dates are expanded at local midnight (including daylight-saving transitions), while message timestamps remain ISO; a date that does not parse returns `invalid_date`. Guild-wide and channel-only cache keys are distinct. The offset cursor follows the primary Discord search variant.
