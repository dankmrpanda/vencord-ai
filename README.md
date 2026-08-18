# Vencord AI Message Assistant Plugin 🤖✨

A powerful client-side AI assistant plugin for **Vencord**, **Vesktop**, and **Equicord** that allows you to ask questions about your Discord chat history (supporting **100k+ messages**), find attachments/images, and analyze conversations across channels and DMs.

Supports locally-hosted models (**omlx** on Apple Silicon, **Ollama**, **LM Studio**, **vLLM**) as well as cloud providers (**OpenAI**, **OpenRouter**, **Groq**).

---

## 🌟 Key Features

- 🔍 **Server-Side Message Search (100k+ Messages)**: Uses Discord's native search API through agentic tool calling to locate past messages, filter by authors, date ranges, and attachment types without crashing your client.
- 📜 **Context Reconstruction**: Automatically retrieves surrounding conversational turns around target messages to understand full conversational context.
- 🛡️ **Autonomous Scoping with Privacy Boundaries**:
  - **In Server Channels**: Restricted to channels in the active server you have permission to view.
  - **In DMs**: Strictly restricted to the current 1-on-1 DM and mutual group chats shared with that person.
- 🖥️ **Local & Cloud Model Support**:
  - **Local**: `omlx` (Apple Silicon MLX), `Ollama`, `LM Studio`, `vLLM` via OpenAI-compatible endpoints (`/v1/chat/completions`).
  - **Cloud**: OpenAI (`gpt-4o-mini`, `gpt-4o`), OpenRouter, Groq (`llama-3.1-70b`), etc.
- 🖼️ **Dynamic Multimodal / Vision**: On-demand image inspection tool allowing vision-capable models to read memes, diagrams, and screenshots.
- 📌 **Clickable Discord Jump Citations**: Referenced messages appear as rich preview cards with one-click jump buttons directly into your Discord chat stream.
- 💬 **Persistent Multi-Session History**: Conversations are saved per-channel in local storage / IndexedDB with session switching and new chat management.
- 🎨 **Native Discord UI**: Sleek right-hand dockable sidebar toggled via the `✨` button in Discord's header bar or `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS).

---

## 🚀 Installation

### Method 1: Vencord Userplugins Folder (Recommended)

1. Clone or copy this repository into your Vencord `src/userplugins` directory:
   ```bash
   cd /path/to/Vencord/src/userplugins
   git clone https://github.com/your-username/vencord-ai.git aiAssistant
   ```
2. Build Vencord:
   ```bash
   pnpm build
   ```
3. Open Discord / Vencord settings, navigate to **Plugins**, search for **AIAssistant**, and enable it.

### Method 2: Standalone Userplugin Symlink

If you already have Vencord or Vesktop installed:
```bash
ln -s /Users/raymond/Documents/projects/vencord-ai ~/.config/Vencord/src/userplugins/vencord-ai
```

---

## ⚙️ Model Setup & Presets

Open the plugin settings under **Discord Settings → Plugins → AIAssistant (Gear icon)**.

### 1. Local with `omlx` (Apple Silicon / Mac)
- **Preset**: `omlx (Local Apple Silicon / MLX)`
- **API Base URL**: `http://localhost:8000/v1`
- **Model**: `mlx-community/Qwen2.5-7B-Instruct-4bit` (or your loaded MLX model)
- **API Key**: *(leave blank)*

### 2. Local with `Ollama`
- **Preset**: `Ollama (Local)`
- **API Base URL**: `http://localhost:11434/v1`
- **Model**: `qwen2.5:7b` or `llama3.2:3b`
- **API Key**: *(leave blank)*

### 3. Cloud (OpenAI / OpenRouter / Groq)
- **Preset**: `OpenAI` / `OpenRouter` / `Groq`
- **API Key**: Enter your API key (`sk-...`)
- **Model**: `gpt-4o-mini`, `meta-llama/llama-3.1-8b-instruct`, etc.

Click **⚡ Test Connection** in the settings panel to verify your endpoint.

---

## 💡 Usage

1. Click the **`✨` icon** in the top-right Discord toolbar, or press **`Ctrl+Shift+A`** (**`Cmd+Shift+A`** on Mac).
2. The AI Assistant sidebar will open on the right side of your Discord window.
3. Ask questions in natural language:
   - *"What was the solution Alice mentioned for the database bug last week?"*
   - *"Find the screenshot of the error message Bob posted."*
   - *"Summarize what we discussed in this channel today."*
4. Click any **Jump ↗** citation card to navigate straight to the original message in Discord!

---

## 🛠️ Project Structure

```
vencord-ai/
├── src/
│   ├── index.tsx              # Plugin registration, header bar icon, keybinds
│   ├── types.ts               # Discord & AI Assistant TypeScript types
│   ├── settings.tsx           # Settings panel & provider presets
│   ├── discord/
│   │   ├── stores.ts          # Discord Webpack store finders & token access
│   │   ├── scope.ts           # Privacy boundaries & mutual GDM filters
│   │   ├── search.ts          # Rate-limited server-side message search API
│   │   └── messages.ts        # Surrounding message context & attachment helpers
│   ├── llm/
│   │   ├── provider.ts        # OpenAI-compatible streaming client
│   │   ├── agent.ts           # ReAct tool-calling agent loop
│   │   └── prompts.ts         # System instructions & function definitions
│   ├── storage/
│   │   └── chatHistory.ts     # Persistent IndexedDB multi-session store
│   └── components/
│       ├── SidebarPanel.tsx   # Dockable assistant drawer
│       ├── ChatMessage.tsx    # Message bubble with steps & citations
│       ├── ToolCallBadge.tsx  # Tool execution accordion
│       ├── MessagePreview.tsx # Message citation card with jump button
│       └── ScopeIndicator.tsx # Visual scope boundary badge
├── package.json
├── tsconfig.json
└── README.md
```

---

## 📄 License
MIT
