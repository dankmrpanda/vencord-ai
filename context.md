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
- **[`discord/search.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/search.ts)**:
  - Handles queries sent to Discord's server-side Search API.
  - Serializes request starts, respects rate limits, and owns cache keys/cursors.
- **`discord/searchPipeline.ts`** normalizes requests, runs at most three variants, scope-filters, deduplicates, reranks, and returns structured pagination.
- **`discord/contextTools.ts`** implements the only expanded Discord tools: scoped message details, channel pins, and threads/forum posts.
- **[`discord/messages.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/messages.ts)**:
  - Fetches target messages and retrieves context (conversational turns before and after a specific message).

### 3. AI Agent Loop & Prompts (`/llm`)
- **`llm/transport.ts` / `llm/capabilities.ts`**:
  - One OpenAI-compatible transport with fragmented SSE handling and conservative capability presets for strict schemas, parallel calls, developer messages, streaming tools, and vision.
- **`llm/toolRegistry.ts`**:
  - One typed registry. Every entry contains a schema, local parser, availability predicate, timeout, execution kind, executor, and literal `readOnly: true` classification.
- **[`llm/prompts.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/prompts.ts)**:
  - Defines the `DEFAULT_SYSTEM_PROMPT` containing guidelines for historical dates, scope checks, citations, and LLM tools.
  - Defines the schemas consumed by the registry. Retrieved Discord content is explicitly untrusted data and cannot override the built-in safety prompt.
- **[`llm/agent.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/agent.ts)**:
  - Enforces model-turn/tool/elapsed-time/record/token budgets, rejects duplicate normalized calls, validates arguments locally, and performs one tools-disabled finalization call.

### 4. Components (`/components`)
- **[`components/SidebarPanel.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/SidebarPanel.tsx)**:
  - The right-hand overlay. Hosts chats, session management, and settings references.
- **[`components/ChatMessage.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/ChatMessage.tsx)**:
  - Renders user/assistant dialogue, thought steps, expandable tool logs, and attachments.
- **[`components/MessagePreview.tsx`](file:///Users/raymond/Documents/projects/vencord-ai/components/MessagePreview.tsx)**:
  - Rich Discord citation preview card containing jump links (`discord://message/...`).

### 5. Storage (`/storage`)
- **[`storage/chatHistory.ts`](file:///Users/raymond/Documents/projects/vencord-ai/storage/chatHistory.ts)**:
  - Manages chat history sessions, saving sessions per channel in local IndexedDB.

---

## 🔒 Security & Privacy Boundaries
Privacy scoping is enforced at the code-level inside [`discord/scope.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/scope.ts#L215-L234):
1. **Server Channels**: Can only query channels the active user is allowed to access.
2. **DMs**: The active 1-on-1 DM is the default and the model cannot widen it automatically. A mutual group DM must be named in the prompt or supplied by a validated contextual launch.
3. If an LLM calls a tool on a channel outside these boundaries, `isChannelAllowedInScope` returns `false`, causing the tool call to fail or return an error boundary response.
4. Permission-store discovery and permission checks fail closed. Guild-wide search candidates are post-filtered against the accessible-channel allowlist before citation or model exposure.
5. There are no Discord mutation endpoints or tools in this plugin.

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
  # Runs every suite through test/run.ts
  ```

## Provider behavior

OpenAI enables strict schemas, parallel tool declarations, developer messages, and vision. Other presets opt into only explicitly known features; custom/unknown endpoints use conservative system-message and generic streaming compatibility. Every provider response is still locally validated.

## Search bounds

`limit` defaults from `searchLimitPerQuery` and caps at 50. `scan_limit` defaults to 100 and caps at 500. Exact dates are expanded at local midnight (including daylight-saving transitions), while message timestamps remain ISO. Guild-wide and channel-only cache keys are distinct.
