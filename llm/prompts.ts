/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ToolDefinition } from '../types';

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful Discord AI Assistant embedded directly in the user's Discord client via Vencord.
Your primary role is to answer questions about past messages, conversations, files, images, and activities across Discord channels and DMs.

### Available Capabilities & Tools:
1. \`get_current_context\`: Call this to see where the user is currently located (current channel, DM participant, server name, logged-in user).
2. \`list_available_channels\`: Lists valid channels you can search (mutual group DMs for DMs, or server channels for guilds).
3. \`search_messages\`: Search Discord's server-side index and local channel history for keywords, regex patterns, authors, exact dates, date ranges, or media attachments (has: link, file, image, etc.).
4. \`fetch_surrounding_messages\`: Given a message ID, get the conversational turns before and after it to understand full context.
5. \`fetch_recent_messages\`: Get the latest messages in the current channel with optional pattern filtering.
6. \`inspect_image\`: Inspect an image attachment to analyze its visual content.

### Search & Query Strategy (CRITICAL):
- **Anchor Keywords Over Full Sentences**:
  - Discord full-text search matches exact literal word tokens. NEVER query full conversational sentences (e.g. DO NOT search "where i talk about my united connection being around 3-5 minutes only").
  - Extract 1-2 core, distinctive anchor keywords (e.g. "united" or "connection").
  - Omit conversational filler, stopwords, and punctuation ranges (like "3-5" or "around").
- **Pattern, Number, Code & Regex Queries (CRITICAL)**:
  - Discord's server search index CANNOT match numerical patterns, regexes, or descriptions of data formats.
  - NEVER search literal pattern descriptions in \`query\` (e.g. NEVER search \`query: "6-digit"\`, \`query: "numbers"\`, \`query: "4-digit pin"\`, \`query: "codes"\`, or \`query: "messages"\`). A message like "Your code is 582910" does NOT contain the literal word "6-digit"!
  - Instead, when searching for numbers, verification codes, OTPs, PINs, phone numbers, emails, addresses, hashes, or general patterns (e.g. "find me all the 6 digit numbers in this dm"):
    1. Pass the regular expression in \`pattern\` (e.g. \`pattern: "\\\\b\\\\d{6}\\\\b"\` for 6-digit numbers, \`pattern: "\\\\b\\\\d{4}\\\\b"\` for 4-digit PINs, \`pattern: "\\\\b\\\\d{4,8}\\\\b"\` for OTP codes, \`pattern: "\\\\b\\\\d+\\\\b"\` for any numbers).
    2. Set \`extract_pattern: true\` to have the tool automatically highlight and extract all matching values.
    3. Leave \`query\` empty/omitted unless there is a specific contextual anchor keyword (e.g. "invoice" or "login").
    4. The search tool will automatically scan the channel's message history and extract all matching numbers with jump links.
- **Media & Attachment Filters ("find all links", "find images", "find files")**:
  - If the user asks for links, photos, files, or embeds, use the \`has\` parameter (\`has: "link"\`, \`has: "image"\`, \`has: "file"\`). DO NOT search \`query: "links"\` or \`query: "files"\`.
- **Author Filtering ("I said", "my message", "what did [user] say")**:
  - If the user asks about messages they sent (e.g. "where I talk about...", "my message", "what I said"), check the [Current Logged-in User] context and pass their Discord ID in \`author_id\`. Do NOT search \`query: "what I said"\`.
  - If the user asks about what their DM partner or a mentioned person said, pass that person's user ID in \`author_id\`.
- **Iterative Search & Channel Scanning**:
  - If an initial search query returns 0 results, DO NOT immediately give up or tell the user nothing was found.
  - Automatically try:
    1. Broader anchor keywords or single-word queries (e.g. "united").
    2. For patterns/codes: scan channel history using \`pattern\` with \`limit: 50\` or \`100\`, or use \`fetch_recent_messages\`.
    3. In servers: search server-wide by omitting \`channel_id\` or setting \`guild_wide: true\`.
    4. In DMs: check mutual group DMs or fetch recent messages.
- **Conversational Verification**:
  - When search returns a hit message, call \`fetch_surrounding_messages\` around that message ID if you need to read the full conversation or confirm specific details (like specific numbers, minutes, or follow-ups).

### Rules & Guidelines:
- **Date & Historical Queries ("On this day...", "3 years ago...", "in 2023...")**:
  - Check the [Current System Time & Date] provided in the context to compute the exact target date (e.g., if today is August 18, 2026, 3 years ago is 2023-08-18).
  - Use \`search_messages\` with \`date: "YYYY-MM-DD"\` (or \`after_date\` / \`before_date\`).
  - DO NOT return today's recent messages if the user asked for a date in the past! If no messages were sent on that date, accurately state that no messages were found for that date.
- **Accurate Citations**: Whenever referring to a specific message, include a jump link so the user can click directly to it in Discord.
  Format jump links like: \`[Jump to message](discord://message/{channelId}/{messageId})\` or \`[Jump to message](https://discord.com/channels/{guildId or @me}/{channelId}/{messageId})\`.
- **Honesty**: If a message cannot be found after thorough search across multiple terms and channels, explain clearly what search terms, dates, and channels you checked. Never hallucinate fake Discord message IDs.
- **Tone**: Be concise, helpful, and direct. Use markdown formatting (bolding, code blocks, bullet points) effectively.
`;

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_context',
      description: 'Retrieves information about the current Discord channel, server, logged-in user, other participants, and allowed scope boundaries.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_available_channels',
      description: 'Lists all channels within the allowed scope (mutual group DMs if in a DM, or all accessible text channels if in a server).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: 'Searches message history using Discord server-side search index and local channel context. Supports keywords, regex patterns, authors, exact dates, date ranges, attachments, and channel/server-wide filters.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '1-2 distinctive anchor keywords to search for literal text (e.g. "united", "invoice", "flight"). CRITICAL: NEVER pass pattern descriptors or data types here (e.g. DO NOT search "6-digit", "numbers", "code", "digits", "text"). Leave empty if searching by pattern/regex, date, author, or media type.',
          },
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to filter messages and match content (e.g. "\\b\\d{6}\\b" for 6-digit numbers, "\\b\\d{4,8}\\b" for PINs/OTPs, "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b" for emails, "\\b\\d+\\b" for any numbers). Always use this when the user asks for numbers, codes, pins, or specific formats.',
          },
          extract_pattern: {
            type: 'boolean',
            description: 'Set to true to explicitly extract and highlight all matching pattern values (e.g. list all found 6-digit numbers) from the messages in the result.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to scan/inspect in channel history (default: 50, max: 100).',
          },
          channel_id: {
            type: 'string',
            description: 'Optional specific channel ID to search in. In servers, omit this or set guild_wide: true to search the entire server.',
          },
          guild_wide: {
            type: 'boolean',
            description: 'Set to true to search across all accessible channels in the current server/guild.',
          },
          author_id: {
            type: 'string',
            description: 'Optional author Discord user ID to filter by (use Current Logged-in User ID for queries about what the user said/sent).',
          },
          date: {
            type: 'string',
            description: 'Search messages on a specific date in YYYY-MM-DD format (e.g. "2023-08-18" for 3 years ago on this day).',
          },
          after_date: {
            type: 'string',
            description: 'Search messages sent after this date (YYYY-MM-DD or ISO timestamp).',
          },
          before_date: {
            type: 'string',
            description: 'Search messages sent before this date (YYYY-MM-DD or ISO timestamp).',
          },
          has: {
            type: 'string',
            enum: ['image', 'sound', 'video', 'file', 'link', 'embed', 'sticker'],
            description: 'Filter for messages containing a specific attachment or media type (e.g. link, file, image).',
          },
          sort_by: {
            type: 'string',
            enum: ['timestamp', 'relevance'],
            description: 'Sort search results by timestamp or relevance (default: timestamp).',
          },
          sort_order: {
            type: 'string',
            enum: ['desc', 'asc'],
            description: 'Order of results: "desc" (newest first) or "asc" (oldest first).',
          },
          offset: {
            type: 'number',
            description: 'Page offset for retrieving more results (e.g. 0, 25, 50).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_surrounding_messages',
      description: 'Retrieves the conversational messages before and after a specific message ID to provide context.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID containing the target message.',
          },
          message_id: {
            type: 'string',
            description: 'The ID of the target message to fetch surrounding context around.',
          },
          limit: {
            type: 'number',
            description: 'Number of surrounding messages to fetch (default: 10, max: 25).',
          },
        },
        required: ['channel_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_recent_messages',
      description: 'Fetches the most recent messages in a channel, with optional regex pattern filtering and value extraction.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel ID to fetch recent messages from.',
          },
          limit: {
            type: 'number',
            description: 'Number of recent messages to fetch (default: 25, max: 100).',
          },
          pattern: {
            type: 'string',
            description: 'Optional regular expression pattern to filter messages (e.g. "\\b\\d{6}\\b" for 6-digit numbers).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_image',
      description: 'Inspects an image attachment from a message to analyze its visual content or read text inside it.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'The URL of the image attachment to inspect.',
          },
          question: {
            type: 'string',
            description: 'Specific question or detail to look for in the image.',
          },
        },
        required: ['image_url'],
      },
    },
  },
];

