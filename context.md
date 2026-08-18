# Vencord AI - Developer Context & Architecture

This document is designed to help developer agents (and future models) quickly understand the purpose, architecture, and developer workflows of the `vencord-ai` project.

---

## 📌 Project Overview
`vencord-ai` is a client-side AI assistant plugin for Discord clients modded with Vencord, Vesktop, or Equicord. It integrates directly into the Discord client UI as a right-hand sidebar.
Using a ReAct tool-calling agent loop, the plugin allows users to query their Discord history, retrieve surrounding message context, inspect image attachments, and perform rate-limited searches on Discord's server-side indices (or local channels) while strictly enforcing security and privacy boundaries.

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
  - Limits queries. For servers, restricts searching to channels the user has permission to view (`PermissionStore`). For DMs, restricts to the current DM channel and mutual Group DMs.
- **[`discord/search.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/search.ts)**:
  - Handles queries sent to Discord's server-side Search API.
  - Respects Discord rate limits and formats results into clean datasets.
- **[`discord/messages.ts`](file:///Users/raymond/Documents/projects/vencord-ai/discord/messages.ts)**:
  - Fetches target messages and retrieves context (conversational turns before and after a specific message).

### 3. AI Agent Loop & Prompts (`/llm`)
- **[`llm/provider.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/provider.ts)**:
  - Wrapper for making OpenAI-compatible chat completion calls.
- **[`llm/prompts.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/prompts.ts)**:
  - Defines the `DEFAULT_SYSTEM_PROMPT` containing guidelines for historical dates, scope checks, citations, and LLM tools.
  - Defines `AGENT_TOOLS` definitions (`get_current_context`, `list_available_channels`, `search_messages`, `fetch_surrounding_messages`, `fetch_recent_messages`, `inspect_image`).
- **[`llm/agent.ts`](file:///Users/raymond/Documents/projects/vencord-ai/llm/agent.ts)**:
  - Implements the main ReAct loop. Executes tools, updates prompt context, handles chat completions, and generates user-friendly citations.

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
2. **DMs**: Only the active 1-on-1 DM channel or group chats shared with that recipient can be queried.
3. If an LLM calls a tool on a channel outside these boundaries, `isChannelAllowedInScope` returns `false`, causing the tool call to fail or return an error boundary response.

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
  # Runs the test suite via tsx: test/scope.test.ts & test/search.test.ts
  ```
